-- ============================================================
--  PlotMyPub — Phase 6 fix: storage RLS path parsing
--
--  0002 assumed storage.foldername() returned THREE segments for
--  '<group>/<pub>/<profile>.jpg' and read the profile from [3].
--  On this instance foldername() strips the filename, so the
--  profile UUID lives in the FILENAME, not a folder segment —
--  [3] was null and every insert failed the with-check.
--
--  Fix: read group from foldername()[1] (still a real folder),
--  and read the profile from the filename, stripping the ext.
--  Apply: npx supabase db push
-- ============================================================

-- Read: any member of the group in the path may view the object.
drop policy if exists "pub_photos_read" on storage.objects;
create policy "pub_photos_read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'pub-photos'
    and public.is_group_member( ((storage.foldername(name))[1])::uuid )
  );

-- Insert: member of the group AND filename (minus extension) is my profile.
drop policy if exists "pub_photos_insert" on storage.objects;
create policy "pub_photos_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'pub-photos'
    and public.is_group_member( ((storage.foldername(name))[1])::uuid )
    and split_part(storage.filename(name), '.', 1)::uuid = public.current_profile_id()
  );

-- Update: same rule.
drop policy if exists "pub_photos_update" on storage.objects;
create policy "pub_photos_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'pub-photos'
    and public.is_group_member( ((storage.foldername(name))[1])::uuid )
    and split_part(storage.filename(name), '.', 1)::uuid = public.current_profile_id()
  )
  with check (
    bucket_id = 'pub-photos'
    and public.is_group_member( ((storage.foldername(name))[1])::uuid )
    and split_part(storage.filename(name), '.', 1)::uuid = public.current_profile_id()
  );

-- Delete: same rule.
drop policy if exists "pub_photos_delete" on storage.objects;
create policy "pub_photos_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'pub-photos'
    and public.is_group_member( ((storage.foldername(name))[1])::uuid )
    and split_part(storage.filename(name), '.', 1)::uuid = public.current_profile_id()
  );
