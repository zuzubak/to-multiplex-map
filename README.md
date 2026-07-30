# Toronto Multiplex Tracker

A near-real-time map of new multiplex construction in Toronto: duplexes through
fourplexes, secondary suites, and laneway/garden suites created by building permits
filed since 2022. Refreshed daily straight from the City of Toronto's Open Data API --
no static exports, no manual data drops.

This is the live successor to [`to-housing`](../to-housing), which was built on a
one-time static export that broke and couldn't be reproduced. This version pulls
directly from the City's CKAN API on every run.

## How it works

```
ingest/  -> pulls Building Permits (cleared + active) and reference geodata
            (address points, ward boundaries) from Toronto Open Data into DuckDB
dbt/     -> models the raw data into permit + ward-level marts (non-SFD filter,
            unit counts, geocoding join) -- DuckDB + the spatial extension
export/  -> turns the dbt marts into static GeoJSON/JSON for the map
site/    -> a MapLibre GL JS map that reads those files, published via GitHub Pages
```

A GitHub Actions workflow (`.github/workflows/refresh.yml`) runs this whole chain daily
and commits the refreshed `site/data/*` files, so GitHub Pages always serves the latest
snapshot.

## Data sources

All from `open.toronto.ca` (CKAN), refreshed daily on the City's side, no API key
required:

- [Building Permits - Cleared Permits](https://open.toronto.ca/dataset/building-permits-cleared-permits/) -- completed/closed permits
- [Building Permits - Active Permits](https://open.toronto.ca/dataset/building-permits-active-permits/) -- in-progress applications/permits
- [Address Points (Municipal)](https://open.toronto.ca/dataset/address-points-municipal-toronto-one-address-repository/) -- used to geocode permits and attach a ward
- [City Wards](https://open.toronto.ca/dataset/city-wards/) -- ward boundaries for the choropleth layer

Note: the CKAN `datastore_search_sql` action is blocked by the portal's WAF for
external callers, so ingestion uses the plain `datastore_search` action instead,
restricted to the columns this project needs.

## Filtering logic (ported from `to-housing`)

- A permit counts if it created dwelling units (`DWELLING_UNITS_CREATED > 0`) and its
  proposed use isn't a single-family detached home (`PROPOSED_USE` not like `%Sfd%` /
  `%Single%`).
- "Multiplex" scope is 1-4 net new units per permit (`dbt/models/marts/multiplex_permits.sql`),
  covering secondary suites through fourplexes. Each feature keeps its exact unit count
  (`unit_bucket`) so the map isn't lossy about it.
- Permits are geocoded by joining `STREET_NUM/NAME/TYPE/DIRECTION` against address
  points, same join key as the original repo's `new_units.sql`.

## Running locally

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python ingest/fetch_permits.py
python ingest/fetch_reference.py

cd dbt && dbt build --profiles-dir . && cd ..

python export/export_geojson.py

cd site && python -m http.server 8000
# open http://localhost:8000
```

## Deploying

Enable GitHub Pages for this repo (Settings -> Pages -> Deploy from branch -> `main` ->
`/site`), then either wait for the daily scheduled run or trigger
`.github/workflows/refresh.yml` manually (Actions tab -> Run workflow) to populate
`site/data/`.
