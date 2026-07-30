select
    trim(address_number) as street_num,
    upper(trim(linear_name)) as street_name,
    upper(trim(linear_name_type)) as street_type,
    case
        when upper(trim(coalesce(linear_name_dir, ''))) in ('', 'NONE') then ''
        else upper(trim(linear_name_dir))
    end as street_direction,
    address_full as full_address,
    ward_name as ward,
    st_geomfromgeojson(geometry) as geom
from {{ source('raw', 'address_points') }}
