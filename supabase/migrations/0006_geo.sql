-- ============================================================================
-- PlotMyPub → Supabase  ·  Phase 3: pub geography + the four geo badges
-- ----------------------------------------------------------------------------
-- Adds country / city / elevation to pubs and awards the badges that need them.
-- The values are filled by the geocode Edge Function when a pub is added, and by
-- the backfill-geo Edge Function for pubs that predate this migration.
--
-- IMPORTANT ordering: the geo-badge backfill is NOT run at apply time, because
-- existing pubs have no country/city/elevation yet. After deploying the Edge
-- Functions and running backfill-geo until every pub is enriched, award the
-- historical geo badges once with:
--
--     select backfill_geo_achievements();
--
-- See memory: achievements-design.
-- ============================================================================

-- ---------------------------------------------------------------- columns
alter table pubs
  add column if not exists country     text,      -- ISO 3166-1 alpha-2, e.g. 'GB','FR'
  add column if not exists city         text,      -- locality / postal town
  add column if not exists elevation_m  integer;   -- metres above sea level

-- ---------------------------------------------------------------- geo evaluator
-- Given one rating, award the geo badges its pub now qualifies the author for.
-- Guards on NULLs so an un-enriched pub simply earns nothing (yet). Rarity → XP
-- as elsewhere: Rare 300 · Epic 500 · Legendary 1000.
create or replace function award_geo_achievements_for_rating(p_rating_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r         ratings;
  p         pubs;
  v_day     date;
  v_countries int;
  v_cities  int;
begin
  select * into r from ratings where id = p_rating_id;
  if not found then return; end if;
  select * into p from pubs where id = r.pub_id;
  if not found then return; end if;

  v_day := (r.created_at at time zone 'Europe/London')::date;

  -- Brew with a View: a pub 1,000m+ up
  if p.elevation_m is not null and p.elevation_m >= 1000 then
    perform award_achievement(r.profile_id, r.group_id, 'brew_with_a_view', 300, r.id);
  end if;

  -- Jet Setter: a pub outside the UK
  if p.country is not null and p.country <> 'GB' then
    perform award_achievement(r.profile_id, r.group_id, 'jet_setter', 500, r.id);
  end if;

  -- Mr Worldwide: pubs in 10 different countries
  v_countries := (select count(distinct p2.country)
    from ratings r2 join pubs p2 on p2.id = r2.pub_id
    where r2.profile_id = r.profile_id and r2.group_id = r.group_id
      and p2.country is not null);
  if v_countries >= 10 then
    perform award_achievement(r.profile_id, r.group_id, 'mr_worldwide', 1000, r.id);
  end if;

  -- Drink Driver: pubs in two different cities on the same day
  v_cities := (select count(distinct p2.city)
    from ratings r2 join pubs p2 on p2.id = r2.pub_id
    where r2.profile_id = r.profile_id and r2.group_id = r.group_id
      and p2.city is not null
      and (r2.created_at at time zone 'Europe/London')::date = v_day);
  if v_cities >= 2 then
    perform award_achievement(r.profile_id, r.group_id, 'drink_driver', 500, r.id);
  end if;
end $$;

-- ---------------------------------------------------------------- trigger
-- Evaluate geo badges alongside XP + the data-only badges on every rating.
create or replace function award_xp_on_rating() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform award_xp_for_rating(new.id);
  perform award_achievements_for_rating(new.id);
  perform award_geo_achievements_for_rating(new.id);
  return null;  -- AFTER trigger: return value is ignored
end $$;
-- (trigger `ratings_award_xp` from 0004 already points at this function.)

-- ---------------------------------------------------------------- backfill helper
-- Run ONCE after backfill-geo has enriched every pub (see header). Idempotent +
-- order-independent, so re-running is harmless.
create or replace function backfill_geo_achievements() returns void
language plpgsql security definer set search_path = public as $$
declare rec record;
begin
  for rec in select id from ratings order by created_at, id loop
    perform award_geo_achievements_for_rating(rec.id);
  end loop;
end $$;
