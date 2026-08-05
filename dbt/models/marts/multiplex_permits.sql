-- Port of the old repo's gentle_density.sql: permits creating 1-6 *net* new dwelling
-- units (secondary suites through six-plexes) -- net_units_created already accounts for
-- dwelling_units_lost, so a straight teardown-rebuild that neither the source data's own
-- lost-units figure nor a net-zero permit won't show up here. Cap is 6, not 4, matching
-- Toronto's 2024 "Expanding Housing Options" zoning update, which extended as-of-right
-- multiplex permissions from 4 units up to 6 on larger lots. unit_bucket is kept as an
-- explicit column so the map can filter/color by exact unit count instead of only having
-- a single collapsed threshold.
select
    *,
    case
        when net_units_created >= 6 then '6+'
        else cast(net_units_created as varchar)
    end as unit_bucket
from {{ ref('permits_with_units') }}
where net_units_created > 0 and net_units_created < 7
