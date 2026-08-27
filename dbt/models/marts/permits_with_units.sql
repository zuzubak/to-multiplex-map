-- Port of the old repo's new_units.sql: non-SFD, residential permits that created
-- dwelling units, geocoded via address points. Unions cleared (completed) and active
-- (in-progress) permits so the map can show both what's built and what's underway.
--
-- Filtering:
--   - structure_type not like 'SFD%' catches straight single-family teardown-rebuilds
--     that free-text matching misses (e.g. "2 Storey Detached Dwelling" contains neither
--     "Sfd" nor "Single"). The exception below it matters: ~45 genuine second-suite
--     permits and a handful of laneway suites carry an un-updated 'SFD - Detached'
--     structure_type, so a permit whose WORK is explicitly a suite job is kept anyway.
--   - There is deliberately NO filter on proposed_use. There used to be
--     (`not like '%sfd%'` / `'%single%'`) and it was a substring bug that dropped 1,505
--     genuine multiplex permits: the City writes the *resulting* use of an accessory-unit
--     permit as "Sfd + Garden Suite", "Sfd-Detached/Laneway Suite", "2 Unit Sfd" or
--     "Single Family + Laneway Suite". Matching the substring "sfd" threw out 745 permits
--     whose structure_type was 'Laneway / Rear Yard Suite' and 550 whose structure_type
--     was '2 Unit - Detached'. structure_type already does this job correctly.
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
--
-- On unit counts: dwelling_units_created is the only one kept. DWELLING_UNITS_LOST is
-- 0 on 11,749 of the 11,761 unit-creating permits the City publishes -- it simply isn't
-- populated -- so the "net_units_created" this model used to compute was always just a
-- copy of the gross figure, and the claim that it accounted for teardown-rebuilds was
-- false. It, dwelling_units_lost, and the unit_bucket derived from it have been removed
-- rather than left around looking authoritative.
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
        and (
            coalesce(structure_type, '') not like 'SFD%'
            or trim(coalesce(work, '')) in (
                'Second Suite (New)', 'New Laneway / Rear Yard Suite'
            )
        )
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
-- independent of structure_type (which encodes the resulting unit count/form, not the
-- scope of work). Two INDEPENDENT axes, not one enum:
--
--   unit_form         -- is the extra unit a subordinate suite tucked into a house, as
--                        opposed to a building of peer units? Feeds structure_category.
--   construction_type -- WHERE the new units come from. Values:
--       new_building         a whole new building (incl. demolish-and-rebuild)
--       laneway_garden_suite a detached accessory suite in the rear yard
--       basement_units       new unit(s) in the basement of a building already standing
--       aboveground_units    new unit(s) above grade in a building already standing
--                            (interior conversion, addition, garage-to-suite)
--       no_unit_change       the description describes no unit being created at all
--       unclear              not enough text to tell
--
-- construction_type replaces the old exterior_visibility column, which was a lossy
-- second collapse of the same judgment. basement_units deliberately cuts across whether
-- the building was an SFD or already a multiplex -- "add a basement unit" is the same
-- act either way, and it is the single most common thing on this map, so it needs to be
-- filterable on its own. no_unit_change is dropped from the map entirely downstream.
--
-- This regex is the FALLBACK only -- for local dev without an ANTHROPIC_API_KEY, and for
-- any permit classify/classify_permits.py hasn't reached yet. It deliberately never
-- returns no_unit_change: that value removes a permit from the map, which is too
-- destructive a call for keyword matching to make. Only the LLM assigns it; the regex
-- falls back to unclear instead. Priority order matters within each axis -- a
-- description can mention both "garden suite" and "convert", so the more specific
-- wording is checked first.
scoped as (
    select
        f.*,
        case
            when regexp_matches(f.description, 'laneway suite|garden suite|rear yard suite', 'i') then 'standard'
            when regexp_matches(f.description, '\bbasement\b|\bbaesment\b', 'i') then 'basement_or_secondary_suite'
            when regexp_matches(f.description, 'second(ary)? (suite|unit|dwelling)|2nd (suite|unit|dwelling)', 'i') then 'basement_or_secondary_suite'
            else 'standard'
        end as regex_unit_form,
        case
            -- Rear-yard accessory structures first: "convert existing garage into a
            -- garden suite" is a laneway suite, not a conversion and not a duplex.
            when regexp_matches(f.description, 'laneway suite|garden suite|rear yard suite|laneway house', 'i')
                then 'laneway_garden_suite'
            -- A genuinely new building outranks where its units sit -- a new house built
            -- with a basement apartment from the start is new_building, not basement_units.
            -- A plex word must be governed by a construction verb to count: bare
            -- "duplex"/"triplex"/"fourplex" is overwhelmingly used for the building that is
            -- already there ("convert the existing triplex to a fourplex by adding a unit in
            -- the basement" -- 158 Indian Grv), which is basement_units, not a new building.
            when regexp_matches(f.description,
                    'construct a new|construct new|new construction|newly constructed'
                    || '|demolish.{0,80}(construct|build|erect)'
                    || '|(construct|build|erect)\s+(a\s+|an\s+|the\s+)?(new\s+)?(\w+[\s-]+){0,3}'
                    || '(houseplex|multiplex|fourplex|quadplex|triplex|duplex|\d+[\s-]?unit)',
                    'i')
                then 'new_building'
            when regexp_matches(f.description, '\bbasement\b|\bbaesment\b|\bcellar\b|lower level|below grade', 'i')
                then 'basement_units'
            when regexp_matches(f.description, 'convert|conversion|change of use|legaliz|interior (alteration|renovation)|\baddition\b|\bextend\b|\benlarge\b|second storey|third storey|rear addition|side addition|second(ary)? (suite|unit|dwelling)|2nd (suite|unit|dwelling)', 'i')
                then 'aboveground_units'
            else 'unclear'
        end as regex_construction_type
    from filtered f
),

-- Claude (classify/classify_permits.py) reads each permit's description directly and
-- classifies both axes, caching results in this seed keyed by permit_num + a hash of the
-- description (so a revision that changes the text gets reclassified).
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
    f.structure_type,
    f.work,
    case
        -- Laneway/garden suites are identified from the description first. The City's
        -- structure_type says 'Laneway / Rear Yard Suite' for most of them but calls a
        -- meaningful minority '2 Unit - Detached' (the lot ends up with two units, which
        -- is true but not the point) -- which is why 936 Scarlett Rd, "construct a garden
        -- suite above existing garage", used to render as "Duplex (2 units)".
        when f.construction_type = 'laneway_garden_suite'
            or f.structure_type = 'Laneway / Rear Yard Suite'
            then 'Laneway / garden suite'
        -- A "2 Unit" permit whose extra unit is a subordinate suite is a house with one
        -- accessory unit, not an architectural duplex. Only applied at the 2-unit level --
        -- a 3-6 unit building is a genuinely different physical form even if some of its
        -- units were created by interior conversion.
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
    f.current_use,
    f.proposed_use,
    try_cast(f.dwelling_units_created as integer) as dwelling_units_created,
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
