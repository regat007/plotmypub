-- ============================================================================
-- PlotMyPub → Supabase  ·  Phase 4b: pinned badges on your profile
-- ----------------------------------------------------------------------------
-- Lets each person pin up to 3 earned badges to their Me tab / profile. Stored
-- as an ordered array of achievement codes (matches js/achievements.mjs). No new
-- RLS needed: the existing profiles_update_self policy already lets you edit your
-- own row, and the client caps the array at 3. Readable by group-mates (the
-- profiles_read policy), so pinned badges can later show on others' profiles too.
-- ============================================================================

alter table profiles
  add column if not exists pinned_badges text[] not null default '{}';
