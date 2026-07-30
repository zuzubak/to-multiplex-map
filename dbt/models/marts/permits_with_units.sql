-- Port of the old repo's new_units.sql: non-SFD permits that created dwelling units,
-- geocoded via address points. Now unions cleared (completed) and active (in-progress)
-- permits so the map can show both what's built and what's underway.
with permits as (
    select * from {{ ref('stg_cleared_permits') }}
    union all
    select * from {{ ref('stg_active_permits') }}
),

filtered as (
    select *
    from permits
    where
        dwelling_units_created is not null
        and trim(dwelling_units_created) != ''
        and try_cast(dwelling_units_created as integer) > 0
        and lower(coalesce(proposed_use, '')) not like '%sfd%'
        and lower(coalesce(proposed_use, '')) not like '%single%'
)

select
    f.permit_num,
    f.source_status as status,
    f.description,
    f.structure_type,
    f.proposed_use,
    try_cast(f.dwelling_units_created as integer) as dwelling_units_created,
    try_cast(f.application_date as date) as application_date,
    try_cast(f.issued_date as date) as issued_date,
    try_cast(f.completed_date as date) as completed_date,
    ap.full_address,
    ap.ward,
    ap.geom
from filtered f
left join {{ ref('stg_address_points') }} ap
    on f.street_num = ap.street_num
    and f.street_name = ap.street_name
    and f.street_type = ap.street_type
    and f.street_direction = ap.street_direction
