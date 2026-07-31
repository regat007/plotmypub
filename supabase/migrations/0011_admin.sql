-- ============================================================================
-- PlotMyPub → Supabase  ·  Phase 8a: app admin (global visibility + moderation)
-- ----------------------------------------------------------------------------
-- The problem this solves: RLS scopes every read to groups you belong to, so
-- the app owner is structurally blind to the rest of the instance. There is no
-- service_role key available either — the client is a static GitHub Pages site
-- shipping the publishable anon key — so "admin" cannot mean "a privileged key
-- in the browser". It has to mean:
--
--   1. a flag on the profile that the user CANNOT set themselves, and
--   2. security-definer RPCs that check that flag before returning anything.
--
-- Table RLS is deliberately left untouched. Admins get their global view only
-- through the functions below, never through a widened policy, so a bug in one
-- report can't silently open up ordinary client queries.
--
-- Bootstrapping: is_admin defaults false and nothing in the app can flip it.
-- Grant yourself admin ONCE from the Supabase SQL editor:
--
--   update profiles set is_admin = true where display_name = 'Your Name';
--
-- After that, admin_set_admin() below can promote/demote others.
--
-- Apply: npx supabase db push
-- ============================================================================

-- ---------------------------------------------------------------- the flag

alter table profiles
  add column if not exists is_admin boolean not null default false;


-- ---------------------------------------------------------------- ESCALATION FIX
-- profiles_update_self (init migration) lets you UPDATE your own profile row,
-- and the blanket `grant update on profiles` covers every column. Adding
-- is_admin to that table would therefore let any signed-in user promote
-- themselves with a one-line PostgREST call:
--
--   sb.from('profiles').update({ is_admin: true }).eq('user_id', <me>)
--
-- RLS policies can't restrict columns, but GRANTs can. Narrow the write surface
-- to exactly the two columns the client legitimately edits. Everything else on
-- profiles becomes read-only to `authenticated`, including is_admin.

revoke update on profiles from authenticated;
grant  update (display_name, pinned_badges) on profiles to authenticated;


-- ---------------------------------------------------------------- gate helper
-- security definer so it can read profiles.is_admin regardless of the caller's
-- own RLS; search_path pinned, matching the existing helpers.

create or replace function is_app_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.is_admin from profiles p where p.user_id = auth.uid()),
    false
  )
$$;

-- Raise a clean 403 rather than leaking data. Every function below opens with it.
create or replace function require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_app_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
end $$;


-- ---------------------------------------------------------------- audit log
-- Every write an admin makes lands here. Append-only from the app's point of
-- view: no insert/update/delete grant to `authenticated`, so rows can only be
-- written by the security-definer actions below.

create table if not exists admin_audit (
  id               uuid primary key default gen_random_uuid(),
  actor_profile_id uuid references profiles (id) on delete set null,
  action           text not null,
  target_type      text,
  target_id        uuid,
  detail           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists admin_audit_created_idx on admin_audit (created_at desc);

alter table admin_audit enable row level security;

-- Admins read it in the console; nobody writes it directly.
drop policy if exists admin_audit_read on admin_audit;
create policy admin_audit_read on admin_audit for select to authenticated
  using (is_app_admin());

grant select on admin_audit to authenticated;

-- Internal helper. NOT granted to `authenticated` — it is only ever reached
-- from the definer functions below, which run as the function owner.
create or replace function log_admin(
  p_action text, p_target_type text, p_target_id uuid, p_detail jsonb
) returns void
language sql security definer set search_path = public as $$
  insert into admin_audit (actor_profile_id, action, target_type, target_id, detail)
  values (current_profile_id(), p_action, p_target_type, p_target_id,
          coalesce(p_detail, '{}'::jsonb))
$$;
revoke execute on function log_admin(text, text, uuid, jsonb) from public, authenticated;


-- ============================================================================
--  READ SIDE
--  Each returns jsonb so PostgREST hands the client a ready-shaped object and
--  we never have to declare column lists at the call site.
-- ============================================================================

-- ---------------------------------------------------------------- overview
-- The numbers that answer "what is actually going on out there".

create or replace function admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare j jsonb;
begin
  perform require_admin();

  select jsonb_build_object(
    'groups',        (select count(*) from groups),
    'people',        (select count(*) from profiles),
    'claimed',       (select count(*) from profiles where user_id is not null),
    'admins',        (select count(*) from profiles where is_admin),
    'pubs',          (select count(*) from pubs),
    'ratings',       (select count(*) from ratings),
    'photos',        (select count(*) from ratings where photo_path is not null),
    'notes',         (select count(*) from ratings
                       where coalesce(btrim(note), '') <> ''),
    'new_people_7d', (select count(*) from profiles
                       where created_at > now() - interval '7 days'),
    'new_groups_7d', (select count(*) from groups
                       where created_at > now() - interval '7 days'),
    'ratings_7d',    (select count(*) from ratings
                       where created_at > now() - interval '7 days'),
    'ratings_30d',   (select count(*) from ratings
                       where created_at > now() - interval '30 days'),
    'active_7d',     (select count(distinct profile_id) from ratings
                       where created_at > now() - interval '7 days'),
    'active_30d',    (select count(distinct profile_id) from ratings
                       where created_at > now() - interval '30 days'),
    -- groups still on a short, human-chosen (therefore guessable) invite word.
    -- 0012 generates 16-char codes; anything well under that predates it.
    'weak_codes',    (select count(*) from groups where length(invite_code) < 12),
    -- groups nobody can administer, because no member holds the 'owner' role
    'ownerless',     (select count(*) from groups g where not exists (
                        select 1 from group_members gm
                        where gm.group_id = g.id and gm.role = 'owner')),
    'last_rating_at',(select max(created_at) from ratings),
    -- 30-day rating sparkline, zero-filled so the chart has no gaps
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object('d', d.day, 'n', coalesce(c.n, 0))
                                order by d.day), '[]'::jsonb)
      from generate_series(
             (current_date - interval '29 days')::date, current_date, interval '1 day'
           ) as d(day)
      left join (
        select date_trunc('day', created_at)::date as day, count(*) as n
        from ratings where created_at > now() - interval '30 days'
        group by 1
      ) c on c.day = d.day::date
    )
  ) into j;

  return j;
