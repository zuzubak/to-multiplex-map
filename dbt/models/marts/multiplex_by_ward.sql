select
    ward,
    status,
    count(*) as permit_count,
    sum(dwelling_units_created) as dwelling_units_created
from {{ ref('multiplex_permits') }}
group by ward, status
order by ward, status
