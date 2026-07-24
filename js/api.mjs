// PlotMyPub — data layer: everything that talks to Supabase (pubs, ratings,
// group members, the activity feed, and stored photos). No DOM here; the
// active group / signed-in profile come from shared state.

import { sb, S } from './core.mjs';
import { SUPABASE_URL, SUPABASE_KEY } from './config.mjs';

/**
 * getPubs(): two queries, assembled to the exact shape the render code wants.
 *   1) pub_scores view  → per-pub averages (+ raters count)
 *   2) ratings⋈profiles → per-author breakdown for the author filter
 * Scoped to the active group.
 */
export async function fetchPubs() {
  const gid = S.ACTIVE_GROUP.id;

  const [scoresRes, ratingsRes] = await Promise.all([
    sb.from('pub_scores').select('*').eq('group_id', gid),
    sb.from('ratings')
      .select('location,beer,value,facilities,vibe,note,photo_path,profile_id,created_at,pubs!inner(id,name,area,lat,lng,place_id,group_id),profiles!inner(display_name)')
      .eq('group_id', gid)
  ]);
  if (scoresRes.error) throw scoresRes.error;
  if (ratingsRes.error) throw ratingsRes.error;

  // index averages by pub id
  const byId = {};
  (scoresRes.data || []).forEach((s) => {
    byId[s.pub_id] = {
      pub: s.name, area: s.area,
      pubId: s.pub_id, groupId: s.group_id,
      lat: s.lat, lng: s.lng, placeId: s.place_id,
      score: s.score,
      cats: {
        location: s.location, beer: s.beer, value: s.value,
        facilities: s.facilities, vibe: s.vibe
      },
      raters: s.raters,
      ratings: []
    };
  });

  // fold in per-author rows
  (ratingsRes.data || []).forEach((r) => {
    const p = r.pubs; if (!p) return;
    let g = byId[p.id];
    if (!g) {
      // pub with rows but not yet in pub_scores (shouldn't happen, but be safe)
      g = byId[p.id] = {
        pub: p.name, area: p.area, pubId: p.id, groupId: p.group_id,
        lat: p.lat, lng: p.lng, placeId: p.place_id,
        score: null, cats: {}, raters: 0, ratings: []
      };
    }
    const cats = {
      location: r.location, beer: r.beer, value: r.value,
      facilities: r.facilities, vibe: r.vibe
    };
    const catScore = (r.location + r.beer + r.value + r.facilities + r.vibe) / 25 * 10;
    g.ratings.push({
      author: r.profiles ? r.profiles.display_name : '—',
      profileId: r.profile_id,
      ratedAt: r.created_at ? new Date(r.created_at).getTime() : null,
      score: catScore, cats,
      note: (r.note || '').trim() || null,
      photoPath: r.photo_path || null
    });
  });

  return Object.keys(byId)
    .map((k) => byId[k])
    .filter((p) => p.pub && p.lat != null && p.lng != null);
}

/** getMembers(): the active group's full roster as { id, name }, including
 *  members who haven't rated a pub yet. Used by the Social tab. */
export async function fetchMembers() {
  const gid = S.ACTIVE_GROUP.id;
  const { data, error } = await sb
    .from('group_members')
    .select('profile_id,profiles!inner(display_name)')
    .eq('group_id', gid);
  if (error) { console.warn(error); return []; }
  return (data || [])
    .map((m) => ({ id: m.profile_id, name: m.profiles && m.profiles.display_name }))
    .filter((m) => m.name);
}

/** getUsers(): display names of the active group's members, for autocomplete. */
export async function fetchUsers() {
  const gid = S.ACTIVE_GROUP.id;
  const { data, error } = await sb
    .from('group_members')
    .select('profiles!inner(display_name)')
    .eq('group_id', gid);
  if (error) { console.warn(error); return []; }
  return (data || []).map((m) => m.profiles && m.profiles.display_name).filter(Boolean);
}

/**
 * submitPub(): geocode via Edge Function, then upsert pub + rating.
 * author comes from the session profile, not a typed field.
 */
