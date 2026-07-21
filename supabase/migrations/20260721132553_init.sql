-- ============================================================================
-- PlotMyPub → Supabase  ·  Phase 1: schema, security functions, RLS
-- ----------------------------------------------------------------------------
-- Locked decisions baked in:
--   #7/#8  Identity: profiles hold display names, UNIQUE GLOBALLY and
--          case/space-insensitively (matches the old normaliseName_ dedupe).
--          Legacy rows migrate as "unclaimed" profiles (user_id NULL).
--   #1     All existing Sheet data lands in one default group ("Rookery").
--          Group NAME is editable — everything keys off groups.id (uuid).
--   #6     invite_code is permanent; rotation later is additive, no rewrite.
--   Multi-group: group_members is a real many-to-many from day one.
--
-- Run order: paste into a new migration, then `npx supabase db push`.
-- ============================================================================

-- Case-insensitive name matching backstop (we still normalise in the RPC).
create extension if not exists citext;

-- ---------------------------------------------------------------- tables

-- profiles: one per person. user_id NULL = migrated-from-Sheet, not yet claimed.
create table profiles (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid unique references auth.users (id) on delete set null,
  display_name text not null,
  created_at   timestamptz not null default now()
);

-- Global uniqueness, case- AND whitespace-insensitive: "tommy" == "Tommy ".
create unique index profiles_name_norm_uidx
  on profiles (lower(regexp_replace(btrim(display_name), '\s+', ' ', 'g')));

-- groups: name is a mutable label; invite_code is the permanent join word.
create table groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  invite_code text not null,
  created_by  uuid references profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Codes match case-insensitively so "Rookery" and "rookery" are the same.
create unique index groups_code_uidx on groups (lower(invite_code));

-- group_members: the M2M that RLS scopes everything to.
create table group_members (
  group_id   uuid not null references groups (id)   on delete cascade,
  profile_id uuid not null references profiles (id) on delete cascade,
  role       text not null default 'member',        -- room for 'owner' later
  joined_at  timestamptz not null default now(),
  primary key (group_id, profile_id)
);

-- pubs: group-scoped. Same physical pub in two groups = two rows (fine).
create table pubs (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references groups (id) on delete cascade,
  name       text not null,
  area       text,
  lat        double precision,
  lng        double precision,
  place_id   text,
  created_at timestamptz not null default now(),
  -- lets ratings pin (pub_id, group_id) together so they can never drift apart
  constraint pubs_id_group_uk unique (id, group_id)
);
create index pubs_group_idx on pubs (group_id);

-- Dedupe the same pub within a group on Google place_id.
create unique index pubs_group_place_uidx
  on pubs (group_id, place_id) where place_id is not null;

-- ratings: replaces "one row per author+pub". One per (pub, profile).
create table ratings (
  id         uuid primary key default gen_random_uuid(),
  pub_id     uuid not null,
  group_id   uuid not null,
  profile_id uuid not null references profiles (id) on delete cascade,
  location   numeric(3,1) not null check (location   between 0 and 5),
  beer       numeric(3,1) not null check (beer       between 0 and 5),
  value      numeric(3,1) not null check (value      between 0 and 5),
  facilities numeric(3,1) not null check (facilities between 0 and 5),
  vibe       numeric(3,1) not null check (vibe       between 0 and 5),
  note       text,                       -- provisional: see note at bottom
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pub_id, profile_id),           -- re-rating your own pub updates in place
  -- composite FK => a rating's group_id ALWAYS equals its pub's group_id
  foreign key (pub_id, group_id) references pubs (id, group_id) on delete cascade
);
create index ratings_group_idx on ratings (group_id);
create index ratings_pub_idx   on ratings (pub_id);

-- keep updated_at honest on re-rates
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger ratings_touch before update on ratings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------- averaging view
-- Replaces the hand-rolled averaging in getPubs(). security_invoker = on means
-- the view honours the querying user's RLS instead of bypassing it (PG15+).

create view pub_scores with (security_invoker = on) as
select
  p.id as pub_id, p.group_id,
  p.name, p.area, p.lat, p.lng, p.place_id,
  count(r.id)                                                     as raters,
  avg((r.location + r.beer + r.value + r.facilities + r.vibe)
      / 25.0 * 10)                                                as score,
  avg(r.location)   as location,
  avg(r.beer)       as beer,
  avg(r.value)      as value,
  avg(r.facilities) as facilities,
  avg(r.vibe)       as vibe
from pubs p
left join ratings r on r.pub_id = p.id
group by p.id;

-- ---------------------------------------------------------------- security helpers
-- security definer so they can see the membership tables regardless of the
-- caller's RLS; search_path pinned to public to keep them injection-safe.

create or replace function current_profile_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from profiles where user_id = auth.uid()
$$;

create or replace function is_group_member(gid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from group_members gm
    where gm.group_id = gid and gm.profile_id = current_profile_id()
  )
$$;

-- Do the current user and profile `pid` share any group? (drives profile reads)
create or replace function shares_group_with(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from group_members a
    join group_members b on a.group_id = b.group_id
    where a.profile_id = current_profile_id()
      and b.profile_id = pid
  )