end $$;


-- ---------------------------------------------------------------- all groups
-- One row per group in the whole instance: size, activity, and the two health
-- flags (weak invite code, no owner) the console surfaces as warnings.

create or replace function admin_groups() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare j jsonb;
begin
  perform require_admin();

  select coalesce(jsonb_agg(to_jsonb(t) order by t.last_at desc nulls last), '[]'::jsonb)
    into j
  from (
    select
      g.id,
      g.name,
      g.invite_code,
      g.created_at,
      cr.display_name                                             as created_by,
      (select count(*) from group_members gm where gm.group_id = g.id)  as members,
      (select count(*) from group_members gm
        where gm.group_id = g.id and gm.role = 'owner')                 as owners,
      (select count(*) from pubs p where p.group_id = g.id)             as pubs,
      (select count(*) from ratings r where r.group_id = g.id)          as ratings,
      (select count(*) from ratings r
        where r.group_id = g.id and r.photo_path is not null)           as photos,
      (select max(r.created_at) from ratings r where r.group_id = g.id) as last_at,
      (length(g.invite_code) < 12)                                      as weak_code
    from groups g
    left join profiles cr on cr.id = g.created_by
  ) t;

  return j;
end $$;


-- ---------------------------------------------------------------- one group
-- Drill-down: the roster (with per-member counts and XP) plus this group's pubs
-- and its recent ratings, including note text and whether a photo is attached —
-- the things you'd actually want to look at when moderating.

create or replace function admin_group(p_group_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare j jsonb;
begin
  perform require_admin();

  select jsonb_build_object(
    'group', (
      select to_jsonb(x) from (
        select g.id, g.name, g.invite_code, g.created_at,
               cr.display_name as created_by,
               (length(g.invite_code) < 12) as weak_code
        from groups g
        left join profiles cr on cr.id = g.created_by
        where g.id = p_group_id
      ) x
    ),
    'members', (
      select coalesce(jsonb_agg(to_jsonb(m) order by m.ratings desc, m.name), '[]'::jsonb)
      from (
        select
          pr.id, pr.display_name as name, pr.is_admin,
          (pr.user_id is not null)                                as claimed,
          gm.role, gm.joined_at,
          (select count(*) from ratings r
            where r.group_id = p_group_id and r.profile_id = pr.id)     as ratings,
          (select max(r.created_at) from ratings r
            where r.group_id = p_group_id and r.profile_id = pr.id)     as last_at,
          coalesce((select sum(e.amount) from xp_events e
            where e.group_id = p_group_id and e.profile_id = pr.id), 0) as xp
        from group_members gm
        join profiles pr on pr.id = gm.profile_id
        where gm.group_id = p_group_id
      ) m
    ),
    'pubs', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.ratings desc, p.name), '[]'::jsonb)
      from (
        select pb.id, pb.name, pb.area, pb.lat, pb.lng, pb.created_at,
               (select count(*) from ratings r where r.pub_id = pb.id) as ratings
        from pubs pb where pb.group_id = p_group_id
      ) p
    ),
    'ratings', (
      select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
      from (
        select ra.id, ra.created_at, ra.note, ra.photo_path,
               pb.name as pub, pr.display_name as author, pr.id as profile_id,
               round(((ra.location + ra.beer + ra.value + ra.facilities + ra.vibe)
                      / 25.0 * 10)::numeric, 1) as score
        from ratings ra
        join pubs pb     on pb.id = ra.pub_id
        join profiles pr on pr.id = ra.profile_id
        where ra.group_id = p_group_id
        order by ra.created_at desc
        limit 100
      ) r
    )
  ) into j;

  return j;
