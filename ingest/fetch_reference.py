"""Pull reference geospatial data (address points, ward boundaries, street classification)
into raw DuckDB tables.

These barely change day to day, but re-fetching them daily alongside the permits pull
keeps the pipeline simple (one script, no separate schedule) and costs little -- all are
narrowed to just the columns this project needs.

Source packages (CKAN):
  - address-points-municipal-toronto-one-address-repository -> raw_address_points
  - city-wards                                               -> raw_city_wards
  - toronto-centreline-tcl                                   -> raw_centreline
"""
from __future__ import annotations

from pathlib import Path

import duckdb
import pandas as pd

from ckan_client import datastore_search

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "warehouse.duckdb"

ADDRESS_POINTS_RESOURCE_ID = "0b3756af-9caf-4f0f-ac28-9c6617adede4"
CITY_WARDS_RESOURCE_ID = "7672dac5-b383-4d7c-90ec-291dc69d37bf"
CENTRELINE_RESOURCE_ID = "ad296ebf-fca6-4e67-b3ce-48040a20e6cd"

ADDRESS_POINT_COLUMNS = [
    "ADDRESS_POINT_ID",
    "ADDRESS_NUMBER",
    "LINEAR_NAME",
    "LINEAR_NAME_TYPE",
    "LINEAR_NAME_DIR",
    "WARD_NAME",
    "ADDRESS_FULL",
    "geometry",
]

CITY_WARD_COLUMNS = [
    "AREA_SHORT_CODE",
    "AREA_NAME",
    "DATE_EXPIRY",
    "geometry",
]

CENTRELINE_COLUMNS = [
    "LINEAR_NAME",
    "LINEAR_NAME_TYPE",
    "LINEAR_NAME_DIR",
    "FEATURE_CODE_DESC",
]


def fetch_table(con, resource_id: str, columns: list[str], table_name: str) -> int:
    records = datastore_search(resource_id, fields=columns)
    df = pd.DataFrame(records, columns=columns)
    con.execute(f"CREATE OR REPLACE TABLE {table_name} AS SELECT * FROM df")
    return len(df)


def main() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB_PATH))
    try:
        address_count = fetch_table(
            con, ADDRESS_POINTS_RESOURCE_ID, ADDRESS_POINT_COLUMNS, "raw_address_points"
        )
        print(f"raw_address_points: {address_count} rows")

        ward_count = fetch_table(
            con, CITY_WARDS_RESOURCE_ID, CITY_WARD_COLUMNS, "raw_city_wards"
        )
        print(f"raw_city_wards: {ward_count} rows")

        centreline_count = fetch_table(
            con, CENTRELINE_RESOURCE_ID, CENTRELINE_COLUMNS, "raw_centreline"
        )
        print(f"raw_centreline: {centreline_count} rows")
    finally:
        con.close()


if __name__ == "__main__":
    main()
