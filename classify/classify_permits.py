"""Classify permits by unit form and construction scope using Claude, caching
results as a dbt seed.

Two independent judgments per permit:

- unit_form: basement_or_secondary_suite | standard -- structural. Is the extra
  unit a subordinate suite tucked into a house, or is this a building of peer
  units? Feeds structure_category in permits_with_units.sql.

- construction_type: WHERE the new units come from. This is the map's main
  filter axis, and it replaced an older pair of overlapping fields
  (construction_type + exterior_visibility) that split the same judgment two
  ways and disagreed with each other. The values are chosen so that the two
  things people most want to exclude from a "multiplex" map -- a basement suite
  added to a house that already stood, and an accessory suite in the back yard
  -- are each a single filter chip:

    new_building          a whole new building, including demolish-and-rebuild
    laneway_garden_suite  a detached accessory suite in the rear yard
    basement_units        new unit(s) in the basement of a building already standing
    aboveground_units     new unit(s) above grade in a building already standing
    no_unit_change        the description describes no unit being created at all
    unclear               not enough text to tell

  basement_units deliberately cuts across what the building was before: adding a
  basement unit to a single-family house and adding one to an existing triplex
  are the same act, and the map should be able to hide both with one click.

  no_unit_change removes the permit from the map downstream, so it is reserved
  for descriptions that affirmatively describe work with no unit creation (a
  deck, a porch, a garage rebuild). Anything merely thin or truncated is
  unclear, not no_unit_change.

The permit's own WORK / CURRENT_USE / PROPOSED_USE fields are passed to the
model alongside the description. WORK in particular is the City's controlled
vocabulary for scope of work ('Second Suite (New)', 'New Laneway / Rear Yard
Suite', 'New Building', 'Interior Alterations'), filled in by the plans
examiner, and it disambiguates the single most common failure in prose: "propose
to construct a secondary unit in the basement" uses the word "construct" for
work that builds no new building.

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
    "new_building",
    "laneway_garden_suite",
    "basement_units",
    "aboveground_units",
    "no_unit_change",
    "unclear",
]

SYSTEM_PROMPT = """You are classifying City of Toronto building permits for a map that tracks new multiplex housing (duplexes through six-unit buildings). Each permit comes with its free-text DESCRIPTION plus three of the City's own coded fields: WORK (the plans examiner's scope-of-work category), CURRENT_USE (what was there before) and PROPOSED_USE (what is there after). Report two INDEPENDENT judgments per permit.

1. unit_form -- what FORM does the resulting housing take?
   - basement_or_secondary_suite: the added unit is a subordinate suite inside what remains fundamentally a single-family-scaled house -- a basement apartment, a "secondary suite"/"second suite"/"2nd unit"/"accessory dwelling unit", a converted attic or integral garage. One house plus one accessory unit, not a building of peer units.
   - standard: everything else -- a true duplex/triplex/fourplex of peer units (new-built or converted), a laneway/garden suite, a larger multi-unit building, mixed use.

2. construction_type -- WHERE do the new units come from? Pick exactly one:
   - new_building: a whole new building is constructed, including demolishing something first and rebuilding. This WINS over where the new building's units happen to sit: "construct a new 3 storey dwelling with a secondary suite in the basement" is new_building, not basement_units, because the building itself is new. A vacant lot is a strong signal.
   - laneway_garden_suite: a detached accessory dwelling in the rear yard -- "laneway suite", "garden suite", "rear yard suite" -- INCLUDING when it is made by converting or building above a detached garage ("convert existing garage into garden suite", "construct a garden suite above existing garage", "convert existing garage building into a laneway suite"). These are the map's most-often-mistaken permits: the City frequently codes the lot as "2 Unit - Detached" because the property ends up with two units, but the work is a back-yard accessory building, not a duplex. If the text says laneway/garden/rear-yard suite anywhere, this value wins over new_building.
   - basement_units: one or more new dwelling units are created in the BASEMENT (or "cellar", "lower level", "below grade") of a building that is already standing. This applies REGARDLESS of what the building was before -- adding a basement unit to a single-family house and adding one to an existing triplex are both basement_units. Typical: "interior alterations to create 2 additional units in the basement of the existing SFD", "convert the existing triplex to a fourplex by adding an additional dwelling unit in the basement", "renovate the existing basement into two new secondary units", "convert basement storage to dwelling unit (4th unit)". Note that "construct"/"construct a secondary unit" is routinely used for this kind of work and does NOT make it new_building.
   - aboveground_units: one or more new dwelling units are created ABOVE GRADE in a building that is already standing -- interior conversion of upper floors, a rear/side/second-storey addition that yields a unit, converting an INTEGRAL (attached, part of the house) garage into a unit, legalizing an existing above-grade unit. Use this when units are added to a standing building and the basement is not where they go.
   - no_unit_change: the description describes work that creates NO new dwelling unit -- a deck, porch, roof, underpinning, garage rebuild, window changes, a rear addition or second-storey addition that just makes existing rooms bigger, general renovation with no unit language. Examples that ARE no_unit_change: "Proposal to underpin basement, construct a rear one storey addition, second floor addition, replace existing detached garage and a new rear deck"; "PROPOSED INTERIOR ALTERATIONS + 2 STOREY REAR AND SIDE ADDITION WITH BASEMENT"; "interior alterations on the first floor and basement, second floor addition, and rebuild roof at front porch. Unit 1, Unit 2, Unit 3" (naming the units being worked in is not creating units). Choose this ONLY when the text affirmatively describes the scope and no unit is created by it. Do not choose it merely because the text is short or vague.
   - unclear: there isn't enough text to tell -- truncated fragments, bare revision notes ("REVISION 01", "Rev 02: revised deck plan"), purely administrative language. When you are torn between no_unit_change and unclear, choose unclear: no_unit_change removes the permit from the map, so it needs positive evidence.

