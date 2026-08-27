-- One row per permit_num: the source data carries one row per revision, so keep only
-- the latest revision (highest revision_num) to avoid double/triple counting a permit.
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
    residential as residential_area,
    'cleared' as source_status
from {{ source('raw', 'cleared_permits') }}
-- Ties on the integer cast are real and they matter: the source carries an
-- administrative "Deferred Fees from folder ..." stub at revision_num '0' alongside the
-- actual permit at '00', and both cast to 0. The stub has NULL structure_type, work and
-- dwelling_units_created, so whenever the tie broke its way the permit failed the
-- units-created filter downstream and disappeared from the map entirely -- 139 permits
-- flickering in and out between runs. Break the tie toward the row that actually carries
-- permit data, then on the raw string, so the result is deterministic.
qualify row_number() over (
    partition by permit_num
    order by
        try_cast(revision_num as integer) desc nulls last,
        case when dwelling_units_created is null then 1 else 0 end,
        case when structure_type is null then 1 else 0 end,
        revision_num desc
) = 1