$$;

-- ---------------------------------------------------------------- account RPCs
-- Called from the Phase 3 auth UI. Kept server-side so clients never need broad
-- read/write on profiles, groups, or membership.

-- Claim a matching unclaimed legacy name, or create a fresh profile.
create or replace function claim_or_create_profile(p_name text)
returns profiles
language plpgsql security definer set search_path = public as $$
declare
  norm text := lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g'));
  prof profiles;
begin
  if norm = '' then raise exception 'Name is required.'; end if;

  select * into prof from profiles
   where lower(regexp_replace(btrim(display_name), '\s+', ' ', 'g')) = norm;

  if found then
    if prof.user_id is null then                 -- unclaimed legacy name -> claim it
      update profiles set user_id = auth.uid() where id = prof.id returning * into prof;
    elsif prof.user_id <> auth.uid() then        -- taken by someone else
      raise exception 'The name "%" is already taken.', btrim(p_name);
    end if;                                       -- else: already yours, return as-is
    return prof;
  end if;

  insert into profiles (user_id, display_name)
  values (auth.uid(), regexp_replace(btrim(p_name), '\s+', ' ', 'g'))
  returning * into prof;
  return prof;
end $$;

-- Create a group and drop the creator in as its first member.
create or replace function create_group(p_name text, p_invite_code text)
returns groups
language plpgsql security definer set search_path = public as $$
declare g groups; me uuid := current_profile_id();
begin
  if me is null then raise exception 'Sign in and pick a name first.'; end if;
  insert into groups (name, invite_code, created_by)
  values (btrim(p_name), btrim(p_invite_code), me) returning * into g;
  insert into group_members (group_id, profile_id, role) values (g.id, me, 'owner');
  return g;
end $$;

-- Join a group by its permanent invite word.
create or replace function join_group(p_code text)
returns groups
language plpgsql security definer set search_path = public as $$
declare g groups; me uuid := current_profile_id();
begin
  if me is null then raise exception 'Sign in and pick a name first.'; end if;
  select * into g from groups where lower(invite_code) = lower(btrim(p_code));
  if not found then raise exception 'No group found for that code.'; end if;
  insert into group_members (group_id, profile_id)
  values (g.id, me) on conflict do nothing;
  return g;
end $$;

-- ---------------------------------------------------------------- RLS

alter table profiles      enable row level security;
alter table groups        enable row level security;
alter table group_members enable row level security;
alter table pubs          enable row level security;
alter table ratings       enable row level security;

-- profiles: see yourself and anyone you share a group with. Writes go through
-- claim_or_create_profile(), so no direct insert policy is exposed.
create policy profiles_read on profiles for select to authenticated
  using (id = current_profile_id() or shares_group_with(id));
create policy profiles_update_self on profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- groups: members can read; members can rename (tighten to 'owner' later).
create policy groups_read on groups for select to authenticated
  using (is_group_member(id));
create policy groups_update on groups for update to authenticated
  using (is_group_member(id)) with check (is_group_member(id));

-- group_members: members see their group's roster. Joins go through join_group().
create policy members_read on group_members for select to authenticated
  using (is_group_member(group_id));

-- pubs: full CRUD, scoped to groups you belong to.
create policy pubs_read on pubs for select to authenticated
  using (is_group_member(group_id));
create policy pubs_write on pubs for insert to authenticated
  with check (is_group_member(group_id));
create policy pubs_update on pubs for update to authenticated
  using (is_group_member(group_id)) with check (is_group_member(group_id));
create policy pubs_delete on pubs for delete to authenticated
  using (is_group_member(group_id));

-- ratings: read anything in your groups; only ever write/edit your own.
create policy ratings_read on ratings for select to authenticated
  using (is_group_member(group_id));
create policy ratings_insert on ratings for insert to authenticated
  with check (is_group_member(group_id) and profile_id = current_profile_id());
create policy ratings_update on ratings for update to authenticated
  using (profile_id = current_profile_id())
  with check (profile_id = current_profile_id());
create policy ratings_delete on ratings for delete to authenticated
  using (profile_id = current_profile_id());

-- ---------------------------------------------------------------- grants
-- PostgREST reaches these as the `authenticated` role; RLS above does the gating.

grant usage on schema public to authenticated;
grant select, insert, update, delete
  on profiles, groups, group_members, pubs, ratings to authenticated;
grant select on pub_scores to authenticated;
grant execute on function
  current_profile_id(), is_group_member(uuid), shares_group_with(uuid),
  claim_or_create_profile(text), create_group(text, text), join_group(text)
  to authenticated;

-- ============================================================================
-- NOTE on ratings.note — this is a PROVISIONAL placeholder for the "notes"
-- To-Do. You were adding notes (and maybe photos) in the old stack; once you
-- send the drifted code.gs/page.html I'll reconcile this with the real shape
-- (a single per-rating note vs. per-pub / multiple / threaded). Photos are
-- Phase 6 and get their own table + Storage bucket — not this column.
-- ============================================================================