Rules:
- The two axes are independent. A permit can be new_building with unit_form=basement_or_secondary_suite (a brand-new house built with a basement apartment) or basement_units with unit_form=basement_or_secondary_suite (that apartment retrofitted into an old house). The word "basement" alone does not tell you which -- look for whether a building is being BUILT.
- Precedence when several apply: laneway_garden_suite > new_building > basement_units > aboveground_units.
- Use WORK as strong evidence for scope. 'New Laneway / Rear Yard Suite' means laneway_garden_suite. 'Second Suite (New)', 'Interior Alterations' and 'Finishing Basements' mean the building already stands, so the answer is basement_units or aboveground_units, never new_building, no matter how much the description says "construct". 'New Building' means new_building unless the description clearly describes a rear-yard suite. 'Multiple Projects' and 'Other(SR)' carry no scope information -- judge those from the description alone.
- CURRENT_USE and PROPOSED_USE describe the before and after state. "Vacant" as CURRENT_USE points to new_building. A PROPOSED_USE like "Sfd + Garden Suite" or "Sfd-Detached/Laneway Suite" points to laneway_garden_suite. Note these fields are often stale (identical before and after even when units were created), so treat them as supporting evidence, not proof.
- Descriptions are frequently truncated, contain typos, or are in ALL CAPS. Classify from whatever text is present; don't penalize typos. Descriptions that stack revisions newest-first ("Revision 02 - ... Revision 01 - ... Proposal to ...") describe one permit's history: classify the overall scope of the permit, and where a revision explicitly supersedes the original scope, follow the revision.

Classify every permit given to you. Return exactly one unit_form and one construction_type per permit_num."""

POPULATION_QUERY = """
with permits as (
    select
        PERMIT_NUM as permit_num,
        STRUCTURE_TYPE as structure_type,
        WORK as work,
        STATUS as permit_status,
        DESCRIPTION as description,
        CURRENT_USE as current_use,
        PROPOSED_USE as proposed_use,
        DWELLING_UNITS_CREATED as dwelling_units_created,
        'cleared' as source_status
    from raw_cleared_permits
    qualify row_number() over (
        partition by PERMIT_NUM
        order by
            try_cast(REVISION_NUM as integer) desc nulls last,
            case when DWELLING_UNITS_CREATED is null then 1 else 0 end,
            case when STRUCTURE_TYPE is null then 1 else 0 end,
            REVISION_NUM desc
    ) = 1
    union all
    select
        PERMIT_NUM as permit_num,
        STRUCTURE_TYPE as structure_type,
        WORK as work,
        STATUS as permit_status,
        DESCRIPTION as description,
        CURRENT_USE as current_use,
        PROPOSED_USE as proposed_use,
        DWELLING_UNITS_CREATED as dwelling_units_created,
        'active' as source_status
    from raw_active_permits
    qualify row_number() over (
        partition by PERMIT_NUM
        order by
            try_cast(REVISION_NUM as integer) desc nulls last,
            case when DWELLING_UNITS_CREATED is null then 1 else 0 end,
            case when STRUCTURE_TYPE is null then 1 else 0 end,
            REVISION_NUM desc
    ) = 1
),
filtered as (
    select *
    from permits
    where
        dwelling_units_created is not null
        and trim(dwelling_units_created) != ''
        and try_cast(dwelling_units_created as integer) > 0
        and (
            coalesce(structure_type, '') not like 'SFD%'
            or trim(coalesce(work, '')) in (
                'Second Suite (New)', 'New Laneway / Rear Yard Suite'
            )
        )
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
-- One row per permit_num: the cache is keyed on permit_num alone, so a permit that
-- appears in both the cleared and active sources must not produce two rows here (the
-- second would overwrite the first and be re-classified on every run, forever).
select permit_num, description, work, current_use, proposed_use
from filtered
where description is not null and trim(description) != ''
qualify row_number() over (
    partition by permit_num order by source_status
) = 1
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


def format_permit(index: int, row: tuple) -> str:
    permit_num, description, work, current_use, proposed_use = row
    return (
        f"{index}. permit_num={permit_num!r}\n"
        f"   WORK={work or '(none)'!r} "
        f"CURRENT_USE={current_use or '(none)'!r} PROPOSED_USE={proposed_use or '(none)'!r}\n"
        f"   DESCRIPTION={description!r}"
    )


def classify_batch(client: anthropic.Anthropic, batch: list[tuple]) -> dict[str, tuple[str, str]]:
    numbered = "\n".join(format_permit(i + 1, row) for i, row in enumerate(batch))
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
        row for row in population
        if cache.get(row[0], {}).get("description_hash") != description_hash(row[1])
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
        for row in batch:
            permit_num, description = row[0], row[1]
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
