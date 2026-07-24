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
import { ACHIEVEMENTS, RARITY, RARITY_ORDER, isHidden, TOTAL } from '../achievements.mjs';
import { fetchXp, fetchAchievements } from '../api.mjs';

const el = document.querySelector('.view-ph[data-view="levels"]');

// ---- Achievements grid --------------------------------------------------
// A badge = a rarity-framed medallion (blue/amber/purple/gold) over its emoji.
// Locked badges are greyed; Epic/Legendary hide their objective until earned;
// unlocked Epic/Legendary gain a premium card. Mirrors the approved demo.
function achMedal(a, shown) {
  const hidden = !shown && isHidden(a.rarity);
  const face = hidden
    ? '<span class="ach-emoji q">?</span>'
    : '<span class="ach-emoji">' + a.emoji + '</span>';
  return '<div class="ach-medal ' + a.rarity + '">' +
    '<div class="ach-rays"></div>' +
    '<div class="ach-ring"><div class="ach-disc">' + face + '<span class="ach-gloss"></span></div></div>' +
    '<span class="ach-lock">🔒</span>' +
  '</div>';
}

function achCard(a, earned) {
  const shown = !!earned[a.code];
  const locked = !shown;
  const hidden = locked && isHidden(a.rarity);
  const r = RARITY[a.rarity];
  const obj = hidden ? 'Hidden — unlock to reveal' : a.objective;
  const premium = shown && isHidden(a.rarity) ? ' ach-card-' + a.rarity : '';
  return '<div class="ach-badge ' + a.rarity + (locked ? ' ach-locked' : '') + premium + '">' +
    achMedal(a, shown) +
    '<div class="ach-name">' + escapeHtml(a.name) + '</div>' +
    '<div class="ach-meta"><span class="ach-chip ' + a.rarity + '">' + r.label + '</span>' +
      '<span class="ach-xp">+' + r.xp + '</span></div>' +
    '<div class="ach-obj">' + escapeHtml(obj) + '</div>' +
    (a.title ? '<div class="ach-tag">Title · held by one</div>' : '') +
  '</div>';
}

function achievementsHtml(earned) {
  const got = ACHIEVEMENTS.filter((a) => earned[a.code]).length;
  const sections = RARITY_ORDER.map((k) => {
    const items = ACHIEVEMENTS.filter((a) => a.rarity === k);
    if (!items.length) return '';
    return '<div class="ach-rar-label ' + k + '">' + RARITY[k].label +
      ' · +' + RARITY[k].xp + ' XP</div>' +
      '<div class="ach-grid">' + items.map((a) => achCard(a, earned)).join('') + '</div>';
  }).join('');
  return '<div class="ach-head"><div class="sec-label">Achievements</div>' +
    '<div class="ach-count">' + got + ' / ' + TOTAL + '</div></div>' +
    sections;
}

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
    if (!e.refId) { rows.push({ at: e.at, total: e.amount, types: [e.type], pub: e.pub || null }); return; }
    let g = byRef.get(e.refId);
    if (!g) { g = { at: e.at, total: 0, types: [], pub: e.pub || null }; byRef.set(e.refId, g); rows.push(g); }
    g.total += e.amount;
    g.types.push(e.type);
    if (e.pub && !g.pub) g.pub = e.pub;
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
    ? 'Maxed — <b>' + fmt(xp) + '</b> XP, ' + fmt(p.done) + ' past ' + escapeHtml(cur.title)
    : '<b>' + fmt(xp) + '</b> XP · ' + fmt(p.remaining) + ' to ' + escapeHtml(nxt.title);
  return '' +
    '<div class="lv-hero" id="lvHero" role="button" tabindex="0" aria-expanded="false" aria-controls="lvTiers">' +
      '<div class="lv-crest">' + cur.icon + '</div>' +
      '<div class="lv-id">' +
        '<div class="lv-tier">' + escapeHtml(cur.title) + '</div>' +
        '<div class="lv-sub">' + pubs + (pubs === 1 ? ' pub' : ' pubs') + ' mapped · tap for all tiers</div>' +
      '</div>' +
      '<span class="lv-chev" aria-hidden="true">›</span>' +
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

// One tight row per earning moment: the pub that earned it, a muted line of the
// bonus reasons (the base "Rated a pub" is implied by naming the pub) + when.
const BONUS_LABELS = { first_map: 'First to map', new_area: 'New area', with_note: 'Note', with_photo: 'Photo' };

function feedHtml(rows) {
  return rows.slice(0, 12).map((r) => {
    const hasBase = r.types.indexOf('rate_pub') !== -1;
    const title = r.pub || (hasBase ? XP_LABELS.rate_pub : (XP_LABELS[r.types[0]] || r.types[0]));
    const bonuses = r.types.filter((t) => t !== 'rate_pub').map((t) => BONUS_LABELS[t] || XP_LABELS[t] || t);
    const bits = bonuses.concat(timeAgo(r.at) || []);   // reasons first, then time
    return '<div class="lv-ev">' +
      '<div class="lv-ev-body">' +
        '<div class="lv-ev-title">' + escapeHtml(title) + '</div>' +
        (bits.length ? '<div class="lv-ev-sub">' + escapeHtml(bits.join(' · ')) + '</div>' : '') +
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
  let earned = {};
  try {
    // achievements fail soft to {} on their own, so only fetchXp can reject here
    const [xpData, ach] = await Promise.all([fetchXp(), fetchAchievements()]);
    data = xpData; earned = ach || {};
  }
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
        '<div class="lv-empty-emoji">' + TIERS[0].icon + '</div>' +
        '<div class="lv-empty-title">' + escapeHtml(TIERS[0].title) + '</div>' +
        '<div class="lv-empty-sub">Rate your first pub to start earning XP and begin the climb toward ' +
          escapeHtml(TIERS[TIERS.length - 1].title) + '.</div>' +
      '</div>' + achievementsHtml(earned);
    return;
  }

  const rows = groupEvents(events);
  page.innerHTML =
    heroHtml(xp, pubs) +
    '<div class="lv-tiers" id="lvTiers" hidden>' +
      '<div class="sec-label">Tiers</div>' +
      '<div class="lv-ladder">' + ladderHtml(xp) + '</div>' +
    '</div>' +
    (rows.length
      ? '<div class="sec-label">Recent XP</div><div class="lv-feed">' + feedHtml(rows) + '</div>'
      : '') +
    achievementsHtml(earned);
}

// The tier ladder is tucked away by default; tapping your level reveals it.
function toggleTiers() {
  const hero = document.getElementById('lvHero');
  const tiers = document.getElementById('lvTiers');
  if (!hero || !tiers) return;
  const open = !tiers.hasAttribute('hidden');
  if (open) { tiers.setAttribute('hidden', ''); hero.setAttribute('aria-expanded', 'false'); hero.classList.remove('open'); }
  else { tiers.removeAttribute('hidden'); hero.setAttribute('aria-expanded', 'true'); hero.classList.add('open'); }
}
el.addEventListener('click', (e) => { if (e.target.closest('#lvHero')) toggleTiers(); });
el.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('#lvHero')) { e.preventDefault(); toggleTiers(); }
});

registerView('levels', { el, onShow: render });
