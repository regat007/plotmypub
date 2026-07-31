-- ============================================================================
-- PlotMyPub → Supabase  ·  Four more badges: milestone, spree and clock-based
-- ----------------------------------------------------------------------------
--   💯 Hundred Club   Legendary  your 100th pub in this group
--   💸 Big Spender    Epic       3 pubs under 2.5 for value inside 24 hours
--   🛋️ Unemployed     Rare       a pub rated on a weekday morning
--   😰 Sunday Scaries Common     a pub rated on a Sunday evening
--
-- Same shape as the geo (0006) and title (0007) migrations: its own evaluator,
-- folded into award_xp_on_rating() alongside the others. Codes match
-- js/achievements.mjs exactly. Every award goes through award_achievement, so it
-- stays once-per-lifetime per (profile, group) and re-running is a no-op.
--
-- DELIBERATELY NO BACKFILL — unlike 0005/0006/0007. New badges do not back-date
-- unless explicitly asked for; these four start earning the moment this lands.
-- The sweep is written out at the bottom, ready to run by hand on request.
--
-- Two judgement calls worth knowing about:
--   • "Day" and "hour" are Europe/London, like the crawl/streak logic in 0005 —
--     so a Sunday evening stays a Sunday evening through a UTC-offset change.
--   • The clock used is `created_at`, i.e. when the rating was SAVED, not when
--     the drinker was actually in the pub. Rating Sunday's session on Monday
--     morning earns Unemployed, not Sunday Scaries. That matches how the
--     existing Pub Crawler / streak badges already read the ledger, and the app
--     has no separate "when were you there?" field to use instead.
--
-- Run: `npx supabase db push`  (depends on 0009 having restored UPDATE firing)
-- ============================================================================

-- ---------------------------------------------------------------- evaluator
create or replace function award_time_achievements_for_rating(p_rating_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r       ratings;
  v_local timestamp;   -- this rating's wall-clock time in Europe/London
  v_dow   int;         -- 0 = Sunday … 6 = Saturday
  v_hour  int;
begin
  select * into r from ratings where id = p_rating_id;
  if not found then return; end if;

  v_local := r.created_at at time zone 'Europe/London';
  v_dow   := extract(dow  from v_local);
  v_hour  := extract(hour from v_local);

  -- Hundred Club: the 100th pub you've rated in this group. Counted up to and
  -- including THIS rating (not a bare total), so the badge is attributed to the
  -- rating that actually crossed the line — live and on backfill alike.
  if (select count(*) from ratings r2
        where r2.profile_id = r.profile_id and r2.group_id = r.group_id
          and (r2.created_at, r2.id) <= (r.created_at, r.id)) >= 100 then
    perform award_achievement(r.profile_id, r.group_id, 'hundred_club', 1000, r.id);
  end if;

  -- Big Spender: three pubs scored under 2.5 for value inside one ROLLING 24
  -- hours ending at this rating — "in 24 hours" as asked, not a calendar day,
  -- so an evening that runs past midnight still counts as one bad-value spree.
  if (select count(*) from ratings r2
        where r2.profile_id = r.profile_id and r2.group_id = r.group_id
          and r2.value < 2.5
          and r2.created_at <= r.created_at
          and r2.created_at >  r.created_at - interval '24 hours') >= 3 then
    perform award_achievement(r.profile_id, r.group_id, 'big_spender', 500, r.id);
  end if;

  -- Unemployed: Monday to Friday, 06:00–11:59. The 06:00 floor keeps a 3am
  -- Tuesday finish reading as the night before rather than an early start.
  if v_dow between 1 and 5 and v_hour between 6 and 11 then
    perform award_achievement(r.profile_id, r.group_id, 'unemployed', 300, r.id);
  end if;

  -- Sunday Scaries: Sunday, 17:00 to midnight.
  if v_dow = 0 and v_hour between 17 and 23 then
    perform award_achievement(r.profile_id, r.group_id, 'sunday_scaries', 100, r.id);
  end if;
end $$;

-- ---------------------------------------------------------------- trigger
-- Now evaluates XP + data-only badges + geo badges + titles + these four.
create or replace function award_xp_on_rating() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform award_xp_for_rating(new.id);
  perform award_achievements_for_rating(new.id);
  perform award_geo_achievements_for_rating(new.id);
  perform award_title_achievements_for_rating(new.id);
  perform award_time_achievements_for_rating(new.id);
  return null;  -- AFTER trigger: return value is ignored
end $$;
-- (trigger `ratings_award_xp` is recreated for INSERT OR UPDATE in 0009.)

-- ============================================================================
-- NO BACKFILL IS RUN HERE. From here on these four are earned live, going
-- forward only — nobody wakes up already holding a badge they never noticed
-- winning, and the four unlock popups land when the moment is actually earned.
--
-- To sweep history later, on request, run this by hand. It is idempotent and
-- order-independent, so it is safe to run once or a hundred times:
--
--   select award_time_achievements_for_rating(id) from ratings order by created_at, id;
--
-- Note this is one-way: xp_events is append-only and the client cannot delete
-- from it, so a backfill cannot be undone from the app once run.
-- ============================================================================
