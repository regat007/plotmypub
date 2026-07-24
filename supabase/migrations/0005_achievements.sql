-- ============================================================================
-- PlotMyPub → Supabase  ·  Phase 2: achievement badges (data-only set)
-- ----------------------------------------------------------------------------
-- Achievements feed the SAME xp_events ledger as XP (0004_xp.sql), as rows with
-- type = 'ach:<code>'. The client reads them via fetchAchievements(); the codes
-- match js/achievements.mjs exactly. Decisions baked in (see memory: achievements-design):
--
--   • Server-authoritative, like XP. Every badge is awarded by a security-definer
--     function on `ratings`; clients only READ. Nothing is forgeable, and the
--     hidden Epic/Legendary criteria never ship to the browser.
--   • Once-per-lifetime, per (profile, group). A partial unique index on
--     (profile_id, group_id, type) for 'ach:%' rows is the anti-double-award
--     guarantee. NOTE: the base UNIQUE(profile_id, type, ref_id) is NOT enough —
--     Postgres treats each ref_id as distinct, so a second qualifying rating
--     would slip a duplicate through. Hence the dedicated partial index +
--     untargeted `on conflict do nothing`.
--   • Idempotent + order-independent, so the backfill at the bottom is safe to
--     re-run and gives the same result live or in bulk (predicates compare
--     created_at absolutely, exactly like award_xp_for_rating's first_map test).
--   • "Day" is Europe/London (created_at is UTC). Pins crawl / streak logic to a
--     single timezone so an evening that straddles midnight UTC stays one day.
--
-- This covers the 18 badges computable from ratings alone. Still to come:
--   • Geo badges (Jet Setter, Mr Worldwide, Drink Driver, Brew with a View) —
--     need country / city / elevation on `pubs` first (a later migration).
--   • Titles (Big Apple, Northerner, Southerner) — held by one person at a time,
--     computed live on read, not stored here.
--
-- Run: `npx supabase db push` (the backfill runs on apply).
-- ============================================================================

-- ---------------------------------------------------------------- idempotency
-- One achievement row per (profile, group, badge). Untargeted on-conflict below
-- relies on this to reject re-awards no matter which rating triggers them.
create unique index if not exists xp_events_ach_uidx
  on xp_events (profile_id, group_id, type) where type like 'ach:%';

-- ---------------------------------------------------------------- award helper
-- Single insert point for a badge. SECURITY DEFINER so it can write xp_events
-- regardless of the caller's RLS; search_path pinned. `on conflict do nothing`
-- (untargeted) makes a repeat award a no-op — caught by the partial index above.
create or replace function award_achievement(
  p_profile uuid, p_group uuid, p_code text, p_amount int, p_ref uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into xp_events (profile_id, group_id, type, amount, ref_id)
  values (p_profile, p_group, 'ach:' || p_code, p_amount, p_ref)
  on conflict do nothing;
end $$;

-- ---------------------------------------------------------------- evaluator
-- Given one rating, award every data-only badge it now qualifies the author for.
-- Rarity → XP: Common 100 · Rare 300 · Epic 500 · Legendary 1000.
create or replace function award_achievements_for_rating(p_rating_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r        ratings;
  v_day    date;      -- this rating's calendar day, Europe/London
  v_day_ct int;       -- how many pubs the author rated that same day
begin
  select * into r from ratings where id = p_rating_id;
  if not found then return; end if;

  v_day := (r.created_at at time zone 'Europe/London')::date;

  -- ---- single-rating category badges -------------------------------------
  if r.facilities >= 4.5 then perform award_achievement(r.profile_id, r.group_id, 'nice_gaff',        100, r.id); end if;
  if r.beer       >= 4.5 then perform award_achievement(r.profile_id, r.group_id, 'poor_me_poor_me',  100, r.id); end if;
  if r.value      >= 4.5 then perform award_achievement(r.profile_id, r.group_id, 'cash_money',       100, r.id); end if;
  if r.vibe       >= 4.5 then perform award_achievement(r.profile_id, r.group_id, 'good_vibes',       100, r.id); end if;
  if r.value      <  1.5 then perform award_achievement(r.profile_id, r.group_id, 'poor_me',          300, r.id); end if;
  if r.location   <  2 and r.vibe > 4 then perform award_achievement(r.profile_id, r.group_id, 'diamond_in_the_rough', 500, r.id); end if;

  -- Journalist: a note AND a photo on the same review
  if coalesce(btrim(r.note), '') <> '' and coalesce(btrim(r.photo_path), '') <> '' then
    perform award_achievement(r.profile_id, r.group_id, 'journalist', 100, r.id);
  end if;

  -- Blogger: a note that nearly fills the 200-char box
  if char_length(coalesce(r.note, '')) >= 190 then
    perform award_achievement(r.profile_id, r.group_id, 'blogger', 500, r.id);
  end if;

  -- ---- cross-rating counts -----------------------------------------------
  -- Sheep: five OTHER people have also rated this pub
  if (select count(*) from ratings r2
        where r2.pub_id = r.pub_id and r2.profile_id <> r.profile_id) >= 5 then
    perform award_achievement(r.profile_id, r.group_id, 'sheep', 100, r.id);
  end if;

  -- Accountant / Connoisseur: 10 of your ratings scoring above 4 in a category
  if (select count(*) from ratings r2
        where r2.profile_id = r.profile_id and r2.group_id = r.group_id and r2.value > 4) >= 10 then
    perform award_achievement(r.profile_id, r.group_id, 'accountant', 300, r.id);
  end if;
  if (select count(*) from ratings r2
        where r2.profile_id = r.profile_id and r2.group_id = r.group_id and r2.beer > 4) >= 10 then
    perform award_achievement(r.profile_id, r.group_id, 'connoisseur', 300, r.id);
  end if;

  -- I Remember My First Beer: your very first pub in this group
  if not exists (select 1 from ratings r2
        where r2.profile_id = r.profile_id and r2.group_id = r.group_id
          and (r2.created_at, r2.id) < (r.created_at, r.id)) then
    perform award_achievement(r.profile_id, r.group_id, 'first_beer', 100, r.id);
  end if;

  -- ---- same-day counts: Pub Crawler I / II / III -------------------------
  v_day_ct := (select count(*) from ratings r2
        where r2.profile_id = r.profile_id and r2.group_id = r.group_id
          and (r2.created_at at time zone 'Europe/London')::date = v_day);
  if v_day_ct >= 3  then perform award_achievement(r.profile_id, r.group_id, 'pub_crawler_1', 100, r.id); end if;
  if v_day_ct >= 6  then perform award_achievement(r.profile_id, r.group_id, 'pub_crawler_2', 300, r.id); end if;
  if v_day_ct >= 10 then perform award_achievement(r.profile_id, r.group_id, 'pub_crawler_3', 500, r.id); end if;

  -- ---- day streaks ending today ------------------------------------------
  -- N distinct rating-days inside an N-wide window ⇒ N consecutive days.
  -- On the Sauce: 3 days running
  if (select count(distinct (r2.created_at at time zone 'Europe/London')::date) from ratings r2
        where r2.profile_id = r.profile_id and r2.group_id = r.group_id
          and (r2.created_at at time zone 'Europe/London')::date between v_day - 2 and v_day) = 3 then
    perform award_achievement(r.profile_id, r.group_id, 'on_the_sauce', 300, r.id);
  end if;
  -- Alcoholic: 7 days running
  if (select count(distinct (r2.created_at at time zone 'Europe/London')::date) from ratings r2
        where r2.profile_id = r.profile_id and r2.group_id = r.group_id
          and (r2.created_at at time zone 'Europe/London')::date between v_day - 6 and v_day) = 7 then
    perform award_achievement(r.profile_id, r.group_id, 'alcoholic', 1000, r.id);
  end if;

  -- ---- Going Sober: first rating back after a 28-day dry spell ------------
  if exists (select 1 from ratings r2
        where r2.profile_id = r.profile_id and r2.group_id = r.group_id
          and (r2.created_at, r2.id) < (r.created_at, r.id))
     and not exists (select 1 from ratings r2
        where r2.profile_id = r.profile_id and r2.group_id = r.group_id
          and r2.created_at < r.created_at
          and r2.created_at >= r.created_at - interval '28 days') then
    perform award_achievement(r.profile_id, r.group_id, 'going_sober', 100, r.id);
  end if;
end $$;

-- ---------------------------------------------------------------- trigger
-- Fold achievement evaluation into the existing per-rating award trigger, right
-- alongside the XP award. Both are idempotent, so INSERT + UPDATE both fire and
-- a re-rate never double-awards; an UPDATE that first adds a note/photo can newly
-- earn Journalist / Blogger.
create or replace function award_xp_on_rating() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform award_xp_for_rating(new.id);
  perform award_achievements_for_rating(new.id);
  return null;  -- AFTER trigger: return value is ignored
end $$;
-- (trigger `ratings_award_xp` from 0004 already points at this function.)

-- ---------------------------------------------------------------- grants
-- Definer functions are called by the trigger only — never granted to clients.

-- ============================================================================
-- Backfill: award badges for every rating that already exists (retroactive —
-- user-approved). Idempotent + order-independent, so re-running is harmless.
-- ============================================================================
select award_achievements_for_rating(id) from ratings order by created_at, id;