end $$;


-- ---------------------------------------------------------------- global feed
-- Every rating across every group, newest first. Keyset-paged on created_at so
-- "load more" stays correct as new rows land mid-scroll.

create or replace function admin_activity(
  p_limit int default 50, p_before timestamptz default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare j jsonb;
begin
  perform require_admin();

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb)
    into j
  from (
    select ra.id, ra.created_at, ra.note, ra.photo_path,
           pb.name as pub, pb.area,
           pr.display_name as author, pr.id as profile_id,
           g.name as group_name, g.id as group_id,
           round(((ra.location + ra.beer + ra.value + ra.facilities + ra.vibe)
                  / 25.0 * 10)::numeric, 1) as score
    from ratings ra
    join pubs pb     on pb.id = ra.pub_id
    join profiles pr on pr.id = ra.profile_id
    join groups g    on g.id  = ra.group_id
    where p_before is null or ra.created_at < p_before
    order by ra.created_at desc
    limit least(coalesce(p_limit, 50), 200)
  ) t;

  return j;
end $$;


-- ---------------------------------------------------------------- people
-- Everyone on the instance, including unclaimed legacy profiles.

create or replace function admin_people() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare j jsonb;
begin
  perform require_admin();

  select coalesce(jsonb_agg(to_jsonb(t) order by t.last_at desc nulls last), '[]'::jsonb)
    into j
  from (
    select
      pr.id, pr.display_name as name, pr.is_admin, pr.created_at,
      (pr.user_id is not null) as claimed,
      (select count(*) from group_members gm where gm.profile_id = pr.id)  as groups,
      (select count(*) from ratings r where r.profile_id = pr.id)          as ratings,
      (select count(*) from ratings r
        where r.profile_id = pr.id and r.photo_path is not null)           as photos,
      (select max(r.created_at) from ratings r where r.profile_id = pr.id) as last_at,
      (select coalesce(jsonb_agg(g.name order by g.name), '[]'::jsonb)
         from group_members gm join groups g on g.id = gm.group_id
        where gm.profile_id = pr.id)                                       as group_names
    from profiles pr
  ) t;

  return j;
end $$;


-- ---------------------------------------------------------------- audit trail

create or replace function admin_audit_log(p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare j jsonb;
begin
  perform require_admin();

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb)
    into j
  from (
    select a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at,
           pr.display_name as actor
    from admin_audit a
    left join profiles pr on pr.id = a.actor_profile_id
    order by a.created_at desc
    limit least(coalesce(p_limit, 100), 500)
  ) t;

  return j;
end $$;


-- ============================================================================
--  WRITE SIDE — every action gated, every action audited.
-- ============================================================================

-- ---------------------------------------------------------------- rename group

create or replace function admin_rename_group(p_group_id uuid, p_name text)
returns groups
language plpgsql security definer set search_path = public as $$
declare g groups; old_name text;
begin
  perform require_admin();
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Group name is required.';
  end if;

  select name into old_name from groups where id = p_group_id;
  if not found then raise exception 'No such group.'; end if;

  update groups set name = btrim(p_name) where id = p_group_id returning * into g;
  perform log_admin('rename_group', 'group', p_group_id,
                    jsonb_build_object('from', old_name, 'to', g.name));
  return g;
end $$;


-- ---------------------------------------------------------------- remove member
-- Deliberately does NOT delete their ratings — pulling someone out of a group
-- shouldn't silently wipe the group's shared history. Use admin_delete_rating
-- for content you actually want gone.