export async function submitPub(payload) {
  const gid = S.ACTIVE_GROUP.id;

  // 1) geocode (Phase 5 Edge Function, key server-side)
  const { data: { session } } = await sb.auth.getSession();
  const geoRes = await fetch(SUPABASE_URL + '/functions/v1/geocode', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + session.access_token,
      'apikey': SUPABASE_KEY
    },
    body: JSON.stringify({ pub: payload.pub, area: payload.area })
  });
  const geo = await geoRes.json();
  if (!geoRes.ok) throw new Error(geo.error || 'Could not locate that pub.');

  // 2) upsert the pub for this group (unique on group_id, place_id)
  const { data: pubRow, error: pubErr } = await sb
    .from('pubs')
    .upsert({
      group_id: gid, name: payload.pub, area: payload.area,
      lat: geo.lat, lng: geo.lng, place_id: geo.placeId
    }, { onConflict: 'group_id,place_id' })
    .select()
    .single();
  if (pubErr) throw pubErr;

  // 3) upsert my rating of it (unique on pub_id, profile_id)
  const { error: ratErr } = await sb
    .from('ratings')
    .upsert({
      pub_id: pubRow.id, group_id: gid, profile_id: S.PROFILE.id,
      location: payload.location, beer: payload.beer, value: payload.value,
      facilities: payload.facilities, vibe: payload.vibe,
      note: payload.note || null
    }, { onConflict: 'pub_id,profile_id' });
  if (ratErr) throw ratErr;

  const catScore = (payload.location + payload.beer + payload.value +
                    payload.facilities + payload.vibe) / 25 * 10;
  return {
    pub: payload.pub, area: payload.area, author: S.PROFILE.display_name,
    score: catScore,
    cats: {
      location: payload.location, beer: payload.beer, value: payload.value,
      facilities: payload.facilities, vibe: payload.vibe
    },
    lat: geo.lat, lng: geo.lng, placeId: geo.placeId,
    pubId: pubRow.id, groupId: gid
  };
}

/** getActivity(): flat feed of ratings, newest first, scoped to group. */
export async function fetchActivity(limit) {
  const gid = S.ACTIVE_GROUP.id;
  const { data, error } = await sb
    .from('ratings')
    .select('location,beer,value,facilities,vibe,created_at,pubs!inner(name,area,lat,lng,place_id),profiles!inner(display_name)')
    .eq('group_id', gid)
    .order('created_at', { ascending: false })
    .limit(limit || 40);
  if (error) { console.warn(error); return []; }
  return (data || []).map((r) => {
    const p = r.pubs || {};
    const cats = {
      location: r.location, beer: r.beer, value: r.value,
      facilities: r.facilities, vibe: r.vibe
    };
    return {
      pub: p.name, area: p.area,
      author: r.profiles ? r.profiles.display_name : '—',
      score: (r.location + r.beer + r.value + r.facilities + r.vibe) / 25 * 10,
      cats, lat: p.lat, lng: p.lng, placeId: p.place_id,
      ratedAt: r.created_at ? new Date(r.created_at).getTime() : null
    };
  });
}

/** getXp(): the signed-in profile's XP ledger for the active group — newest
 *  first — plus the running total. Feeds the Levels tab. Several rows can share
 *  a ref_id (base + bonuses for one rating); the view groups them. */
export async function fetchXp() {
  const gid = S.ACTIVE_GROUP.id;
  const pid = S.PROFILE.id;
  // ledger rows + my own ratings (to name the pub each ref_id came from — there's
  // no FK from xp_events.ref_id to ratings, so we look it up client-side).
  const [xpRes, ratRes] = await Promise.all([
    sb.from('xp_events')
      .select('type,amount,ref_id,created_at')
      .eq('group_id', gid)
      .eq('profile_id', pid)
      .order('created_at', { ascending: false }),
    sb.from('ratings')
      .select('id,pubs!inner(name)')
      .eq('group_id', gid)
      .eq('profile_id', pid)
  ]);
  if (xpRes.error) { console.warn(xpRes.error); return { xp: 0, events: [] }; }
  const pubByRef = new Map();
  (ratRes.data || []).forEach((r) => { if (r.pubs) pubByRef.set(r.id, r.pubs.name); });
  const events = (xpRes.data || []).map((e) => ({
    type: e.type,
    amount: e.amount || 0,
    refId: e.ref_id,
    pub: e.ref_id ? (pubByRef.get(e.ref_id) || null) : null,
    at: e.created_at ? new Date(e.created_at).getTime() : null
  }));
  const xp = events.reduce((a, e) => a + e.amount, 0);
  return { xp, events };
}

