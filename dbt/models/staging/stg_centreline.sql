-- One row per normalized street name: a named street can have many segments with the
-- same classification, so mode() picks the most common one where it (rarely) varies.
with normalized as (
    select
        upper(trim(linear_name)) as street_name,
        upper(trim(linear_name_type)) as street_type,
        case
            when upper(trim(coalesce(linear_name_dir, ''))) in ('', 'NONE') then ''
            else upper(trim(linear_name_dir))
        end as street_direction,
        feature_code_desc
    from {{ source('raw', 'centreline') }}
    where feature_code_desc is not null
),

by_street as (
    select
        street_name,
        street_type,
        street_direction,
        mode(feature_code_desc) as road_feature
    from normalized
    group by 1, 2, 3
)

select
    street_name,
    street_type,
    street_direction,
    road_feature,
    case
        when road_feature in (
            'Expressway', 'Expressway Ramp', 'Major Arterial', 'Major Arterial Ramp', 'Minor Arterial'
        ) then 'major'
        when road_feature in ('Local', 'Collector', 'Laneway') then 'minor'
        else 'unknown'
    end as road_class
from by_street
