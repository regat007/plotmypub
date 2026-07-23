// PlotMyPub — auth / gate: sign-in, profile claim, group join/create, and the
// routing that decides whether to show the gate or drop into the map. Wires
// the gate DOM (and the in-map "Sign out" button, which lives in the map DOM
// but is an auth concern).

import { sb, $, setMsg, S, lastGroupId } from './core.mjs';
import { enterApp } from './map.mjs';

// ===========================================================
//  AUTH / GATE  (Phase 3 shell logic, lightly extended)
// ===========================================================
const GATE_SECTIONS = ['s-signin','s-sent','s-name','s-groups','loading'];
function showGate(id) {
  document.body.className = 'gate' + (id === 'loading' ? ' is-loading' : '');
  $('gate').classList.remove('hidden');
  $('app').classList.add('hidden');
  GATE_SECTIONS.forEach((s) => $(s).classList.toggle('hidden', s !== id));
}

// A ?join=<invite word> link stashes the word here on load, so it survives the
// sign-in redirect (OAuth / magic link bounce back to origin, dropping the query).
// It's consumed once the user has a profile — see consumePendingJoin() in route().
const PENDING_JOIN_KEY = 'pmp:pendingJoin';
(function captureInvite() {
  try {
    const params = new URLSearchParams(location.search);
    const code = (params.get('join') || '').trim();
    if (!code) return;
    localStorage.setItem(PENDING_JOIN_KEY, code);
    params.delete('join');
    const qs = params.toString();
    history.replaceState({}, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  } catch (e) {}
})();

// Redeem a stashed invite word. Needs a profile (join_group uses current_profile_id),
// so it's called from route() only after the profile is confirmed. Returns the joined
// group row, or null if there was nothing to redeem / the word was no good.
async function consumePendingJoin() {
  let code = null;
  try { code = localStorage.getItem(PENDING_JOIN_KEY); } catch (e) {}
  if (!code) return null;
  const { data: g, error } = await sb.rpc('join_group', { p_code: code });
  try { localStorage.removeItem(PENDING_JOIN_KEY); } catch (e) {}
  return (error || !g) ? null : g;
}

let routing = false;
export async function route() {
  if (routing) return; routing = true;
  try {
    const { data:{ session } } = await sb.auth.getSession();
    if (!session) { showGate('s-signin'); return; }

    // Already inside the map (e.g. a background token refresh fired) — don't
    // route again and yank the user back to the gate.
    if (document.body.classList.contains('app')) return;

    const { data: prof, error } = await sb
      .from('profiles').select('*').eq('user_id', session.user.id).maybeSingle();
    if (error) setMsg($('nameMsg'), error.message, 'bad');

    if (!prof) { showGate('s-name'); $('dname').focus(); return; }
    S.PROFILE = prof;
    $('meName').textContent = prof.display_name;

    // Redeem a shared ?join=<word> link, then drop straight into that group.
    const joined = await consumePendingJoin();

    await loadGroups();

    if (joined) {
      S.ACTIVE_GROUP = { id: joined.id, name: joined.name };
      enterApp();
      return;
    }

    // Skip the group picker: open the last group visited, or the only group.
    // Switching / creating / signing out all live in the in-map avatar menu.
    const auto = S.GROUPS.find((g) => g.id === lastGroupId())
      || (S.GROUPS.length === 1 ? S.GROUPS[0] : null);
    if (auto) { S.ACTIVE_GROUP = { id: auto.id, name: auto.name }; enterApp(); return; }

    showGate('s-groups');
  } finally { routing = false; }
}

export async function loadGroups() {
  const { data: groups } = await sb.from('groups').select('*').order('name');
  S.GROUPS = groups || [];
  const has = S.GROUPS.length > 0;
  $('hasGroups').classList.toggle('hidden', !has);
  $('noGroups').classList.toggle('hidden', has);
  if (!has) return;

  const sel = $('groupSel');
  sel.innerHTML = '';
  S.GROUPS.forEach((g) => {
    const o = document.createElement('option');
    o.value = g.id; o.textContent = g.name; sel.appendChild(o);
  });
  sel.value = (S.ACTIVE_GROUP && S.GROUPS.some(g => g.id === S.ACTIVE_GROUP.id))
    ? S.ACTIVE_GROUP.id : S.GROUPS[0].id;
}

// ---- Google sign in ----
$('google').onclick = async () => {
  $('google').disabled = true;
  setMsg($('signinMsg'), 'Opening Google…');
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
  if (error) {
    $('google').disabled = false;
    setMsg($('signinMsg'), error.message, 'bad');
  }
};

// ---- magic-link sign in ----
async function sendLink() {
  const email = $('email').value.trim();
  if (!email) { setMsg($('signinMsg'), 'Enter your email first.', 'bad'); return; }
  $('send').disabled = true; setMsg($('signinMsg'), 'Sending…');
  const { error } = await sb.auth.signInWithOtp({
    email, options: { emailRedirectTo: window.location.origin }
  });
  $('send').disabled = false;
  if (error) { setMsg($('signinMsg'), error.message, 'bad'); return; }
  $('sentTo').textContent = email;
  showGate('s-sent');
}
$('send').onclick = sendLink;
$('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendLink(); });
$('resend').onclick = () => sb.auth.signInWithOtp({
  email: $('sentTo').textContent, options: { emailRedirectTo: window.location.origin }
});
$('useOther').onclick = () => showGate('s-signin');

// ---- claim / create profile ----
$('saveName').onclick = async () => {
  const name = $('dname').value.trim();
  if (!name) { setMsg($('nameMsg'), 'Type a name to continue.', 'bad'); return; }
  $('saveName').disabled = true; setMsg($('nameMsg'), 'Saving…');
  const { error } = await sb.rpc('claim_or_create_profile', { p_name: name });
  $('saveName').disabled = false;
  if (error) { setMsg($('nameMsg'), error.message, 'bad'); return; }
  route();
};

// ---- join / create group ----
$('join').onclick = async () => {
  const code = $('code').value.trim();
  if (!code) { setMsg($('groupMsg'), 'Enter the invite word.', 'bad'); return; }
  $('join').disabled = true; setMsg($('groupMsg'), 'Joining…');
  const { error } = await sb.rpc('join_group', { p_code: code });
  $('join').disabled = false;
  if (error) { setMsg($('groupMsg'), error.message, 'bad'); return; }
  loadGroups().then(() => showGate('s-groups'));
};
$('create').onclick = async () => {
  const name = $('newName').value.trim(), code = $('newCode').value.trim();
  if (!name || !code) { setMsg($('groupMsg'), 'Name the group and give it an invite word.', 'bad'); return; }
  $('create').disabled = true; setMsg($('groupMsg'), 'Creating…');
  const { error } = await sb.rpc('create_group', { p_name: name, p_invite_code: code });
  $('create').disabled = false;
  if (error) { setMsg($('groupMsg'), error.message, 'bad'); return; }
  loadGroups().then(() => showGate('s-groups'));
};

async function doSignOut() { await sb.auth.signOut(); S.PROFILE = null; S.ACTIVE_GROUP = null; showGate('s-signin'); }
$('signout').onclick = doSignOut;
$('mapSignout').onclick = doSignOut;

// ---- enter the map ----
$('openMap').onclick = () => {
  const g = S.GROUPS.find((x) => x.id === $('groupSel').value) || S.GROUPS[0];
  S.ACTIVE_GROUP = { id: g.id, name: g.name };
  enterApp();
};
