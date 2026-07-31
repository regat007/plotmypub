-- ============================================================================
-- PlotMyPub → Supabase  ·  Fix: the award trigger was not firing on UPDATE
-- ----------------------------------------------------------------------------
-- Symptom: the Journalist badge ("a note AND a photo on the same review") never
-- unlocked, and no `with_photo` XP had ever been awarded — 0 rows across every
-- rating that has a photo.
--
-- Diagnosis (checked against live data, group 5e6998fb…):
--   • Ratings DO carry photo_path, so the client-side upload + update works.
--   • Every badge that can be decided at INSERT time was awarded correctly.
--   • Nothing that depends on a LATER edit had ever been awarded: `with_photo`
--     0 rows / 3 photos, `with_note` 1 row / 2 notes, `ach:journalist` absent
--     even though The Gun Inn has had both a note and a photo since 25 Jul.
--   • A no-op UPDATE of that rating produced no new ledger rows at all.
--
-- So the deployed `ratings_award_xp` trigger fires on INSERT only. 0004_xp.sql
-- declares `after insert or update`, but an applied migration is never re-run,
-- so whatever the DB got first is what it still has — and the file has drifted
-- from it. That matters because the photo is always a second write: the client
-- can only set photo_path once the rating row exists (map.mjs), so Journalist
-- and with_photo can *only* ever be earned on an UPDATE.
--
-- Fix: recreate the trigger for INSERT OR UPDATE, re-assert award_xp_for_rating
-- (the deployed copy is known to have drifted from 0004 — this is that file's
-- body verbatim, and the later migrations already replace everything else), then
-- re-run the backfills so the ratings that have been quietly qualifying all
-- along get their due. Every award is on-conflict-do-nothing, so nothing that
-- was already earned is duplicated or re-dated.
--
-- Run: `npx supabase db push`
-- ============================================================================

-- ---------------------------------------------------------------- award logic
-- Verbatim re-assert of 0004_xp.sql's function, so the deployed body is known
-- to match the file. Point values unchanged:
--     rate_pub   50 · first_map 10 · new_area 20 · with_note 10 · with_photo 10
create or replace function award_xp_for_rating(p_rating_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  r      ratings;
  v_area text;      -- normalised area of this rating's pub (null/blank = no area bonus)
begin
  select * into r from ratings where id = p_rating_id;
  if not found then return; end if;

  select nullif(lower(btrim(p.area)), '') into v_area from pubs p where p.id = r.pub_id;

  -- 1) base: every rating earns points
  insert into xp_events (profile_id, group_id, type, amount, ref_id)
  values (r.profile_id, r.group_id, 'rate_pub', 50, r.id)
  on conflict (profile_id, type, ref_id) do nothing;

  -- 2) first to map this pub in the group
  if not exists (
    select 1 from ratings r2
    where r2.pub_id = r.pub_id
      and (r2.created_at, r2.id) < (r.created_at, r.id)
  ) then
    insert into xp_events (profile_id, group_id, type, amount, ref_id)
    values (r.profile_id, r.group_id, 'first_map', 10, r.id)
    on conflict (profile_id, type, ref_id) do nothing;
  end if;

  -- 3) first pub you've rated in this area
  if v_area is not null and not exists (
    select 1 from ratings r2
    join pubs p2 on p2.id = r2.pub_id
    where r2.profile_id = r.profile_id
      and r2.group_id   = r.group_id
      and nullif(lower(btrim(p2.area)), '') = v_area
      and (r2.created_at, r2.id) < (r.created_at, r.id)
  ) then
    insert into xp_events (profile_id, group_id, type, amount, ref_id)
    values (r.profile_id, r.group_id, 'new_area', 20, r.id)
    on conflict (profile_id, type, ref_id) do nothing;
  end if;

  -- 4) wrote a note
  if coalesce(btrim(r.note), '') <> '' then
    insert into xp_events (profile_id, group_id, type, amount, ref_id)
    values (r.profile_id, r.group_id, 'with_note', 10, r.id)
    on conflict (profile_id, type, ref_id) do nothing;
  end if;

  -- 5) added a photo (lands on a later UPDATE — the trigger below is what makes
  --    this reachable at all)
  if coalesce(btrim(r.photo_path), '') <> '' then
    insert into xp_events (profile_id, group_id, type, amount, ref_id)
    values (r.profile_id, r.group_id, 'with_photo', 10, r.id)
    on conflict (profile_id, type, ref_id) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------- trigger
-- The actual fix. Dropped and recreated (rather than `create if not exists`)
-- because the existing one is INSERT-only and there is no way to widen a
-- trigger's event list in place. award_xp_on_rating() itself is already current
-- — 0007 replaced it — and fans out to XP + data-only + geo + title badges.
drop trigger if exists ratings_award_xp on ratings;
create trigger ratings_award_xp after insert or update on ratings
  for each row execute function award_xp_on_rating();

-- ============================================================================
-- Backfill: re-evaluate every existing rating now that edits count. This is what
-- retroactively pays out the note/photo bonuses and the Journalist badges that
-- the INSERT-only trigger has been dropping. Idempotent + order-independent
-- (every award is on-conflict-do-nothing), so re-running is harmless and
-- already-earned rows keep their original created_at.
-- ============================================================================
select award_xp_for_rating(id)                from ratings order by created_at, id;
select award_achievements_for_rating(id)      from ratings order by created_at, id;
select award_geo_achievements_for_rating(id)  from ratings order by created_at, id;
select award_title_achievements_for_rating(id) from ratings order by created_at, id;
