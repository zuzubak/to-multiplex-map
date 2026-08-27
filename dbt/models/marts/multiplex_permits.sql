-- Port of the old repo's gentle_density.sql: permits creating 1-6 new dwelling units
-- (secondary suites through six-plexes). Cap is 6, not 4, matching Toronto's 2024
-- "Expanding Housing Options" zoning update, which extended as-of-right multiplex
-- permissions from 4 units up to 6 on larger lots.
--
-- The count is dwelling_units_created, the City's own figure, straight. There is no
-- "net" version: DWELLING_UNITS_LOST is 0 on 11,749 of the 11,761 unit-creating permits
-- the City publishes, so subtracting it never did anything, and a model column called
-- net_units_created implied an accounting that wasn't happening. A demolish-and-rebuild
-- permit still reports its full gross unit count here -- construction_type = 'new_building'
-- is the honest signal for that, not a bogus subtraction.
--
-- no_unit_change permits are excluded outright. These are permits the City credits with
-- creating a dwelling unit whose description describes no such thing -- 108 Sammon Ave,
-- "underpin basement, construct a rear one storey addition, second floor addition,
-- replace existing detached garage and a new rear deck", counted as 1 new unit. Either
-- the count is a data-entry artifact or the description is silent about the real scope;
-- either way the permit can't be shown as evidence of a new unit. Only the LLM assigns
-- this value -- the regex fallback in permits_with_units.sql never does, so a run without
-- an API key drops nothing.
select *
from {{ ref('permits_with_units') }}
where dwelling_units_created between 1 and 6
  and construction_type != 'no_unit_change'
