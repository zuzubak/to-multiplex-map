# Toronto Multiplex Tracker

A near-real-time map of new multiplex construction in Toronto: duplexes through
six-plexes, secondary suites, and laneway/garden suites created by building permits
filed since 2022. Refreshed daily straight from the City of Toronto's Open Data API --
no static exports, no manual data drops.

This is the live successor to [`to-housing`](../to-housing), which was built on a
one-time static export that broke and couldn't be reproduced. This version pulls
directly from the City's CKAN API on every run.

## How it works

```
ingest/    -> pulls Building Permits (cleared + active) and reference geodata
              (address points, ward boundaries) from Toronto Open Data into DuckDB
classify/  -> classifies new/changed permits by construction scope with Claude,
              caching results as a dbt seed (dbt/seeds/llm_permit_scope.csv)
dbt/       -> models the raw data into permit + ward-level marts (non-SFD filter,
              unit counts, geocoding join, LLM + regex scope classification)
export/    -> turns the dbt marts into static GeoJSON/JSON for the map
site/      -> a MapLibre GL JS map that reads those files, published via GitHub Pages
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
- "Multiplex" scope is 1-6 net new units per permit (`dbt/models/marts/multiplex_permits.sql`),
  covering secondary suites through six-plexes -- the cap matches Toronto's 2024 "Expanding
  Housing Options" zoning update, which extended as-of-right multiplex permissions from 4
  units up to 6 on larger lots. Each feature keeps its exact unit count (`unit_bucket`) so
  the map isn't lossy about it.
- Permits are geocoded by joining `STREET_NUM/NAME/TYPE/DIRECTION` against address
  points, same join key as the original repo's `new_units.sql`.
- `STRUCTURE_TYPE` only encodes the resulting unit count/form, not the scope of work --
  `2 Unit - Detached` covers both a genuine new-build duplex and a basement suite legalized
  inside an existing house. `permits_with_units.sql` classifies each permit's own
  `DESCRIPTION` field into two INDEPENDENT axes -- they used to be a single conflated value,
  which was wrong: a basement suite can be part of a brand-new house just as easily as a
  retrofit into an old one, so "mentions a basement" doesn't imply "nothing new was built."
  - `unit_form` (`basement_or_secondary_suite` / `standard`) -- is the extra unit a
    basement/secondary suite tucked into an otherwise single-family-scaled house, as opposed
    to a true duplex/triplex/laneway-suite form? Feeds `structure_category`: a "2 Unit"
    permit with `basement_or_secondary_suite` shows as "House + secondary suite" rather than
    "Duplex (2 units)".
  - `construction_type` / `exterior_visibility` (`new_construction` / `conversion` /
    `interior_only` / `unclear`) -- was the building itself newly built or altered? Based on
    a manual audit that found ~65% of citywide multiplex-scale permits -- and a higher share
    on minor streets in outlying wards -- were basement/secondary suites or interior-only
    work on an *existing* house, not new buildings. The map's "Construction type" filter
    hides `interior_only` by default for this reason -- but a basement suite built as part of
    a brand-new house (e.g. a new SFD with a legal basement unit added by revision) is
    correctly `new_construction`, not hidden.
- Both fields come from `classify/classify_permits.py` (Claude Haiku, structured JSON
  output), not a regex -- descriptions are messy free text (typos, ALL CAPS, truncation,
  ambiguous phrasing) and a regex heuristic mis-sorted a meaningful share of edge cases.
  Results are cached in `dbt/seeds/llm_permit_scope.csv`, keyed by permit number + a hash of
  the description, so each daily run only pays to classify permits that are new or whose
  description changed -- not the whole dataset. `permits_with_units.sql` still carries the
  original regex as a fallback, used for any permit not yet in the cache (including every
  permit, on a run with no `ANTHROPIC_API_KEY` set -- e.g. local dev).

## Running locally

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python ingest/fetch_permits.py
python ingest/fetch_reference.py

# Optional -- classifies new/changed permits with Claude, caching into
# dbt/seeds/llm_permit_scope.csv. Skips gracefully (falls back to the regex
# classifier) if ANTHROPIC_API_KEY isn't set.
export ANTHROPIC_API_KEY=sk-ant-...
python classify/classify_permits.py

cd dbt && dbt build --profiles-dir . && cd ..

python export/export_geojson.py

cp site/config.example.js site/config.js   # then paste your CARTO key into it
cd site && python -m http.server 8000
# open http://localhost:8000
```

### Basemap key

CARTO gates its basemap tiles behind an API key. `site/config.js` holds it and is
gitignored; the deploy job writes its own copy from the `CARTO_API_KEY` repo secret
(Settings -> Secrets and variables -> Actions). Without a key the map falls back to
CARTO's legacy keyless endpoint, which still works but is on its way out.

The key is a client-side key -- it ships in the page to every visitor, and no build
setup changes that. Treat it as public and lock it down by domain in the CARTO
dashboard instead.

## Deploying

Enable GitHub Pages for this repo (Settings -> Pages -> Deploy from branch -> `main` ->
`/site`), then either wait for the daily scheduled run or trigger
`.github/workflows/refresh.yml` manually (Actions tab -> Run workflow) to populate
`site/data/`.

The site is served at `https://malcolmkennedy.com/to-multiplex-map/`. That URL is
hardcoded in two places and must be kept in sync if the domain or path ever changes:
the `<link rel="canonical">` / Open Graph / JSON-LD block in `site/index.html`, and
`SITE_URL` in `export/export_geojson.py` (which regenerates `site/sitemap.xml` with a
fresh `lastmod` on every run). `robots.txt` has to live at the domain root, so it
belongs in the repo that serves `malcolmkennedy.com`, not this one.

Add `ANTHROPIC_API_KEY` as a repo secret (Settings -> Secrets and variables -> Actions ->
New repository secret) to enable Claude-based classification in the daily refresh. Without
it, the `classify` step no-ops and everything falls back to the regex classifier.
