"""Classify permits by construction scope using Claude, caching results as a dbt seed.

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
SEED_FIELDNAMES = ["permit_num", "description_hash", "permit_scope", "exterior_visibility", "model"]

MODEL = "claude-haiku-4-5"
BATCH_SIZE = 20

SCOPE_TO_VISIBILITY = {
    "new_construction_teardown": "new_construction",
    "new_construction": "new_construction",
    "garden_suite": "new_construction",
    "conversion_no_demo": "conversion",
    "addition": "conversion",
    "severance": "conversion",
    "basement_suite": "interior_only",
    "secondary_suite": "interior_only",
    "interior_alteration": "interior_only",
    "unclear": "unclear",
}

SYSTEM_PROMPT = """You are classifying City of Toronto building permits by what work they actually describe, for a map that tracks new multiplex construction (duplexes through six-unit buildings).

The map's structure_type field only tells you the resulting unit count -- it does NOT distinguish a genuine new-build duplex from a basement suite added to an existing house (both count as "2 unit"). Your job is to read each permit's own description and classify the SCOPE of work into exactly one of:

- new_construction_teardown: description says an existing building is demolished/razed AND a new building (duplex/triplex/fourplex/houseplex) is constructed in its place.
- new_construction: a new building is constructed (new-build duplex/triplex/fourplex, or a new laneway/garden suite), with no demolition mentioned or needed (e.g. built on a vacant lot, or a new structure like a laneway suite added to a lot with an existing untouched house).
- garden_suite: same as new_construction but specifically a garden suite / laneway suite (a new small detached structure in a rear yard).
- basement_suite: the description explicitly mentions a basement -- a suite/unit/apartment added in the basement of an existing house. No new building.
- secondary_suite: description mentions a "secondary suite" or "second unit"/"2nd unit" without saying where (could be basement, could be elsewhere in the house) -- interior work inside an existing house, not visible from outside.
- interior_alteration: interior renovation/alteration language, adding a unit inside an existing structure, with no other category above matching.
- conversion_no_demo: existing building's use is converted (e.g. "convert single family dwelling to duplex/triplex/fourplex", "change of use") without demolition. The building itself is not torn down, but the description doesn't specifically point to a basement/secondary suite -- this is a broader existing-envelope conversion, often the whole house.
- addition: an addition/extension to an existing house (front addition, rear addition, second/third storey addition, extend) that also adds a unit. Not a full new building.
- severance: the permit is about severing/splitting a lot rather than a building conversion.
- unclear: the description doesn't give enough information to pick one of the above with any confidence (e.g. truncated text, revision notes with no real description, purely administrative language).

Rules:
- If demolition AND new construction are both mentioned, use new_construction_teardown even if it also uses words like "duplex".
- If "basement" appears anywhere describing where the new unit/suite is, use basement_suite even if "secondary suite" is also mentioned -- basement_suite is more specific and wins.
- Garage-to-laneway-suite conversions (e.g. "second storey addition over an existing garage to create a laneway suite") count as garden_suite/new_construction -- the garage becomes a genuinely new, visibly different structure, not an interior alteration to the main house.
- A front/rear addition to the MAIN house (not a garage) that also adds a unit is "addition", not new_construction -- the original building remains standing.
- Descriptions are often truncated by the source data, contain typos, or use ALL CAPS -- classify based on whatever text is present; don't penalize for typos or truncation unless there's genuinely not enough information (then use unclear).

Classify every permit given to you. Return exactly one classification per permit_num."""

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
                    "scope": {"type": "string", "enum": list(SCOPE_TO_VISIBILITY.keys())},
                },
                "required": ["permit_num", "scope"],
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


def classify_batch(client: anthropic.Anthropic, batch: list[tuple[str, str]]) -> dict[str, str]:
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
    return {c["permit_num"]: c["scope"] for c in data["classifications"]}


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
            scope = results.get(permit_num)
            if scope not in SCOPE_TO_VISIBILITY:
                failed += 1
                continue
            cache[permit_num] = {
                "permit_num": permit_num,
                "description_hash": description_hash(description),
                "permit_scope": scope,
                "exterior_visibility": SCOPE_TO_VISIBILITY[scope],
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
