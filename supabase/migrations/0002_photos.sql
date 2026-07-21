-- ============================================================
--  PlotMyPub — Phase 6: pub photos
--  One optional photo per rating (per-author), group-scoped.
--  Apply: npx supabase db push
-- ============================================================

-- 1) Column on ratings ---------------------------------------
--    Nullable: legacy migrated ratings have no photo, and the
--    UI keeps upload optional for everyone. Stores the object
--    path within the bucket, e.g. '<group_id>/<pub_id>/<profile_id>.jpg'.
alter table public.ratings
  add column if not exists photo_path text;


-- 2) Storage bucket ------------------------------------------
--    Private (not public): reads go through short-lived signed
--    URLs so RLS actually gates access. 5 MB cap, images only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pub-photos',
  'pub-photos',
  false,
  5242880,                                  -- 5 MB
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- 3) RLS on storage.objects for this bucket ------------------
--    Path convention: '<group_id>/<pub_id>/<profile_id>.<ext>'.
--    (storage.foldername(name))[1] is the leading group_id segment;
--    gate every operation on membership of that group, mirroring
--    the table RLS pattern. Uploads/edits/deletes additionally
--    require the profile_id segment to be the caller's own profile,
--    so nobody can write over someone else's photo.
--
--    is_group_member(uuid) and current_profile_id() already exist
--    (Phase 1). Both segments are cast text -> uuid.

-- Read: any member of the group in the path may view the object.
drop policy if exists "pub_photos_read" on storage.objects;
create policy "pub_photos_read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'pub-photos'
    and public.is_group_member( ((storage.foldername(name))[1])::uuid )
  );

-- Insert: must be a member of the group AND the profile segment
-- must be the caller's own profile.
drop policy if exists "pub_photos_insert" on storage.objects;
create policy "pub_photos_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'pub-photos'
    and public.is_group_member( ((storage.foldername(name))[1])::uuid )
    and ((storage.foldername(name))[3])::uuid = public.current_profile_id()
  );

-- Update: same rule (upsert/overwrite of your own photo in place).
drop policy if exists "pub_photos_update" on storage.objects;
create policy "pub_photos_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'pub-photos'
    and public.is_group_member( ((storage.foldername(name))[1])::uuid )
    and ((storage.foldername(name))[3])::uuid = public.current_profile_id()
  )
  with check (
    bucket_id = 'pub-photos'
    and public.is_group_member( ((storage.foldername(name))[1])::uuid )
    and ((storage.foldername(name))[3])::uuid = public.current_profile_id()
  );

-- Delete: same rule.
drop policy if exists "pub_photos_delete" on storage.objects;
create policy "pub_photos_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'pub-photos'
    and public.is_group_member( ((storage.foldername(name))[1])::uuid )
    and ((storage.foldername(name))[3])::uuid = public.current_profile_id()
  );
