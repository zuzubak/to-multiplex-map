"""Classify permits by unit form and construction scope using Claude, caching
results as a dbt seed.

Two independent judgments per permit -- they used to be forced into a single
enum value (e.g. "basement_suite"), which conflated a structural fact (is the
extra unit a basement/secondary suite tucked into a house) with a scope-of-work
fact (was the building itself newly built or altered). Those are orthogonal: a
basement suite can be part of a brand-new house (123 Edgecroft Rd) just as
easily as a retrofit into an old one (11 Waterbridge Way), so a description
that mentions "basement" no longer forces an "alteration" conclusion.

- unit_form: basement_or_secondary_suite | standard -- structural, feeds
  structure_category in permits_with_units.sql.
- construction_type: feeds exterior_visibility (what's hidden by default).

Runs after ingest, before `dbt build`. Only calls the API for permits whose
(permit_num, description) combination isn't already in the seed cache -- so a
daily run only pays for that day's new or revised permits, not a full re-scan.
The regex-based classification in permits_with_units.sql is the fallback for
anything not in the cache (including every permit, on a run with no API key).

Population query mirrors the `filtered` CTE in permits_with_units.sql -- it
has to be re-expressed against the raw tables directly because this runs
before `dbt build` produces the staging models.
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
from pathlib import Path

import anthropic
import duckdb

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "warehouse.duckdb"
SEED_PATH = Path(__file__).resolve().parent.parent / "dbt" / "seeds" / "llm_permit_scope.csv"
SEED_FIELDNAMES = ["permit_num", "description_hash", "construction_type", "unit_form", "model"]

MODEL = "claude-haiku-4-5"
BATCH_SIZE = 20

UNIT_FORMS = ["basement_or_secondary_suite", "standard"]
CONSTRUCTION_TYPES = [
    "new_construction_teardown",
    "new_construction",
    "garden_suite",
    "conversion",
    "addition",
    "alteration",
    "severance",
    "unclear",
]

SYSTEM_PROMPT = """You are classifying City of Toronto building permits for a map that tracks new multiplex construction (duplexes through six-unit buildings). For each permit, read its own description and report two INDEPENDENT judgments:

1. unit_form -- is the extra unit specifically a basement suite, or an otherwise-unspecified "secondary/second suite" (one subordinate unit tucked into what is fundamentally still a single-family-scaled house)? Or is the structure a standard multi-unit form?
   - basement_or_secondary_suite: description identifies the extra unit as being in a basement, or as a "secondary suite"/"second suite"/"2nd unit"/"2nd dwelling unit" without specifying elsewhere -- a house with one accessory unit added, not a building designed as multiple peer units.
   - standard: everything else -- a true duplex/triplex/fourplex (built new or converted as such, with peer units, not one house plus one accessory suite), a laneway/garden suite, a larger multi-unit building, mixed use, etc.

2. construction_type -- what SCOPE of work does the description describe. This is independent of unit_form above: a basement suite can be added to a brand-new house just as easily as an old one, so do NOT let the word "basement" push you toward assuming this is an alteration to an existing building.
   - new_construction_teardown: an existing building is demolished/razed AND a new building is constructed in its place.
   - new_construction: a new building is constructed (new-build house/duplex/triplex/fourplex), no demolition mentioned or needed -- including when the description ALSO mentions a basement/secondary suite as one of the new building's units (e.g. "construct a new 2 storey SFD-detached dwelling" with a basement unit added by a later revision is still new_construction, not alteration).
   - garden_suite: a new garden suite / laneway suite (a new small detached structure in a rear yard), including converting an existing garage into one.
   - conversion: an EXISTING building's use is converted (e.g. "convert single family dwelling to duplex/triplex", "change of use") without demolition and without a specific addition or basement/secondary-suite framing.
   - addition: an addition/extension to an EXISTING house (front/rear/side addition, second/third storey addition, extend) that also adds a unit.
   - alteration: interior work inside an EXISTING structure that adds a unit, with no addition/extension and no broader conversion language -- this is the default reading for a plain basement/secondary suite proposal that gives no signal the building itself is new.
   - severance: the permit is about severing/splitting a lot rather than a building conversion.
   - unclear: the description doesn't give enough information to pick one of the above with any confidence (e.g. truncated text, revision notes with no real description, purely administrative language).

Rules:
- unit_form and construction_type are independent -- classify each on its own merits. A permit can be new_construction with unit_form=basement_or_secondary_suite (a brand-new house built with a basement apartment from the start), or alteration with unit_form=basement_or_secondary_suite (a basement suite retrofitted into an old house). Both are common; the word "basement" alone does not tell you which.
- The signal for new construction is language like "construct a new ... dwelling/house", "new construction", explicit demolition + rebuild, or a vacant lot. The signal for an EXISTING building is language that treats the house as already standing -- "existing", "add a unit to", or a basement/secondary suite proposal with no mention of building anything new.
- If demolition AND new construction are both mentioned, use new_construction_teardown even if it also uses words like "duplex".
- Garage-to-laneway-suite conversions (e.g. "second storey addition over an existing garage to create a laneway suite") are garden_suite -- the garage becomes a genuinely new, visibly different structure.
- A front/rear addition to the MAIN house (not a garage) that also adds a unit is "addition", not new_construction -- the original building remains standing.
- Descriptions are often truncated by the source data, contain typos, or use ALL CAPS -- classify based on whatever text is present; don't penalize for typos or truncation unless there's genuinely not enough information (then use unclear for construction_type).

