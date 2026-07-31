// PlotMyPub admin — boot. Gates on the is_admin flag, then runs a five-tab
// console over the admin_* RPCs.
//
// This page is intentionally NOT part of the main app bundle: it isn't in the
// bottom nav, its code never ships to ordinary users, and it lays out for a
// desktop screen rather than a phone. It reuses the same Supabase session
// (same origin, same localStorage), so signing in on the app signs you in here.

import { sb, $ } from '../core.mjs';
import { amIAdmin } from './data.mjs';
import * as P from './panels.mjs';

const PANELS = {
  overview: P.overview,
  groups:   P.groups,
  activity: P.activity,
  people:   P.people,
  audit:    P.audit
};

function screen(id) {
  ['gate', 'denied', 'console'].forEach((s) => {
    $(s).classList.toggle('hidden', s !== id);
  });
}

let currentTab = null;

function show(tab) {
  if (!PANELS[tab]) tab = 'overview';
  currentTab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  const root = $('panel');
  root.onclick = null;          // each panel installs its own delegated handlers
  root.onchange = null;
  PANELS[tab](root);
  try { location.hash = '#' + tab; } catch (e) {}
}

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) show(b.dataset.tab);
});

// show() writes the hash, so honour it being changed from outside too: browser
// back/forward and a pasted #groups link should both land on the right tab.
window.addEventListener('hashchange', () => {
  const tab = (location.hash || '').replace('#', '') || 'overview';
  if (tab !== currentTab) show(tab);
});

$('refresh').addEventListener('click', () => show(currentTab));

$('signout').addEventListener('click', async () => {
  await sb.auth.signOut();
  location.href = '/';
});

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { screen('gate'); return; }

  if (!(await amIAdmin())) {
    $('deniedWho').textContent = session.user.email || 'this account';
    screen('denied');
    return;
  }

  $('who').textContent = session.user.email || '';
  screen('console');
  show((location.hash || '').replace('#', '') || 'overview');
}

boot();
