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
-- unit count/form, not the scope of work). This surfaces basement/secondary-suite
-- legalizations -- interior work inside an existing house, invisible from the street/Street
-- View -- that structure_type otherwise files under the same code as a genuine new-build
-- duplex ("2 Unit - Detached" covers both). Ported from a manual audit of ~1,100 outlying-
-- ward permits: reading descriptions directly showed ~84% of "multiplex" permits on minor
-- streets outside downtown were basement suites or interior alterations, not new buildings.
-- Priority order matters -- e.g. a description can mention both "basement" and "convert",
-- so basement/secondary-suite wording is checked before the more generic conversion match.
scoped as (
    select
        f.*,
        case
            when regexp_matches(f.description, 'demolish|raze|remove existing|removal of the existing|burned down', 'i')
                and regexp_matches(f.description, 'construct a new|construct new|new construction|proposed ,?two-storey duplex|build a (four|three|two)|houseplex|multiplex|fourplex|quadplex|triplex|duplex|laneway suite|construct\s+(a\s+|an\s+)?\d+[\s-]?unit', 'i')
                then 'new_construction_teardown'
            when regexp_matches(f.description, '\bbasement\b|\bbaesment\b', 'i') then 'basement_suite'
            when regexp_matches(f.description, 'second(ary)? (suite|unit|dwelling)|2nd (suite|unit|dwelling)', 'i') then 'secondary_suite'
            when regexp_matches(f.description, 'interior (alteration|renovation)', 'i') then 'interior_alteration'
            when regexp_matches(f.description, 'garden suite|laneway suite', 'i') then 'garden_suite'
            when regexp_matches(f.description, 'convert|conversion|covert existing|change of use|legaliz', 'i')
                and not regexp_matches(f.description, 'demolish|raze|remove existing|removal of the existing', 'i')
                then 'conversion_no_demo'
            when regexp_matches(f.description, '\bsever(ance|ed)?\b', 'i') then 'severance'
            when regexp_matches(f.description, 'construct a new|construct new|new construction|proposed ,?two-storey duplex|build a (four|three|two)|houseplex|multiplex|fourplex|quadplex|triplex|duplex|laneway suite|construct\s+(a\s+|an\s+)?\d+[\s-]?unit', 'i')
                then 'new_construction'
            when regexp_matches(f.description, '\baddition\b|\bextend\b|\benlarge\b|second storey addition|third storey|rear addition|side addition', 'i')
                then 'addition'
            else 'unclear'
        end as regex_permit_scope
    from filtered f
),

-- Claude (classify/classify_permits.py) reads each permit's description directly and
-- classifies it into the same permit_scope vocabulary as the regex above, caching results
-- in this seed keyed by permit_num + a hash of the description (so a revision that changes
-- the text gets reclassified). The regex only exists as a fallback -- for local dev without
-- an ANTHROPIC_API_KEY, and for any permit the classify step hasn't gotten to yet.
resolved as (
    select
        f.*,
        coalesce(llm.permit_scope::varchar, f.regex_permit_scope) as permit_scope
    from scoped f
    left join {{ ref('llm_permit_scope') }} llm
        on f.permit_num = llm.permit_num
        and md5(trim(f.description)) = llm.description_hash
)

select
    f.permit_num,
    f.source_status as status,
    f.description,
    f.permit_scope,
    case f.permit_scope
        when 'new_construction_teardown' then 'new_construction'
        when 'new_construction' then 'new_construction'
        when 'garden_suite' then 'new_construction'
        when 'conversion_no_demo' then 'conversion'
        when 'addition' then 'conversion'
        when 'severance' then 'conversion'
        when 'basement_suite' then 'interior_only'
        when 'secondary_suite' then 'interior_only'
        when 'interior_alteration' then 'interior_only'
        else 'unclear'
    end as exterior_visibility,
    f.structure_type,
    case
        when f.structure_type = 'Laneway / Rear Yard Suite' then 'Laneway / garden suite'
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
    ap.full_address,
    ap.ward,
    ap.geom,
    coalesce(cl.road_class, 'unknown') as road_class
from resolved f
left join {{ ref('stg_address_points') }} ap
    on f.street_num = ap.street_num
    and f.street_name = ap.street_name
    and f.street_type = ap.street_type
    and f.street_direction = ap.street_direction
left join {{ ref('stg_centreline') }} cl
    on f.street_name = cl.street_name
    and f.street_type = cl.street_type
    and f.street_direction = cl.street_direction
