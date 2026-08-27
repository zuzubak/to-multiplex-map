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
  `STRUCTURE_TYPE` isn't a single-family detached home (`not like 'SFD%'`), with one
  exception: a permit whose `WORK` is explicitly `Second Suite (New)` or
  `New Laneway / Rear Yard Suite` is kept even under an `SFD` structure type, because a
  few dozen genuine suite permits carry an un-updated one.
- There is deliberately **no** filter on `PROPOSED_USE`. There used to be (`not like
  '%Sfd%'` / `'%Single%'`) and it was a substring bug that silently dropped **1,505
  genuine multiplex permits** -- a ~32% undercount. The City writes the *resulting* use of
  an accessory-unit permit as `Sfd + Garden Suite`, `Sfd-Detached/Laneway Suite`,
  `2 Unit Sfd` or `Single Family + Laneway Suite`, so matching the substring "sfd" threw
  out 745 permits whose structure type was `Laneway / Rear Yard Suite` and 550 whose
  structure type was `2 Unit - Detached`. `STRUCTURE_TYPE` already does this job correctly.
- "Multiplex" scope is 1-6 units created per permit
  (`dbt/models/marts/multiplex_permits.sql`), covering secondary suites through
  six-plexes -- the cap matches Toronto's 2024 "Expanding Housing Options" zoning update,
  which extended as-of-right multiplex permissions from 4 units up to 6 on larger lots.
- **Unit counts are gross, not net.** `DWELLING_UNITS_LOST` is 0 on 11,749 of the 11,761
  unit-creating permits the City publishes -- it simply isn't populated. The old
  `net_units_created` / `dwelling_units_lost` / `unit_bucket` columns have been removed
  rather than left around looking authoritative: "net" was always just a copy of the gross
  figure, and the claim that it accounted for teardown-rebuilds was false. A permit that
  demolishes a house and builds a fourplex counts as 4 here, not 3;
  `construction_type = 'new_building'` is the honest signal for that.
- Permits are geocoded by `GEO_ID` against address points, falling back to a
  `STREET_NUM/NAME/TYPE/DIRECTION` join.

## Classification

`STRUCTURE_TYPE` records how many units *result*, not how much got built -- `2 Unit -
Detached` covers a ground-up duplex, a basement apartment legalized inside an existing
house, and a garden suite behind one. (It is reliably the **ending** state, not the
starting one: on permits where `CURRENT_USE` and `PROPOSED_USE` disagree it matches the
proposed value 4,850 times against 154 for the current value. Its real weakness is
staleness -- 34% of unit-creating permits have `CURRENT_USE == PROPOSED_USE` despite
creating units.) So each permit is classified on two INDEPENDENT axes from its own
`DESCRIPTION`, plus the City's coded `WORK` / `CURRENT_USE` / `PROPOSED_USE` fields:

- `unit_form` (`basement_or_secondary_suite` / `standard`) -- is the added unit a
  subordinate suite tucked into an otherwise single-family-scaled house, as opposed to a
  building of peer units? Feeds `structure_category`: a "2 Unit" permit with
  `basement_or_secondary_suite` shows as "House + secondary suite", not "Duplex (2 units)".
- `construction_type` -- **where the new units come from**. This replaced an older pair of
  overlapping fields (`construction_type` + `exterior_visibility`) that split the same
  judgment two ways and disagreed with each other:
  - `new_building` -- a whole new building, including demolish-and-rebuild. Wins over
    where the new building's units sit: a new house with a basement suite designed in is
    `new_building`, not `basement_units`.
  - `laneway_garden_suite` -- a detached accessory dwelling in the rear yard, including
    garage conversions. Detected from the description, **not** `STRUCTURE_TYPE`: the City
    codes a meaningful minority of these as `2 Unit - Detached` (the lot does end up with
    two units), which used to make "Proposal to construct a garden suite above existing
    garage" render as "Duplex (2 units)".
  - `basement_units` -- new unit(s) in the basement of a building already standing.
    Deliberately cuts across what the building was before: adding a basement unit to a
    single-family house and adding one to an existing triplex are the same act. Hidden by
    default on the map -- it's the most common permit and the least visible change.
  - `aboveground_units` -- new unit(s) above grade in a building already standing
    (interior conversion, addition, integral-garage conversion). Collapses what used to be
    three separate values.
  - `no_unit_change` -- the description describes no unit being created (a deck, a porch,
    a garage rebuild). **Excluded from the map entirely**, even where the City's own unit
    count says otherwise. Only the LLM assigns this; the regex fallback never does, so a
    run without an API key drops nothing.
  - `unclear` -- not enough text to tell. Kept, filterable, off by default.
- Both fields come from `classify/classify_permits.py` (Claude Haiku, structured JSON
  output), not a regex -- descriptions are messy free text (typos, ALL CAPS, truncation,
  ambiguous phrasing) and a regex heuristic mis-sorts a meaningful share of edge cases.
  The permit's `WORK` field is passed to the model as context: it's the City's controlled
  vocabulary for scope of work, filled in by the plans examiner, and it disambiguates the
  most common failure in prose -- "propose to construct a secondary unit in the basement"
  uses the word "construct" for work that builds no new building.
  Results are cached in `dbt/seeds/llm_permit_scope.csv`, keyed by permit number + a hash
  of the description, so each daily run only pays to classify permits that are new or
  whose description changed. `permits_with_units.sql` carries a regex fallback used for
  any permit not yet in the cache (including every permit, on a run with no
  `ANTHROPIC_API_KEY` -- e.g. local dev).
- `classify/test_cases.csv` holds hand-labelled permits from a manual audit of the live
  map, each one a case the old taxonomy got visibly wrong. Score both classifiers against
  them with `python classify/check_test_cases.py` (needs `dbt build` to have run; the LLM
  half needs `ANTHROPIC_API_KEY`). It exits non-zero on a regression, so it's usable as a
  check on prompt edits.

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
