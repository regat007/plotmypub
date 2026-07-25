-- ============================================================================
-- PlotMyPub → Supabase  ·  Phase 4: the three Title badges
-- ----------------------------------------------------------------------------
-- Titles are comparative — "held by one at a time" — so the CURRENT holder is
-- computed live on read (client-side). What lives in the append-only ledger is
-- the ONE-TIME reward: the first time you ever attain a title you earn its Rare
-- (300) XP, and the 'ach:<code>' row keeps the badge lit even after the live
-- title changes hands. Losing/regaining it never re-pays (idempotent on the
-- (profile, group, type) partial index from 0005).
--
-- All three run on lat/lng, which every pub already has — so no Edge Function
-- or geo enrichment is needed, and the backfill below is correct at apply time.
-- The retroactive backfill awards the one-time XP to the CURRENT record holders
-- (user-approved), since replaying over the full history resolves to today's
-- leaders. London is a fixed bounding box (Greater London), independent of the
-- geocoder's city field. See memory: achievements-design.
-- ============================================================================

create or replace function award_title_achievements_for_rating(p_rating_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r           ratings;
  p           pubs;
  v_my        int;
  v_other_max int;
  -- Greater London bounding box
  lat_lo constant numeric := 51.28;  lat_hi constant numeric := 51.70;
  lng_lo constant numeric := -0.52;  lng_hi constant numeric := 0.34;
begin
  select * into r from ratings where id = p_rating_id;
  if not found then return; end if;
  select * into p from pubs where id = r.pub_id;
  if not found or p.lat is null then return; end if;

  -- Northerner: no rated pub in the group sits further north than this one
  if not exists (
    select 1 from ratings r2 join pubs p2 on p2.id = r2.pub_id
    where r2.group_id = r.group_id and p2.lat is not null and p2.lat > p.lat
  ) then
    perform award_achievement(r.profile_id, r.group_id, 'northerner', 300, r.id);
  end if;

  -- Southerner: none further south
  if not exists (
    select 1 from ratings r2 join pubs p2 on p2.id = r2.pub_id
    where r2.group_id = r.group_id and p2.lat is not null and p2.lat < p.lat
  ) then
    perform award_achievement(r.profile_id, r.group_id, 'southerner', 300, r.id);
  end if;

  -- Big Apple: strictly the most distinct London pubs in the group
  if p.lat between lat_lo and lat_hi and p.lng between lng_lo and lng_hi then
    v_my := (select count(distinct r2.pub_id)
      from ratings r2 join pubs p2 on p2.id = r2.pub_id
      where r2.group_id = r.group_id and r2.profile_id = r.profile_id
        and p2.lat between lat_lo and lat_hi and p2.lng between lng_lo and lng_hi);
    v_other_max := (select coalesce(max(cnt), 0) from (
      select r2.profile_id, count(distinct r2.pub_id) as cnt
      from ratings r2 join pubs p2 on p2.id = r2.pub_id
      where r2.group_id = r.group_id and r2.profile_id <> r.profile_id
        and p2.lat between lat_lo and lat_hi and p2.lng between lng_lo and lng_hi
      group by r2.profile_id) t);
    if v_my >= 1 and v_my > v_other_max then
      perform award_achievement(r.profile_id, r.group_id, 'big_apple', 300, r.id);
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------- trigger
-- Now evaluates XP + data-only badges + geo badges + titles, per rating.
create or replace function award_xp_on_rating() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform award_xp_for_rating(new.id);
  perform award_achievements_for_rating(new.id);
  perform award_geo_achievements_for_rating(new.id);
  perform award_title_achievements_for_rating(new.id);
  return null;  -- AFTER trigger: return value is ignored
end $$;
-- (trigger `ratings_award_xp` from 0004 already points at this function.)

-- ============================================================================
-- Backfill: award the one-time title XP to the current record holders.
-- Idempotent + order-independent, so re-running is harmless.
-- ============================================================================
select award_title_achievements_for_rating(id) from ratings order by created_at, id;