/** getXpTotals(): running XP total per profile across the whole active group —
 *  drives the Social leaderboard. Returns a { profileId: xp } map. Reads the
 *  xp_totals view (RLS-scoped to your groups). Fails soft to an empty map, so a
 *  not-yet-pushed migration just shows everyone on 0 XP. */
export async function fetchXpTotals() {
  const gid = S.ACTIVE_GROUP.id;
  const { data, error } = await sb
    .from('xp_totals')
    .select('profile_id,xp')
    .eq('group_id', gid);
  if (error) { console.warn(error); return {}; }
  const map = {};
  (data || []).forEach((r) => { map[r.profile_id] = r.xp || 0; });
  return map;
}

/** getAchievements(): which badges the signed-in profile has unlocked in the
 *  active group. Reads the same xp_events ledger (type 'ach:<code>'); returns a
 *  { code: earnedAtMs } map of *earned* badges only. Fails soft to {} so a
 *  not-yet-pushed migration just renders every badge locked. */
export async function fetchAchievements() {
  const gid = S.ACTIVE_GROUP.id;
  const pid = S.PROFILE.id;
  const { data, error } = await sb
    .from('xp_events')
    .select('type,created_at')
    .eq('group_id', gid)
    .eq('profile_id', pid)
    .like('type', 'ach:%');
  if (error) { console.warn(error); return {}; }
  const earned = {};
  (data || []).forEach((e) => {
    const code = e.type.slice(4);            // strip 'ach:'
    const at = e.created_at ? new Date(e.created_at).getTime() : null;
    if (!(code in earned) || (at && at < earned[code])) earned[code] = at;
  });
  return earned;
}

// ---------- photos (Phase 6) ----------
var PHOTO_BUCKET = 'pub-photos';

/** Object path for one author's photo of one pub. Deterministic:
 *  re-uploading overwrites in place, so no orphans. */
export function photoPath(groupId, pubId, profileId) {
  return groupId + '/' + pubId + '/' + profileId + '.jpg';
}

// Signed URLs expire; cache them a short while, keyed by path+size.
var SIGNED_CACHE = {};                     // key -> { url, exp }
var SIGN_TTL = 3600;                        // seconds the signed URL is valid
var SIGN_REUSE = 3000 * 1000;              // ms we reuse a cached URL before re-signing

/** Signed URL for a stored photo, optionally transformed to a width.
 *  Returns null if there's no photo or signing fails. */
export async function signedPhoto(path, width) {
  if (!path) return null;
  var key = path + '|' + (width || 'full');
  var now = Date.now();
  var hit = SIGNED_CACHE[key];
  if (hit && hit.exp > now) return hit.url;

  var opts = width ? { transform: { width: width, resize: 'cover' } } : undefined;
  var res = await sb.storage.from(PHOTO_BUCKET).createSignedUrl(path, SIGN_TTL, opts);
  if (res.error || !res.data) { return null; }
  SIGNED_CACHE[key] = { url: res.data.signedUrl, exp: now + SIGN_REUSE };
  return res.data.signedUrl;
}

/** Record the stored photo path on my rating of a pub. */
export async function setRatingPhotoPath(pubId, path) {
  var res = await sb.from('ratings')
    .update({ photo_path: path })
    .eq('pub_id', pubId)
    .eq('profile_id', S.PROFILE.id);
  if (res.error) throw res.error;
}

/** Upload (or overwrite) the given file at path. Resolves on success. */
export async function uploadPhoto(path, file) {
  var res = await sb.storage.from(PHOTO_BUCKET).upload(path, file, {
    upsert: true,
    contentType: file.type || 'image/jpeg',
    cacheControl: '3600'
  });
  if (res.error) throw res.error;
  // bust any cached signed URLs for this path
  Object.keys(SIGNED_CACHE).forEach(function (k) {
    if (k.indexOf(path + '|') === 0) delete SIGNED_CACHE[k];
  });
  return path;
}
