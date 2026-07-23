// PlotMyPub — core: the Supabase client, tiny DOM helpers, the colour ramp,
// and the small slice of state that is genuinely shared across views (the
// signed-in profile, the user's groups, and the active group). View-local
// state (markers, the map instance, panel page, …) stays inside its own module.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.mjs';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ================= tiny helpers =================
export const $ = (id) => document.getElementById(id);
export const setMsg = (el, text, cls) => { el.textContent = text; el.className = 'msg' + (cls ? ' ' + cls : ''); };

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

export function isMobile() { return window.innerWidth <= 640; }

// ================= shared app state =================
// These were three module-level `let`s in the old single-file script. Held on
// one exported object so any module can read AND mutate the live values — you
// can't reassign a plain imported binding from another module, but you can set
// a property on a shared object.
export const S = {
  PROFILE: null,        // { id, display_name, ... }
  GROUPS: [],           // groups this user belongs to
  ACTIVE_GROUP: null    // { id, name } currently selected
};

// Remember the last group visited so we can skip the picker next time.
const LAST_GROUP_KEY = 'pmp:lastGroup';
export function lastGroupId() { try { return localStorage.getItem(LAST_GROUP_KEY); } catch (e) { return null; } }
export function rememberGroup() { try { if (S.ACTIVE_GROUP) localStorage.setItem(LAST_GROUP_KEY, S.ACTIVE_GROUP.id); } catch (e) {} }

// ================= colour ramp (unchanged from page.html) =================
export function colourFor(score) {
  var stops = [
    { at: 0,  rgb: [248, 105, 107] },
    { at: 5,  rgb: [255, 235, 132] },
    { at: 10, rgb: [99, 190, 123] }
  ];
  if (score == null) return '#cccccc';
  var s = Math.max(stops[0].at, Math.min(stops[2].at, score));
  var lo = s <= stops[1].at ? stops[0] : stops[1];
  var hi = s <= stops[1].at ? stops[1] : stops[2];
  var t = (s - lo.at) / (hi.at - lo.at);
  var c = lo.rgb.map(function (v, i) { return Math.round(v + t * (hi.rgb[i] - v)); });
  return 'rgb(' + c.join(',') + ')';
}

export function colourForKey(v, key) {
  if (v == null) return '#cccccc';
  return colourFor(key === 'score' ? v : v * 2);
}
