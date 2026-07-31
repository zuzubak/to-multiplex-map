-- Port of the old repo's gentle_density.sql: permits creating 1-4 *net* new dwelling
-- units (secondary suites through fourplexes) -- net_units_created already accounts for
-- dwelling_units_lost, so a straight teardown-rebuild that neither the source data's own
-- lost-units figure nor a net-zero permit won't show up here. unit_bucket is kept as an
-- explicit column so the map can filter/color by exact unit count instead of only having
-- a single collapsed threshold.
select
    *,
    case
        when net_units_created >= 4 then '4+'
        else cast(net_units_created as varchar)
    end as unit_bucket
from {{ ref('permits_with_units') }}
where net_units_created > 0 and net_units_created < 5
