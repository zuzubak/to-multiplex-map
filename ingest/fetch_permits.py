"""Pull Building Permits (cleared + active) from Toronto Open Data into raw DuckDB tables.

Source packages (CKAN, refreshed daily by Toronto Building):
  - building-permits-cleared-permits  -> raw_cleared_permits
  - building-permits-active-permits   -> raw_active_permits

Business-logic filtering (non-SFD, dwelling units created, etc.) happens downstream in
dbt -- this script only narrows by application date to keep the daily pull small, since
we only care about permits filed since the multiplex/fourplex zoning changes.
"""
from __future__ import annotations

from pathlib import Path

import duckdb
import pandas as pd

from ckan_client import datastore_search

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "warehouse.duckdb"

CLEARED_RESOURCE_ID = "a96c0ba4-3026-402b-b09d-5b1268b8f810"
ACTIVE_RESOURCE_ID = "6d0229af-bc54-46de-9c2b-26759b01dd05"
MIN_APPLICATION_DATE = "2022-01-01"

PERMIT_COLUMNS = [
    "PERMIT_NUM",
    "REVISION_NUM",
    "PERMIT_TYPE",
    "STRUCTURE_TYPE",
    "WORK",
    "STREET_NUM",
    "STREET_NAME",
    "STREET_TYPE",
    "STREET_DIRECTION",
    # GEO_ID is the Address Points dataset's ADDRESS_POINT_ID -- the precise geocoding key,
    # preferred over matching on the street-name columns above (see permits_with_units.sql).
    "GEO_ID",
    "APPLICATION_DATE",
    "ISSUED_DATE",
    "COMPLETED_DATE",
    "STATUS",
    "DESCRIPTION",
    "CURRENT_USE",
    "PROPOSED_USE",
    "DWELLING_UNITS_CREATED",
    "DWELLING_UNITS_LOST",
    "RESIDENTIAL",
]


def fetch_table(con: duckdb.DuckDBPyConnection, resource_id: str, table_name: str) -> int:
    records = datastore_search(resource_id, fields=PERMIT_COLUMNS)
    df = pd.DataFrame(records, columns=PERMIT_COLUMNS)
    # CKAN's datastore_search_sql (which would let us filter server-side) is blocked by
    # the portal's WAF for external callers, so narrow by application date here instead.
    df = df[df["APPLICATION_DATE"] >= MIN_APPLICATION_DATE]
    con.execute(f"CREATE OR REPLACE TABLE {table_name} AS SELECT * FROM df")
    return len(df)


def main() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB_PATH))
    try:
        cleared_count = fetch_table(con, CLEARED_RESOURCE_ID, "raw_cleared_permits")
        print(f"raw_cleared_permits: {cleared_count} rows")

        active_count = fetch_table(con, ACTIVE_RESOURCE_ID, "raw_active_permits")
        print(f"raw_active_permits: {active_count} rows")
    finally:
        con.close()


if __name__ == "__main__":
    main()
