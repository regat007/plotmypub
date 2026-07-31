-- ============================================================================
-- PlotMyPub → Supabase  ·  Phase 8b: close the openness holes
-- ----------------------------------------------------------------------------
-- The init migration left four ways in that nobody intended:
--
--   1. GUESSABLE INVITE WORDS. join_group matches any word, case-insensitively,
--      with no rate limit. Guess "rookery" and you're inside a stranger's group,
--      reading their pub locations and photos.
--   2. ANY MEMBER COULD RE-KEY A GROUP. groups_update only checked
--      is_group_member, so a member could rename the group or change its invite
--      code out from under everyone else.
--   3. ANY MEMBER COULD DELETE ANY PUB. pubs_delete checked membership only, and
--      the (pub_id, group_id) composite FK cascades — one delete takes every
--      other member's ratings of that pub with it.
--   4. THE role COLUMN WAS DECORATIVE. create_group wrote 'owner' and nothing,
--      anywhere, ever read it.
--
-- Fixed here in that order. Nothing in the current client calls pub delete or
-- group rename, so tightening those breaks no existing UI. Creating a group DOES
-- change shape: the code is now generated, not typed — see the shim at the
-- bottom which keeps old cached clients working.
--
-- Existing weak invite codes are deliberately NOT auto-rotated: that would
-- invalidate every link already shared and could strand someone mid-join. The
-- admin console flags them instead and rotating is one tap.
--
-- Apply: npx supabase db push   (after 0011_admin.sql)
-- ============================================================================


-- ============================================================================
--  4. MAKE `role` MEAN SOMETHING
-- ============================================================================

create or replace function is_group_owner(gid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from group_members gm
    where gm.group_id = gid
      and gm.profile_id = current_profile_id()
      and gm.role = 'owner'
  )
$$;

-- Backfill, in two passes, so no existing group ends up unadministrable.

-- (a) the recorded creator, where they're still a member
update group_members gm
   set role = 'owner'
  from groups g
 where g.id = gm.group_id
   and g.created_by = gm.profile_id
   and gm.role <> 'owner';

-- (b) any group STILL without an owner (creator left, or created_by was nulled
--     by the on-delete-set-null): promote the earliest joiner.
with ownerless as (
  select g.id as group_id
  from groups g
  where not exists (
    select 1 from group_members gm
    where gm.group_id = g.id and gm.role = 'owner'
  )
),
first_in as (
  select distinct on (gm.group_id) gm.group_id, gm.profile_id
  from group_members gm
  join ownerless o on o.group_id = gm.group_id
  order by gm.group_id, gm.joined_at, gm.profile_id
)
update group_members gm
   set role = 'owner'
  from first_in f
 where gm.group_id = f.group_id and gm.profile_id = f.profile_id;


-- ============================================================================
--  2. OWNER-ONLY GROUP EDITS, AND ONLY THE NAME
-- ============================================================================

-- Policy: owners (or an app admin) may update a group at all.
drop policy if exists groups_update on groups;
create policy groups_update on groups for update to authenticated
  using      (is_group_owner(id) or is_app_admin())
  with check (is_group_owner(id) or is_app_admin());

