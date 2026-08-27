"""Score the classifier against the hand-labelled permits in test_cases.csv.

Two things get checked, because the pipeline has two classifiers:

  --regex  reads construction_type straight out of permits_with_units in the warehouse.
           Whatever is in the table is what the run produced -- so with an empty seed
           this scores the regex fallback, and after a classify run it scores the LLM's
           results as they actually land in the mart. Needs `dbt build` to have run.
  --llm    calls the model directly with the real SYSTEM_PROMPT, bypassing the seed
           cache, so a prompt edit can be scored without a full re-classify.
           Needs ANTHROPIC_API_KEY.

Default runs whichever are available. Exit status is non-zero if anything regressed,
so this is usable as a pre-commit check on prompt changes.
"""
from __future__ import annotations

import csv
import os
import sys
from pathlib import Path

import duckdb

from classify_permits import (
    DB_PATH,
    MODEL,
    classify_batch,
    CONSTRUCTION_TYPES,
)

CASES_PATH = Path(__file__).resolve().parent / "test_cases.csv"


def load_cases() -> list[dict]:
    with CASES_PATH.open(newline="", encoding="utf-8") as f:
        rows = [ln for ln in f if not ln.lstrip().startswith("#")]
    return list(csv.DictReader(rows))


def fetch_permits(cases: list[dict]) -> dict[str, dict]:
    """Pull each case's description + coded fields out of the warehouse."""
    con = duckdb.connect(str(DB_PATH), read_only=True)
    try:
        nums = [c["permit_num"] for c in cases]
        placeholders = ",".join("?" * len(nums))
        rows = con.execute(
            f"""
            select permit_num, description, work, current_use, proposed_use,
                   construction_type, structure_category
            from permits_with_units
            where permit_num in ({placeholders})
            """,
            nums,
        ).fetchall()
    finally:
        con.close()
    cols = ["permit_num", "description", "work", "current_use", "proposed_use",
            "construction_type", "structure_category"]
    return {r[0]: dict(zip(cols, r)) for r in rows}


def report(title: str, results: list[tuple[str, str, str, str, bool]]) -> int:
    print(f"\n=== {title} ===")
    width = max(len(r[0]) for r in results)
    failures = 0
    for address, expected, got, extra, ok in results:
        if not ok:
            failures += 1
        mark = "ok  " if ok else "FAIL"
        print(f"  {mark} {address:{width}s}  expected {expected:20s} got {got:20s} {extra}")
    print(f"  {len(results) - failures}/{len(results)} correct")
    return failures


def check_warehouse(cases: list[dict], permits: dict[str, dict]) -> int:
    results = []
    for case in cases:
        row = permits.get(case["permit_num"])
        if row is None:
            results.append((case["address"], case["expect_regex"], "NOT IN MART", "", False))
            continue
        got = row["construction_type"]
        # The mart is scored against expect_regex when no LLM result is in play; a permit
        # classified by the LLM should meet the stricter expect_construction_type.
        expected = case["expect_regex"]
        results.append((case["address"], expected, got, f"[{row['structure_category']}]", got == expected))
    return report("warehouse (permits_with_units.construction_type)", results)


def check_llm(cases: list[dict], permits: dict[str, dict]) -> int:
    import anthropic

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    batch = []
    for case in cases:
        row = permits.get(case["permit_num"])
        if row is None:
            continue
        batch.append((row["permit_num"], row["description"], row["work"],
                      row["current_use"], row["proposed_use"]))

    got = classify_batch(client, batch)
    results = []
    for case in cases:
        row = permits.get(case["permit_num"])
        if row is None:
            results.append((case["address"], case["expect_construction_type"], "NOT IN MART", "", False))
            continue
        result = got.get(case["permit_num"])
        if result is None:
            results.append((case["address"], case["expect_construction_type"], "NO RESULT", "", False))
            continue
        unit_form, construction_type = result
        expected = case["expect_construction_type"]
        results.append((case["address"], expected, construction_type,
                        f"[unit_form={unit_form}]", construction_type == expected))
    return report(f"LLM ({MODEL}, live prompt)", results)


def main() -> None:
    args = set(sys.argv[1:])
    want_regex = "--llm" not in args
    want_llm = "--regex" not in args

    cases = load_cases()
    for case in cases:
        assert case["expect_construction_type"] in CONSTRUCTION_TYPES, case
        assert case["expect_regex"] in CONSTRUCTION_TYPES, case

    if not DB_PATH.exists():
        sys.exit(f"{DB_PATH} not found -- run the ingest + `dbt build` first.")
    permits = fetch_permits(cases)

    failures = 0
    if want_regex:
        failures += check_warehouse(cases, permits)
    if want_llm:
        if os.environ.get("ANTHROPIC_API_KEY"):
            failures += check_llm(cases, permits)
        else:
            print("\n=== LLM === skipped (ANTHROPIC_API_KEY not set)")

    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