Classify every permit given to you. Return exactly one unit_form and one construction_type per permit_num."""

POPULATION_QUERY = """
with permits as (
    select
        PERMIT_NUM as permit_num,
        REVISION_NUM as revision_num,
        STRUCTURE_TYPE as structure_type,
        STATUS as permit_status,
        DESCRIPTION as description,
        PROPOSED_USE as proposed_use,
        DWELLING_UNITS_CREATED as dwelling_units_created,
        'cleared' as source_status
    from raw_cleared_permits
    qualify row_number() over (
        partition by PERMIT_NUM order by try_cast(REVISION_NUM as integer) desc
    ) = 1
    union all
    select
        PERMIT_NUM as permit_num,
        REVISION_NUM as revision_num,
        STRUCTURE_TYPE as structure_type,
        STATUS as permit_status,
        DESCRIPTION as description,
        PROPOSED_USE as proposed_use,
        DWELLING_UNITS_CREATED as dwelling_units_created,
        'active' as source_status
    from raw_active_permits
    qualify row_number() over (
        partition by PERMIT_NUM order by try_cast(REVISION_NUM as integer) desc
    ) = 1
),
filtered as (
    select *
    from permits
    where
        dwelling_units_created is not null
        and trim(dwelling_units_created) != ''
        and try_cast(dwelling_units_created as integer) > 0
        and coalesce(structure_type, '') not like 'SFD%'
        and lower(coalesce(proposed_use, '')) not like '%sfd%'
        and lower(coalesce(proposed_use, '')) not like '%single%'
        and trim(coalesce(structure_type, '')) not in (
            'Office', 'Hospital', 'Restaurant 30 Seats or Less', 'Home for the Aged',
            'Motel/Hotel', 'Place of Worship', 'Apartment Hotel'
        )
        and (
            (source_status = 'cleared' and trim(coalesce(permit_status, '')) = 'Closed')
            or (
                source_status = 'active'
                and trim(coalesce(permit_status, '')) not in (
                    'Cancelled', 'Refused', 'Refusal Notice', 'Abandoned',
                    'Revocation Pending', 'Revocation Notice Sent', 'Pending Cancellation',
                    'Superseded'
                )
            )
        )
)
select distinct permit_num, description
from filtered
where description is not null and trim(description) != ''
"""

CLASSIFICATION_SCHEMA = {
    "type": "object",
    "properties": {
        "classifications": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "permit_num": {"type": "string"},
                    "unit_form": {"type": "string", "enum": UNIT_FORMS},
                    "construction_type": {"type": "string", "enum": CONSTRUCTION_TYPES},
                },
                "required": ["permit_num", "unit_form", "construction_type"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["classifications"],
    "additionalProperties": False,
}


def description_hash(description: str) -> str:
    return hashlib.md5(description.strip().encode("utf-8")).hexdigest()


def load_cache() -> dict[str, dict]:
    if not SEED_PATH.exists():
        return {}
    with SEED_PATH.open(newline="", encoding="utf-8") as f:
        return {row["permit_num"]: row for row in csv.DictReader(f)}


def write_cache(cache: dict[str, dict]) -> None:
    SEED_PATH.parent.mkdir(parents=True, exist_ok=True)
    with SEED_PATH.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=SEED_FIELDNAMES)
        writer.writeheader()
        for permit_num in sorted(cache):
            row = cache[permit_num]
            writer.writerow({k: row.get(k, "") for k in SEED_FIELDNAMES})


def classify_batch(client: anthropic.Anthropic, batch: list[tuple[str, str]]) -> dict[str, tuple[str, str]]:
    numbered = "\n".join(
        f"{i + 1}. permit_num={permit_num!r} description={description!r}"
        for i, (permit_num, description) in enumerate(batch)
    )
    response = client.messages.create(
        model=MODEL,
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        output_config={"format": {"type": "json_schema", "schema": CLASSIFICATION_SCHEMA}},
        messages=[{"role": "user", "content": numbered}],
    )
    text = next(b.text for b in response.content if b.type == "text")
    data = json.loads(text)
    return {c["permit_num"]: (c["unit_form"], c["construction_type"]) for c in data["classifications"]}


def main() -> None:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print(
            "ANTHROPIC_API_KEY not set -- skipping LLM classification "
            "(dbt falls back to regex-based classification for everything)."
        )
        return

    con = duckdb.connect(str(DB_PATH), read_only=True)
    try:
        population = con.execute(POPULATION_QUERY).fetchall()
    finally:
        con.close()

    cache = load_cache()
    to_classify = [
        (permit_num, description)
        for permit_num, description in population
        if cache.get(permit_num, {}).get("description_hash") != description_hash(description)
    ]

    print(f"{len(population)} permits in scope, {len(to_classify)} need (re)classification.")
    if not to_classify:
        return

    client = anthropic.Anthropic(api_key=api_key)
    classified = 0
    failed = 0
    for start in range(0, len(to_classify), BATCH_SIZE):
        batch = to_classify[start : start + BATCH_SIZE]
        try:
            results = classify_batch(client, batch)
        except Exception as exc:  # noqa: BLE001 -- keep the pipeline moving; regex covers the gap
            print(f"Batch starting at {start} failed ({exc}); leaving these to the regex fallback.")
            failed += len(batch)
            continue
        for permit_num, description in batch:
            result = results.get(permit_num)
            if result is None or result[0] not in UNIT_FORMS or result[1] not in CONSTRUCTION_TYPES:
                failed += 1
                continue
            unit_form, construction_type = result
            cache[permit_num] = {
                "permit_num": permit_num,
                "description_hash": description_hash(description),
                "construction_type": construction_type,
                "unit_form": unit_form,
                "model": MODEL,
            }
            classified += 1

    write_cache(cache)
    print(
        f"Classified {classified} permits via Claude ({failed} left for the regex fallback). "
        f"Cache now has {len(cache)} entries."
    )


if __name__ == "__main__":
    main()
