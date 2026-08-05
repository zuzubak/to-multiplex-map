"""Turn the dbt marts in DuckDB into static GeoJSON/JSON files for the map site.

Run after `dbt build` (from the dbt/ directory) so multiplex_permits, multiplex_by_ward
and stg_city_wards are up to date.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import duckdb

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "warehouse.duckdb"
SITE_DATA_DIR = Path(__file__).resolve().parent.parent / "site" / "data"


def build_permits_geojson(con: duckdb.DuckDBPyConnection) -> tuple[dict, int]:
    rows = con.execute(
        """
        select
            permit_num,
            status,
            structure_type,
            structure_category,
            permit_scope,
            exterior_visibility,
            road_class,
            proposed_use,
            description,
            dwelling_units_created,
            nullif(dwelling_units_lost, 0) as dwelling_units_lost,
            net_units_created,
            unit_bucket,
            full_address,
            ward,
            application_date,
            issued_date,
            completed_date,
            st_asgeojson(geom) as geometry_json
        from multiplex_permits
        where geom is not null
        """
    ).fetchall()
    columns = [d[0] for d in con.description]

    features = []
    for row in rows:
        record = dict(zip(columns, row))
        geometry = json.loads(record.pop("geometry_json"))
        for date_field in ("application_date", "issued_date", "completed_date"):
            if record.get(date_field) is not None:
                record[date_field] = str(record[date_field])
        features.append({"type": "Feature", "geometry": geometry, "properties": record})

    unmatched = con.execute(
        "select count(*) from multiplex_permits where geom is null"
    ).fetchone()[0]

    return {"type": "FeatureCollection", "features": features}, unmatched


def build_wards_geojson(con: duckdb.DuckDBPyConnection) -> dict:
    # Geometry + identifiers only -- per-ward counts are now computed client-side from
    # the currently-filtered permits.geojson, so every filter (layers, street/structure
    # type, date range) scopes the choropleth too, not just a fixed dbt-time total.
    rows = con.execute(
        """
        select
            ward_code,
            ward_name,
            st_asgeojson(geom) as geometry_json
        from stg_city_wards
        """
    ).fetchall()
    columns = [d[0] for d in con.description]

    features = []
    for row in rows:
        record = dict(zip(columns, row))
        geometry = json.loads(record.pop("geometry_json"))
        features.append({"type": "Feature", "geometry": geometry, "properties": record})

    return {"type": "FeatureCollection", "features": features}


def build_summary(con: duckdb.DuckDBPyConnection, unmatched: int) -> dict:
    totals = con.execute(
        """
        select
            status,
            count(*) as permit_count,
            sum(net_units_created) as net_units_created
        from multiplex_permits
        group by status
        """
    ).fetchall()

    date_range = con.execute(
        """
        select min(application_date), max(application_date)
        from multiplex_permits
        """
    ).fetchone()

    return {
        "last_updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "totals_by_status": [
            {"status": status, "permit_count": permit_count, "net_units_created": units}
            for status, permit_count, units in totals
        ],
        "unmatched_address_count": unmatched,
        "earliest_application_date": str(date_range[0]) if date_range[0] else None,
        "latest_application_date": str(date_range[1]) if date_range[1] else None,
    }


def main() -> None:
    SITE_DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB_PATH))
    con.execute("INSTALL spatial; LOAD spatial;")
    try:
        permits_geojson, unmatched = build_permits_geojson(con)
        wards_geojson = build_wards_geojson(con)
        summary = build_summary(con, unmatched)
    finally:
        con.close()

    (SITE_DATA_DIR / "permits.geojson").write_text(json.dumps(permits_geojson))
    (SITE_DATA_DIR / "wards.geojson").write_text(json.dumps(wards_geojson))
    (SITE_DATA_DIR / "summary.json").write_text(json.dumps(summary, indent=2))

    print(f"Wrote {len(permits_geojson['features'])} permit features "
          f"({unmatched} unmatched to an address dropped)")
    print(f"Wrote {len(wards_geojson['features'])} ward features")
    print(f"Summary: {summary}")


if __name__ == "__main__":
    main()
