-- Port of the old repo's new_units.sql: non-SFD, residential permits that created
-- dwelling units, geocoded via address points. Unions cleared (completed) and active
-- (in-progress) permits so the map can show both what's built and what's underway.
--
-- Filtering here is stricter than a plain proposed_use text match:
--   - structure_type not like 'SFD%' catches straight single-family teardown-rebuilds
--     that free-text proposed_use matching misses (e.g. "2 Storey Detached Dwelling"
--     doesn't contain the word "Sfd" or "Single").
--   - structure_type blocklist excludes permits whose structure is clearly not private
--     residential housing (Hospital, Restaurant, Motel/Hotel, Place of Worship, Home
--     for the Aged, Office, Apartment Hotel), even though they report a nonzero
--     dwelling_units_created. NOTE: the city's `RESIDENTIAL` field (sq.m of residential
--     occupancy *constructed*) looked like a good signal for this at first but isn't --
--     it's 0 for the majority of legitimate basement/interior-alteration secondary
--     suites (no new floor area added), so filtering on it wrongly dropped ~2,500
--     genuine permits. Kept as a plain column for reference/display, not for filtering.
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
        and coalesce(structure_type, '') not like 'SFD%'
        and lower(coalesce(proposed_use, '')) not like '%sfd%'
        and lower(coalesce(proposed_use, '')) not like '%single%'
        and trim(coalesce(structure_type, '')) not in (
            'Office', 'Hospital', 'Restaurant 30 Seats or Less', 'Home for the Aged',
            'Motel/Hotel', 'Place of Worship', 'Apartment Hotel'
        )
)

select
    f.permit_num,
    f.source_status as status,
    f.description,
    f.structure_type,
    case
        when f.structure_type = 'Laneway / Rear Yard Suite' then 'Laneway / garden suite'
        when f.structure_type like '2 Unit%' or f.structure_type like 'Duplex%'
            then 'Duplex (2 units)'
        when f.structure_type like '3+ Unit%' or f.structure_type like 'Triplex%'
            then 'Triplex / fourplex (3-4 units)'
        when f.structure_type in ('Apartment Building', 'Multiple Unit Building', 'Stacked Townhouses')
            then 'Multi-unit building'
        when f.structure_type = 'Boarding/Lodging House' then 'Multi-tenant / rooming house'
        when f.structure_type in ('Multiple Use/Non Residential', 'Mixed Use/Res w Non Res')
            then 'Mixed use'
        else 'Other'
    end as structure_category,
    f.proposed_use,
    try_cast(f.dwelling_units_created as integer) as dwelling_units_created,
    try_cast(f.dwelling_units_lost as integer) as dwelling_units_lost,
    try_cast(f.dwelling_units_created as integer)
        - coalesce(try_cast(f.dwelling_units_lost as integer), 0) as net_units_created,
    try_cast(f.application_date as date) as application_date,
    try_cast(f.issued_date as date) as issued_date,
    try_cast(f.completed_date as date) as completed_date,
    ap.full_address,
    ap.ward,
    ap.geom,
    coalesce(cl.road_class, 'unknown') as road_class
from filtered f
left join {{ ref('stg_address_points') }} ap
    on f.street_num = ap.street_num
    and f.street_name = ap.street_name
    and f.street_type = ap.street_type
    and f.street_direction = ap.street_direction
left join {{ ref('stg_centreline') }} cl
    on f.street_name = cl.street_name
    and f.street_type = cl.street_type
    and f.street_direction = cl.street_direction
