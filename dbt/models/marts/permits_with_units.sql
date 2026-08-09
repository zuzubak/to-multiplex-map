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
--   - permit_status matters a lot: "cleared" (source_status) just means the permit is in
--     the City's cleared_permits archive, NOT that construction finished. Within that
--     archive, permit_status is 'Closed' for genuinely completed permits but 'Cancelled'
--     for permits that were withdrawn and never built -- 41% of what we'd otherwise call
--     "cleared" in our multiplex-scale subset was actually Cancelled. Require
--     permit_status = 'Closed' for cleared permits. For active permits, exclude a small
--     set of terminal non-completion statuses (cancelled/refused/abandoned/revocation)
--     that show up occasionally even in the "active" source.
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
        and (
            (source_status = 'cleared' and trim(coalesce(permit_status, '')) = 'Closed')
            or (
                source_status = 'active'
                and trim(coalesce(permit_status, '')) not in (
                    'Cancelled', 'Refused', 'Refusal Notice', 'Abandoned',
                    'Revocation Pending', 'Revocation Notice Sent', 'Pending Cancellation',
                    'Superseded'
                )
            )
        )
),

-- Classifies each permit by what its own free-text description says was actually done,
-- independent of structure_type/structure_category above (which only encode the resulting
-- unit count/form, not the scope of work). Two INDEPENDENT axes, not one enum: unit_form
-- (is the extra unit a basement/secondary suite tucked into a house, as opposed to a
-- standard duplex/triplex/laneway-suite form) and construction_type (was the building
-- itself newly built or altered). These used to be conflated into a single value keyed
-- off whether "basement" appeared in the text, which was wrong -- a basement suite can be
-- part of a brand-new house (123 Edgecroft Rd: "construct a new 2 storey SFD-detached
-- dwelling" with a basement unit added by revision) just as easily as a retrofit into an
-- old one (11 Waterbridge Way: "...in the basement of an existing 2 storey detached
-- dwelling"). Priority order matters within each axis -- e.g. a description can mention
-- both "basement" and "convert", so more specific wording is checked first.
scoped as (
    select
        f.*,
        case
            when regexp_matches(f.description, '\bbasement\b|\bbaesment\b', 'i') then 'basement_or_secondary_suite'
            when regexp_matches(f.description, 'second(ary)? (suite|unit|dwelling)|2nd (suite|unit|dwelling)', 'i') then 'basement_or_secondary_suite'
            else 'standard'
        end as regex_unit_form,
        case
            when regexp_matches(f.description, 'demolish|raze|remove existing|removal of the existing|burned down', 'i')
                and regexp_matches(f.description, 'construct a new|construct new|new construction|proposed ,?two-storey duplex|build a (four|three|two)|houseplex|multiplex|fourplex|quadplex|triplex|duplex|laneway suite|construct\s+(a\s+|an\s+)?\d+[\s-]?unit', 'i')
                then 'new_construction_teardown'
            when regexp_matches(f.description, 'interior (alteration|renovation)', 'i') then 'alteration'
            when regexp_matches(f.description, 'garden suite|laneway suite', 'i') then 'garden_suite'
            when regexp_matches(f.description, 'convert|conversion|covert existing|change of use|legaliz', 'i')
                and not regexp_matches(f.description, 'demolish|raze|remove existing|removal of the existing', 'i')
                then 'conversion'
            when regexp_matches(f.description, '\bsever(ance|ed)?\b', 'i') then 'severance'
            when regexp_matches(f.description, 'construct a new|construct new|new construction|proposed ,?two-storey duplex|build a (four|three|two)|houseplex|multiplex|fourplex|quadplex|triplex|duplex|laneway suite|construct\s+(a\s+|an\s+)?\d+[\s-]?unit', 'i')
                then 'new_construction'
            when regexp_matches(f.description, '\baddition\b|\bextend\b|\benlarge\b|second storey addition|third storey|rear addition|side addition', 'i')
                then 'addition'
            -- Basement/secondary-suite wording with no explicit new-construction or addition
            -- signal defaults to "alteration to an existing building" -- the base rate for
            -- these permits (a manual audit found ~85%+ genuinely are retrofits), while still
            -- letting the new_construction/addition branches above win when the text says so.
            when regexp_matches(f.description, '\bbasement\b|\bbaesment\b|second(ary)? (suite|unit|dwelling)|2nd (suite|unit|dwelling)', 'i')
                then 'alteration'
            else 'unclear'
        end as regex_construction_type
    from filtered f
),

-- Claude (classify/classify_permits.py) reads each permit's description directly and
-- classifies both axes, caching results in this seed keyed by permit_num + a hash of the
-- description (so a revision that changes the text gets reclassified). The regex above only
-- exists as a fallback -- for local dev without an ANTHROPIC_API_KEY, and for any permit the
-- classify step hasn't gotten to yet.
resolved as (
    select
        f.*,
        coalesce(llm.unit_form::varchar, f.regex_unit_form) as unit_form,
        coalesce(llm.construction_type::varchar, f.regex_construction_type) as construction_type
    from scoped f
    left join {{ ref('llm_permit_scope') }} llm
        on f.permit_num = llm.permit_num
        and md5(trim(f.description)) = llm.description_hash
),

-- Fallback geocoding source for permits whose GEO_ID is missing or doesn't resolve.
-- Deduplicated on the street key because ~3,200 four-part keys map to more than one
-- address point (same civic number on the same street, e.g. separate land/structure
-- points), which would otherwise fan a single permit out into several rows.
address_points_by_street as (
    select
        street_num, street_name, street_type, street_direction,
        full_address, ward, geom
    from {{ ref('stg_address_points') }}
    qualify row_number() over (
        partition by street_num, street_name, street_type, street_direction
        order by address_point_id
    ) = 1
)

select
    f.permit_num,
    f.source_status as status,
    f.description,
    f.construction_type,
    f.unit_form,
    case f.construction_type
        when 'new_construction_teardown' then 'new_construction'
        when 'new_construction' then 'new_construction'
        when 'garden_suite' then 'new_construction'
        when 'conversion' then 'conversion'
        when 'addition' then 'conversion'
        when 'severance' then 'conversion'
        when 'alteration' then 'interior_only'
        else 'unclear'
    end as exterior_visibility,
    f.structure_type,
    case
        when f.structure_type = 'Laneway / Rear Yard Suite' then 'Laneway / garden suite'
        -- A "2 Unit" permit whose extra unit is specifically a basement/secondary suite is
        -- a house with one accessory unit, not an architectural duplex -- split it into its
        -- own category regardless of whether the house itself is new or existing (that's
        -- what exterior_visibility/construction_type is for). Only applied at the 2-unit
        -- level -- a 3-6 unit building is a genuinely different physical form even if some
        -- of its units were created via interior conversion.
        when (f.structure_type like '2 Unit%' or f.structure_type like 'Duplex%')
            and f.unit_form = 'basement_or_secondary_suite'
            then 'House + secondary suite'
        when f.structure_type like '2 Unit%' or f.structure_type like 'Duplex%'
            then 'Duplex (2 units)'
        when f.structure_type like '3+ Unit%' or f.structure_type like 'Triplex%'
            then 'Triplex+ (3-6 units)'
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
    coalesce(ap_id.full_address, ap_str.full_address) as full_address,
    coalesce(ap_id.ward, ap_str.ward) as ward,
    coalesce(ap_id.geom, ap_str.geom) as geom,
    coalesce(cl.road_class, 'unknown') as road_class
-- Geocoding is GEO_ID first, street-name match second. The permits' GEO_ID *is* the
-- Address Points dataset's ADDRESS_POINT_ID (verified against the City's API), so it's an
-- exact key rather than a string comparison. The street-name join alone silently dropped
-- suffixed addresses, where the two datasets space the unit differently -- the permit says
-- "44 A"/"2639 R", address points say "44A"/"2639R" -- so those permits geocoded to
-- nothing and fell off the map entirely. Kept as a fallback for the minority of permits
-- with a null or retired GEO_ID.
from resolved f
left join {{ ref('stg_address_points') }} ap_id
    on f.geo_id = ap_id.address_point_id
left join address_points_by_street ap_str
    on f.street_num = ap_str.street_num
    and f.street_name = ap_str.street_name
    and f.street_type = ap_str.street_type
    and f.street_direction = ap_str.street_direction
left join {{ ref('stg_centreline') }} cl
    on f.street_name = cl.street_name
    and f.street_type = cl.street_type
    and f.street_direction = cl.street_direction
