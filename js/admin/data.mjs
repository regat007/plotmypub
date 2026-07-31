// PlotMyPub admin — data layer. Thin wrappers over the admin_* RPCs from
// 0011_admin.sql / 0012_lockdown.sql.
//
// Everything here goes through a security-definer function that calls
// require_admin() first, so a non-admin gets a 42501 back rather than data.
// There is no service_role key in this codebase and there must never be one —
// this page ships the same publishable anon key as the main app.

import { sb } from '../core.mjs';

/** Unwrap a Supabase RPC result, turning the error into a throw. */
async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args || {});
  if (error) throw error;
  return data;
}

/** True if the signed-in user holds the admin flag. Used by the gate. */
export async function amIAdmin() {
  const { data, error } = await sb.rpc('is_app_admin');
  if (error) return false;
  return data === true;
}

// ---------- reads ----------

export const getOverview = () => rpc('admin_overview');
export const getGroups   = () => rpc('admin_groups');
export const getGroup    = (id) => rpc('admin_group', { p_group_id: id });
export const getPeople   = () => rpc('admin_people');
export const getAudit    = (limit) => rpc('admin_audit_log', { p_limit: limit || 100 });

/** Global activity, newest first. `before` is the created_at of the last row you
 *  already have — keyset paging, so new rows landing mid-scroll can't shift the
 *  window and duplicate results the way OFFSET would. */
export const getActivity = (limit, before) =>
  rpc('admin_activity', { p_limit: limit || 50, p_before: before || null });

// ---------- actions ----------

export const renameGroup   = (id, name) => rpc('admin_rename_group', { p_group_id: id, p_name: name });
export const rotateInvite  = (id) => rpc('admin_rotate_invite', { p_group_id: id });
export const removeMember  = (gid, pid) => rpc('admin_remove_member', { p_group_id: gid, p_profile_id: pid });
export const setMemberRole = (gid, pid, role) =>
  rpc('admin_set_member_role', { p_group_id: gid, p_profile_id: pid, p_role: role });
export const deleteRating  = (id) => rpc('admin_delete_rating', { p_rating_id: id });
export const setAdmin      = (pid, on) => rpc('admin_set_admin', { p_profile_id: pid, p_is_admin: on });

/** Detach a photo from its rating AND delete the stored object. The RPC returns
 *  the path it cleared (null if there wasn't one); the storage delete needs the
 *  admin arm of the pub_photos_delete policy added in 0011. */
export async function clearPhoto(ratingId) {
  const path = await rpc('admin_clear_photo', { p_rating_id: ratingId });
  if (!path) return null;
  const { error } = await sb.storage.from('pub-photos').remove([path]);
  // The row is already detached; a storage failure leaves an orphan object but
  // no visible photo. Worth knowing about, not worth failing the action over.
  if (error) console.warn('photo row cleared, object not removed:', error);
  return path;
}
