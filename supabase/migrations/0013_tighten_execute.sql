-- ============================================================================
-- PlotMyPub → Supabase  ·  Phase 8c: stop handing the new functions to PUBLIC
-- ----------------------------------------------------------------------------
-- PostgreSQL grants EXECUTE on every newly created function to PUBLIC. The
-- grant lists in 0011/0012 therefore ADDED `authenticated` without ever taking
-- away the implicit "everyone" grant — including the `anon` role PostgREST uses
-- for unauthenticated requests. Confirmed live: an anonymous POST to
-- /rest/v1/rpc/gen_invite_code returned a freshly generated code, and the
-- admin_* endpoints answered (with "Not authorised.", but they answered).
--
-- This was never a data leak. Every admin_* function opens with require_admin()
-- and every write path re-checks ownership, which is why the anonymous probe got
-- a 42501 instead of the instance's contents. But an endpoint that can only ever
-- refuse you has no business being reachable, so close it.
--
-- Note this does NOT touch the helpers used inside RLS policies
-- (current_profile_id, is_group_member, shares_group_with): policy expressions
-- are evaluated with the CALLER's privileges, so revoking those would break
-- ordinary reads.
--
-- Apply: npx supabase db push --include-all
-- ============================================================================

-- ---------------------------------------------------------------- admin surface
-- Admin-only, so `anon` should never reach them at all.

revoke execute on function
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
  admin_set_admin(uuid, boolean),
  admin_rotate_invite(uuid)
  from public, anon;

-- ---------------------------------------------------------------- account RPCs
-- These need `authenticated` (granted in 0011/0012 and the init migration) but
-- have no meaning for a signed-out caller: each one starts by resolving
-- current_profile_id(), which is null without a session.

revoke execute on function
  create_group(text),
  create_group(text, text),
  join_group(text),
  rotate_invite_code(uuid),
  is_group_owner(uuid)
  from public, anon;

-- ---------------------------------------------------------------- internal only
-- gen_invite_code() is called exclusively from inside create_group() and
-- rotate_invite_code(), both SECURITY DEFINER, so they reach it as the owner.
-- Nothing outside the database needs it — this is the one the probe caught.

revoke execute on function gen_invite_code() from public, anon, authenticated;

-- Belt and braces: 0011/0012 already revoked these from public + authenticated,
-- but not from anon.
revoke execute on function log_admin(text, text, uuid, jsonb) from anon;
revoke execute on function prune_join_attempts() from anon;
