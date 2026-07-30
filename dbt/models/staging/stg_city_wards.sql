select
    area_short_code as ward_code,
    area_name as ward_name,
    st_geomfromgeojson(geometry) as geom
from {{ source('raw', 'city_wards') }}
where try_cast(date_expiry as timestamp) > current_date
