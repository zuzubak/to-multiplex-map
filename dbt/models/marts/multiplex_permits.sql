-- Port of the old repo's gentle_density.sql: permits creating 1-4 net new dwelling
-- units (secondary suites through fourplexes). unit_bucket is kept as an explicit
-- column so the map can filter/color by exact unit count instead of only having a
-- single collapsed threshold.
select
    *,
    case
        when dwelling_units_created >= 4 then '4+'
        else cast(dwelling_units_created as varchar)
    end as unit_bucket
from {{ ref('permits_with_units') }}
where dwelling_units_created < 5
