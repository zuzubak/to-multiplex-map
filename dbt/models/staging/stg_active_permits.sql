-- One row per permit_num: see stg_cleared_permits.sql for why (revision dedup).
select
    permit_num as permit_num,
    revision_num as revision_num,
    permit_type as permit_type,
    structure_type as structure_type,
    work as work,
    trim(street_num) as street_num,
    upper(trim(street_name)) as street_name,
    upper(trim(street_type)) as street_type,
    case
        when upper(trim(coalesce(street_direction, ''))) in ('', 'NONE') then ''
        else upper(trim(street_direction))
    end as street_direction,
    try_cast(geo_id as bigint) as geo_id,
    application_date as application_date,
    issued_date as issued_date,
    completed_date as completed_date,
    status as permit_status,
    description as description,
    current_use as current_use,
    proposed_use as proposed_use,
    dwelling_units_created as dwelling_units_created,
    dwelling_units_lost as dwelling_units_lost,
    residential as residential_area,
    'active' as source_status
from {{ source('raw', 'active_permits') }}
qualify row_number() over (
    partition by permit_num
    order by try_cast(revision_num as integer) desc
) = 1
