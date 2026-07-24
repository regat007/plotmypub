-- ============================================================================
-- PlotMyPub → Supabase  ·  Phase 1: XP ledger (levels foundation)
-- ----------------------------------------------------------------------------
-- Locked decisions baked in:
--   • Server-authoritative XP. Clients only ever READ xp_events; every point is
--     awarded by a security-definer trigger on `ratings`, so nothing is forgeable.
--   • Idempotent ledger. UNIQUE (profile_id, type, ref_id) + `on conflict do
--     nothing` means a re-synced/duplicate rating never double-awards, and the
--     backfill below is safe to re-run.
--   • One source of truth. award_xp_for_rating(uuid) holds ALL earning logic and
--     is called by both the live trigger and the historical backfill. Its "is
--     there an earlier rating?" tests are absolute (ordered by created_at, id),
--     so it gives the same answer live or in bulk.
--   • Group-scoped, like everything else. XP totals are per (profile, group).
--   • Level/tier is NOT stored — it's a pure formula over SUM(amount) in the
--     client, so it can be retuned without a migration.
--
--   ratings upserts on (pub_id, profile_id): first submit = INSERT, later edits
--   = UPDATE. The trigger fires on both; the award fn is idempotent so the base
--   is never re-awarded, but a note/photo added on a later edit still earns.
--
-- Run order: `npx supabase db push` (backfill at the bottom runs on apply).
-- ============================================================================

-- ---------------------------------------------------------------- table
create table xp_events (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  group_id   uuid not null references groups   (id) on delete cascade,
  type       text not null,          -- 'rate_pub' | 'first_map' | 'new_area' | 'with_note' | (later) 'achievement'
  amount     integer not null,
  ref_id     uuid,                   -- the rating id: the idempotency anchor (null reserved for future non-rating types)
  meta       jsonb not null default '{}'::jsonb,   -- room for future "lots more ideas" without schema churn
  created_at timestamptz not null default now(),
  -- one row per (person, reason, source event): the whole anti-double-award guarantee
  unique (profile_id, type, ref_id)
);
create index xp_events_profile_group_idx on xp_events (profile_id, group_id);

-- ---------------------------------------------------------------- totals view
-- Per-person, per-group running total. security_invoker => honours the caller's
-- RLS (they can only see groups they belong to).
create view xp_totals with (security_invoker = on) as
select
  profile_id,
  group_id,
  sum(amount)::int as xp,
  count(*)::int    as events,
  max(created_at)  as last_at
from xp_events
group by profile_id, group_id;

-- ---------------------------------------------------------------- award logic
-- The single source of truth for "what did this rating earn?". SECURITY DEFINER
-- so it can write xp_events regardless of the caller's RLS; search_path pinned.
-- Every insert is on-conflict-do-nothing => calling it twice is a no-op.
--
-- Point values live here, together, easy to retune (users never see raw points):
--     rate_pub   50   base — every rating earns, unconditionally (CR "just play")
--     first_map  10   first person in the group to map this pub (the pioneer)
--     new_area   20   first pub you've rated in this area (exploration)
--     with_note  10   you wrote a note
--     with_photo 10   you added a photo (often lands on a later UPDATE)
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

  -- 5) added a photo (often lands on a later UPDATE — the trigger covers that)
  if coalesce(btrim(r.photo_path), '') <> '' then
    insert into xp_events (profile_id, group_id, type, amount, ref_id)
    values (r.profile_id, r.group_id, 'with_photo', 10, r.id)
    on conflict (profile_id, type, ref_id) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------- trigger
-- Fires on INSERT (first submit) and UPDATE. The award function is idempotent
-- (on-conflict-do-nothing), so re-rates never double-award the base; UPDATE
-- coverage is what lets a note or photo added *after* the first submit earn.
create or replace function award_xp_on_rating() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform award_xp_for_rating(new.id);
  return null;  -- AFTER trigger: return value is ignored
end $$;

create trigger ratings_award_xp after insert or update on ratings
  for each row execute function award_xp_on_rating();

-- ---------------------------------------------------------------- RLS
-- Read anything in your groups (drives your own feed + future leaderboards).
-- No insert/update/delete policies: only the security-definer trigger writes,
-- so XP can never be forged or edited from a client.
alter table xp_events enable row level security;
create policy xp_events_read on xp_events for select to authenticated
  using (is_group_member(group_id));

-- ---------------------------------------------------------------- grants
grant select on xp_events to authenticated;
grant select on xp_totals to authenticated;
-- award_xp_for_rating / award_xp_on_rating are intentionally NOT granted to
-- authenticated: the trigger runs them as definer; nobody calls them directly.

-- ============================================================================
-- Backfill: award XP for every rating that already exists. Idempotent (each
-- award is on-conflict-do-nothing) and order-independent (predicates compare
-- created_at absolutely), so re-running is harmless.
-- ============================================================================
select award_xp_for_rating(id) from ratings order by created_at, id;
