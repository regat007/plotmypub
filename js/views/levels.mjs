// PlotMyPub — Levels tab. Your XP, your tier, and what you've earned lately.
// Reads the xp_events ledger (supabase/migrations/0004_xp.sql) for the signed-in
// profile in the active group; all the tier + progress maths live in the shared
// xp.mjs core, so this view and the calibration demo agree exactly. The "clean
// XP bar" treatment — crest + filling bar + real data — deliberately matches the
// Me/Social look rather than a metaphor gimmick; the non-generic feel comes from
// the copy and the user's own numbers. See memory: xp-levels-design,
// avoid-generic-ai-gamification.
import { registerView } from '../router.mjs';
import { S, escapeHtml } from '../core.mjs';
import { TIERS, tierIndexFor, progress, XP_LABELS } from '../xp.mjs';
import { fetchXp } from '../api.mjs';

const el = document.querySelector('.view-ph[data-view="levels"]');

function fmt(n) { return Math.round(n).toLocaleString('en-GB'); }

function timeAgo(ms) {
  if (!ms) return '';
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);  if (d < 7)  return d + 'd ago';
  const w = Math.round(d / 7);   if (w < 5)  return w + 'w ago';
  const mo = Math.round(d / 30); if (mo < 12) return mo + 'mo ago';
  return Math.round(d / 365) + 'y ago';
}

// Fold the flat ledger into one row per source rating (shared ref_id), newest
// first — so "rated a pub + new area + note" reads as a single earning moment.
function groupEvents(events) {
  const byRef = new Map();
  const rows = [];
  events.forEach((e) => {
    if (!e.refId) { rows.push({ at: e.at, total: e.amount, types: [e.type] }); return; }
    let g = byRef.get(e.refId);
    if (!g) { g = { at: e.at, total: 0, types: [] }; byRef.set(e.refId, g); rows.push(g); }
    g.total += e.amount;
    g.types.push(e.type);
    if (e.at && (!g.at || e.at > g.at)) g.at = e.at;
  });
  rows.sort((a, b) => (b.at || 0) - (a.at || 0));
  return rows;
}

function heroHtml(xp, pubs) {
  const i = tierIndexFor(xp);
  const cur = TIERS[i];
  const nxt = TIERS[i + 1];
  const p = progress(xp);
  const pct = Math.round(p.frac * 100);
  const foot = p.maxed
    ? 'Maxed — <b>' + fmt(xp) + '</b> XP, ' + fmt(p.done) + ' past Pub Legend'
    : '<b>' + fmt(xp) + '</b> XP · ' + fmt(p.remaining) + ' to ' + escapeHtml(nxt.title);
  return '' +
    '<div class="lv-hero">' +
      '<div class="lv-crest">' + cur.icon + '</div>' +
      '<div class="lv-id">' +
        '<div class="lv-tier">' + escapeHtml(cur.title) + '</div>' +
        '<div class="lv-sub">' + pubs + (pubs === 1 ? ' pub' : ' pubs') + ' mapped in this group</div>' +
      '</div>' +
    '</div>' +
    '<div class="lv-prog">' +
      '<div class="lv-prog-head">' +
        '<span>' + escapeHtml(cur.title) + '</span>' +
        '<span>' + (nxt ? escapeHtml(nxt.title) : 'Summit') + '</span>' +
      '</div>' +
      '<div class="lv-bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="lv-prog-foot">' + foot + '</div>' +
    '</div>';
}

function ladderHtml(xp) {
  const ci = tierIndexFor(xp);
  return TIERS.map((t, i) => {
    const cls = i === ci ? ' is-current' : (i < ci ? ' is-done' : '');
    const gap = TIERS[i + 1] ? '+' + fmt(TIERS[i + 1].at - t.at) : 'summit';
    const here = i === ci ? '<span class="lv-here">You’re here</span>' : '';
    return '<div class="lv-rung' + cls + '">' +
      '<div class="lv-rung-ic">' + t.icon + '</div>' +
      '<div class="lv-rung-nm">' + escapeHtml(t.title) + here + '</div>' +
      '<div class="lv-rung-fig">' + fmt(t.at) + '<small>' + gap + '</small></div>' +
    '</div>';
  }).join('');
}

function feedHtml(rows) {
  return rows.slice(0, 12).map((r) => {
    const hasBase = r.types.indexOf('rate_pub') !== -1;
    const bonuses = r.types.filter((t) => t !== 'rate_pub');
    const primary = hasBase ? XP_LABELS.rate_pub : (XP_LABELS[r.types[0]] || r.types[0]);
    const extra = (hasBase ? bonuses : r.types.slice(1)).map((t) => XP_LABELS[t] || t);
    const chips = extra.map((l) => '<span class="lv-ev-chip">' + escapeHtml(l) + '</span>').join('');
    return '<div class="lv-ev">' +
      '<div class="lv-ev-body">' +
        '<div class="lv-ev-title">' + escapeHtml(primary) + '</div>' +
        '<div class="lv-ev-sub">' + chips +
          '<span class="lv-ev-time">' + timeAgo(r.at) + '</span></div>' +
      '</div>' +
      '<div class="lv-ev-amt">+' + fmt(r.total) + '</div>' +
    '</div>';
  }).join('');
}

let loadToken = 0;
async function render() {
  const token = ++loadToken;
  const page = document.getElementById('levelsPage');
  page.innerHTML = '<div class="lv-loading">Loading…</div>';

  let data;
  try { data = await fetchXp(); }
  catch (e) {
    if (token !== loadToken) return;
    page.innerHTML = '<div class="lv-loading">Could not load your XP.</div>';
    return;
  }
  if (token !== loadToken) return;             // a newer open superseded this one

  const { xp, events } = data;
  const pubs = events.filter((e) => e.type === 'rate_pub').length;

  if (!xp) {
    page.innerHTML =
      '<div class="lv-empty">' +
        '<div class="lv-empty-emoji">🌱</div>' +
        '<div class="lv-empty-title">New in town</div>' +
        '<div class="lv-empty-sub">Rate your first pub to start earning XP and begin the climb toward Pub Legend.</div>' +
      '</div>';
    return;
  }

  const rows = groupEvents(events);
  page.innerHTML =
    heroHtml(xp, pubs) +
    '<div class="sec-label">Tiers</div>' +
    '<div class="lv-ladder">' + ladderHtml(xp) + '</div>' +
    (rows.length
      ? '<div class="sec-label">Recent XP</div><div class="lv-feed">' + feedHtml(rows) + '</div>'
      : '');
}

registerView('levels', { el, onShow: render });