create or replace function admin_remove_member(p_group_id uuid, p_profile_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare who text; gname text;
begin
  perform require_admin();

  select pr.display_name, g.name into who, gname
  from profiles pr, groups g
  where pr.id = p_profile_id and g.id = p_group_id;
  if who is null then raise exception 'No such member or group.'; end if;

  delete from group_members
   where group_id = p_group_id and profile_id = p_profile_id;

  perform log_admin('remove_member', 'group', p_group_id,
                    jsonb_build_object('profile_id', p_profile_id,
                                       'name', who, 'group', gname));
end $$;


-- ---------------------------------------------------------------- member role

create or replace function admin_set_member_role(
  p_group_id uuid, p_profile_id uuid, p_role text
) returns void
language plpgsql security definer set search_path = public as $$
declare who text;
begin
  perform require_admin();
  if p_role not in ('owner', 'member') then
    raise exception 'Role must be owner or member.';
  end if;

  select display_name into who from profiles where id = p_profile_id;

  update group_members set role = p_role
   where group_id = p_group_id and profile_id = p_profile_id;
  if not found then raise exception 'That person is not in that group.'; end if;

  perform log_admin('set_member_role', 'group', p_group_id,
                    jsonb_build_object('profile_id', p_profile_id,
                                       'name', who, 'role', p_role));
end $$;


-- ---------------------------------------------------------------- delete rating
-- Removes the rating row. Its XP ledger entries are left in place on purpose:
-- xp_events is an append-only ledger and clawing back points retroactively
-- would silently restate everyone's level. The photo object in Storage is
-- removed by the console client (which has the admin storage policy below).

create or replace function admin_delete_rating(p_rating_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare info jsonb;
begin
  perform require_admin();

  select jsonb_build_object(
           'author', pr.display_name, 'pub', pb.name,
           'group_id', ra.group_id, 'note', ra.note,
           'photo_path', ra.photo_path)
    into info
  from ratings ra
  join pubs pb     on pb.id = ra.pub_id
  join profiles pr on pr.id = ra.profile_id
  where ra.id = p_rating_id;
  if info is null then raise exception 'No such rating.'; end if;

  delete from ratings where id = p_rating_id;
  perform log_admin('delete_rating', 'rating', p_rating_id, info);
end $$;


-- ---------------------------------------------------------------- clear photo
-- Detaches the photo from a rating while leaving the rating itself. Returns the
-- storage path so the console can delete the object too.

create or replace function admin_clear_photo(p_rating_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare path text; who text;
begin
  perform require_admin();

  select ra.photo_path, pr.display_name into path, who
  from ratings ra join profiles pr on pr.id = ra.profile_id
  where ra.id = p_rating_id;
  if path is null then return null; end if;

  update ratings set photo_path = null where id = p_rating_id;
  perform log_admin('clear_photo', 'rating', p_rating_id,
                    jsonb_build_object('path', path, 'author', who));
  return path;
end $$;


-- ---------------------------------------------------------------- grant admin
-- Self-demotion is blocked: it's the one mistake that can lock every admin out
-- of the console with no in-app way back (you'd need the SQL editor to recover).

create or replace function admin_set_admin(p_profile_id uuid, p_is_admin boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare who text;
begin
  perform require_admin();

  if p_profile_id = current_profile_id() and not p_is_admin then
    raise exception 'You cannot remove your own admin access.';
  end if;

  select display_name into who from profiles where id = p_profile_id;
  if who is null then raise exception 'No such person.'; end if;

  update profiles set is_admin = coalesce(p_is_admin, false) where id = p_profile_id;

  perform log_admin('set_admin', 'profile', p_profile_id,
                    jsonb_build_object('name', who, 'is_admin', p_is_admin));
end $$;


-- ---------------------------------------------------------------- storage
-- Let admins view and delete photos in any group, so the console can show a
-- moderation wall and actually remove an image. Both policies keep the existing
-- member rules and simply OR in the admin check.

drop policy if exists "pub_photos_read" on storage.objects;
create policy "pub_photos_read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'pub-photos'
    and (
      public.is_app_admin()
      or public.is_group_member( ((storage.foldername(name))[1])::uuid )
    )
  );

drop policy if exists "pub_photos_delete" on storage.objects;
create policy "pub_photos_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'pub-photos'
    and (
      public.is_app_admin()
      or (
        public.is_group_member( ((storage.foldername(name))[1])::uuid )
        and split_part(storage.filename(name), '.', 1)::uuid = public.current_profile_id()
      )
    )
  );


-- ---------------------------------------------------------------- grants

grant execute on function
  is_app_admin(),
  require_admin(),
  admin_overview(),
  admin_groups(),
  admin_group(uuid),
  admin_activity(int, timestamptz),
  admin_people(),
  admin_audit_log(int),
  admin_rename_group(uuid, text),
  admin_remove_member(uuid, uuid),
  admin_set_member_role(uuid, uuid, text),
  admin_delete_rating(uuid),
  admin_clear_photo(uuid),
  admin_set_admin(uuid, boolean)
  to authenticated;