-- Grant: and even then, only `name` is directly writable. invite_code has to go
-- through rotate_invite_code() below, so a well-meaning owner can't set the code
-- back to something short and guessable — which is hole #1 all over again.
-- (RLS can't restrict columns; GRANTs can.)
revoke update on groups from authenticated;
grant  update (name) on groups to authenticated;


-- ============================================================================
--  3. OWNER-ONLY PUB DELETION
-- ============================================================================
-- Reads and writes stay open to all members; only the destructive verb narrows.

drop policy if exists pubs_delete on pubs;
create policy pubs_delete on pubs for delete to authenticated
  using (is_group_owner(group_id) or is_app_admin());


-- ============================================================================
--  1. UNGUESSABLE INVITE CODES
-- ============================================================================
-- Shape: adjective-noun-NNNN, e.g. "amber-heron-4823". Still readable down a
-- pub and typeable into the gate, but drawn from 32 x 32 x 10000 = ~10.2M
-- combinations instead of the handful of words a person would actually pick.
-- Paired with the join throttle below, guessing is not a practical attack.

create or replace function gen_invite_code() returns text
language plpgsql volatile set search_path = public as $$
declare
  adj  text[] := array[
    'amber','brass','copper','dusty','golden','hazy','ivory','jolly',
    'lucky','misty','nutty','oaken','rusty','silver','smoky','velvet',
    'bitter','crisp','frosty','hoppy','malty','mellow','ruby','stout',
    'quiet','rowdy','snug','sunlit','twilit','wandering','winding','yeasty'
  ];
  noun text[] := array[
    'anchor','badger','barrel','bishop','cellar','crown','falcon','ferret',
    'flagon','goose','greyhound','harrow','heron','hound','kettle','lantern',
    'magpie','mariner','otter','plough','raven','saddle','sextant','spaniel',
    'stag','tankard','thistle','vintner','wagon','whistle','windlass','yardarm'
  ];
  code text;
begin
  -- Retry on the (very unlikely) collision with an existing code.
  for i in 1..40 loop
    code := adj [1 + floor(random() * array_length(adj,  1))::int] || '-' ||
            noun[1 + floor(random() * array_length(noun, 1))::int] || '-' ||
            lpad(floor(random() * 10000)::int::text, 4, '0');
    if not exists (select 1 from groups where lower(invite_code) = lower(code)) then
      return code;
    end if;
  end loop;

  -- Pathological fallback: no wordlist, just entropy.
  return 'pmp-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12);
end $$;


-- ---------------------------------------------------------------- rotation
-- Owners can re-key their own group; admins can re-key any. Old links stop
-- working immediately — that's the point, it's the "someone got in" button.

create or replace function rotate_invite_code(p_group_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare old_code text; new_code text;
begin
  if not (is_group_owner(p_group_id) or is_app_admin()) then
    raise exception 'Only the group owner can change the invite word.'
      using errcode = '42501';
  end if;

  select invite_code into old_code from groups where id = p_group_id;
  if old_code is null then raise exception 'No such group.'; end if;

  new_code := gen_invite_code();
  update groups set invite_code = new_code where id = p_group_id;

  -- Audited only when an admin does it; owners re-keying their own group is
  -- ordinary use, not moderation.
  if is_app_admin() then
    perform log_admin('rotate_invite', 'group', p_group_id,
                      jsonb_build_object('from', old_code, 'to', new_code));
  end if;

  return new_code;
end $$;


-- ---------------------------------------------------------------- creation
-- New signature: the caller names the group, the server picks the code.

create or replace function create_group(p_name text) returns groups
language plpgsql security definer set search_path = public as $$
declare g groups; me uuid := current_profile_id();
begin
  if me is null then raise exception 'Sign in and pick a name first.'; end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Give the group a name.';
  end if;

  insert into groups (name, invite_code, created_by)
  values (btrim(p_name), gen_invite_code(), me)
  returning * into g;

  insert into group_members (group_id, profile_id, role)
  values (g.id, me, 'owner');

  return g;
end $$;

-- Back-compat shim. A client cached before this deploy still calls the two-arg
-- form; rather than erroring at them, accept the call and IGNORE the typed word,
-- so even a stale client can't mint a weak code. Delete this once you're
-- confident every install has updated.
create or replace function create_group(p_name text, p_invite_code text)
returns groups
language plpgsql security definer set search_path = public as $$
begin
  return create_group(p_name);
end $$;


-- ============================================================================
--  1b. BRUTE-FORCE THROTTLE ON JOINING
-- ============================================================================
-- Entropy alone isn't a control if an attacker can try codes in a loop. Log
-- every attempt and refuse once someone has burned through MAX_FAILS misses in
-- an hour. Successes don't count against the limit, so a person legitimately
-- joining several groups is never blocked.
--
-- NOTE ON THE RETURN CONTRACT: a bad code now RETURNS NULL instead of raising.
-- It has to. `raise` aborts the transaction, which would roll back the very row
-- that records the failed attempt — the counter would sit at zero forever and
-- the throttle would be decorative. Returning null lets the insert commit.
-- Callers must therefore treat a null result as "no such code"; see the
-- `error || !data` checks in js/auth.mjs and js/map.mjs.

create table if not exists join_attempts (
  id         bigserial primary key,
  user_id    uuid not null default auth.uid(),
  ok         boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists join_attempts_user_idx
  on join_attempts (user_id, created_at desc);

-- No policies and no grants: only the security-definer join_group touches it.
alter table join_attempts enable row level security;

create or replace function join_group(p_code text) returns groups
language plpgsql security definer set search_path = public as $$
declare
  MAX_FAILS constant int := 10;
  g groups;
  me uuid := current_profile_id();
  fails int;
begin
  if me is null then raise exception 'Sign in and pick a name first.'; end if;

  select count(*) into fails
  from join_attempts
  where user_id = auth.uid()
    and not ok
    and created_at > now() - interval '1 hour';

  -- Safe to raise here: we haven't written anything this call, so there is
  -- nothing for the rollback to lose.
  if fails >= MAX_FAILS then
    raise exception 'Too many failed attempts. Try again in an hour.'
      using errcode = '42901';
  end if;

  select * into g from groups
   where lower(invite_code) = lower(btrim(p_code));

  -- Miss: record it and return null. Do NOT raise — see the note above.
  if not found then
    insert into join_attempts (ok) values (false);
    return null;
  end if;

  insert into join_attempts (ok) values (true);

  insert into group_members (group_id, profile_id)
  values (g.id, me)
  on conflict do nothing;

  return g;
end $$;

-- Housekeeping: attempts older than a day are of no further use.
create or replace function prune_join_attempts() returns void
language sql security definer set search_path = public as $$
  delete from join_attempts where created_at < now() - interval '1 day'
$$;
revoke execute on function prune_join_attempts() from public, authenticated;


-- ============================================================================
--  admin view of the invite-code health (used by the console's Rotate button)
-- ============================================================================

create or replace function admin_rotate_invite(p_group_id uuid) returns text
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  return rotate_invite_code(p_group_id);
end $$;


-- ---------------------------------------------------------------- grants

-- gen_invite_code() is deliberately NOT granted: it is only ever called from
-- inside the definer functions above, which run as the owner.
grant execute on function
  is_group_owner(uuid),
  rotate_invite_code(uuid),
  create_group(text),
  create_group(text, text),
  join_group(text),
  admin_rotate_invite(uuid)
  to authenticated;
