select
    strftime(coalesce(completed_date, issued_date, application_date), '%Y-%m') as year_month,
    status,
    count(*) as permit_count,
    sum(dwelling_units_created) as dwelling_units_created
from {{ ref('multiplex_permits') }}
group by year_month, status
order by year_month, status
