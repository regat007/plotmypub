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
import { fetchXp, fetchAchievements, fetchTitleHolders, fetchPinned, setPinned } from '../api.mjs';
import { refreshMapXp } from '../mapxp.mjs';

const el = document.querySelector('.view-ph[data-view="levels"]');

// Live state for tap-to-pin: the earned set + holders from the last render, and
// the badges pinned to the profile. Kept at module scope so a pin/unpin can
// re-paint just the achievements block without reloading the whole tab.
let AEARNED = {};
let AHOLDERS = {};
let PINS = [];

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

// The live "who holds it now" line for a Title badge (the ledger only records
// the one-time XP; the current holder is computed on read — see fetchTitleHolders).
function titleTag(a, holders) {
  const h = holders && holders[a.code];
  if (h && h.profileId === S.PROFILE.id) return '<div class="ach-tag ach-tag-you">You hold this</div>';
  if (h && h.name) return '<div class="ach-tag">Held by ' + escapeHtml(h.name) + '</div>';
  return '<div class="ach-tag">Up for grabs</div>';
}

function achCard(a, earned, holders) {
  const shown = !!earned[a.code];
  const locked = !shown;
  const hidden = locked && isHidden(a.rarity);
  const r = RARITY[a.rarity];
  const obj = hidden ? 'Hidden — unlock to reveal' : a.objective;
  const premium = shown && isHidden(a.rarity) ? ' ach-card-' + a.rarity : '';
  // Earned badges are tappable: a tap pins them to your profile (up to 3).
  const pinned = PINS.indexOf(a.code) !== -1;
  const cls = 'ach-badge ' + a.rarity + (locked ? ' ach-locked' : ' ach-earned') + premium + (pinned ? ' ach-pinned' : '');
  const pinAttrs = shown
    ? ' role="button" tabindex="0" data-pin="' + a.code + '" aria-pressed="' + (pinned ? 'true' : 'false') +
      '" aria-label="' + (pinned ? 'Unpin ' : 'Pin ') + escapeHtml(a.name) + ' on your profile"'
    : '';
  const pinDot = shown ? '<span class="ach-pin" aria-hidden="true">' + (pinned ? '📌' : '📍') + '</span>' : '';
  return '<div class="' + cls + '"' + pinAttrs + '>' +
    pinDot +
    achMedal(a, shown) +
    '<div class="ach-name">' + escapeHtml(a.name) + '</div>' +
    '<div class="ach-meta"><span class="ach-chip ' + a.rarity + '">' + r.label + '</span>' +
      '<span class="ach-xp">+' + r.xp + '</span></div>' +
    '<div class="ach-obj">' + escapeHtml(obj) + '</div>' +
    (a.title ? titleTag(a, holders) : '') +
  '</div>';
}

function achievementsHtml(earned, holders) {
  const got = ACHIEVEMENTS.filter((a) => earned[a.code]).length;
  const sections = RARITY_ORDER.map((k) => {
    const items = ACHIEVEMENTS.filter((a) => a.rarity === k);
    if (!items.length) return '';
    return '<div class="ach-rar-label ' + k + '">' + RARITY[k].label +
      ' · +' + RARITY[k].xp + ' XP</div>' +
      '<div class="ach-grid">' + items.map((a) => achCard(a, earned, holders)).join('') + '</div>';
  }).join('');
  const nPins = PINS.filter((c) => earned[c]).length;
  const hint = got
    ? '<div class="ach-pinhint">Tap a badge to pin it to your profile · <b>' + nPins + '</b>/3 pinned</div>'
    : '';
  return '<div class="ach-head"><div class="sec-label">Achievements</div>' +
    '<div class="ach-count">' + got + ' / ' + TOTAL + '</div></div>' +
    hint + sections;
}

// Re-paint only the achievements block after a pin/unpin — keeps the hero,
// tier ladder and XP feed (and the page's scroll position) untouched.
function rerenderAch() {
  const box = document.getElementById('lvAch');
  if (box) box.innerHTML = achievementsHtml(AEARNED, AHOLDERS);
}

// A brief bottom-of-tab toast for pin feedback / the 3-badge cap.
let toastTimer;
function lvToast(msg) {
  let t = document.getElementById('lvToast');
  if (!t) { t = document.createElement('div'); t.id = 'lvToast'; t.className = 'lv-toast'; el.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// Toggle a badge's pin, persisting through setPinned. PINS is only committed if
// the write lands (mirrors me.mjs) so a failure reverts cleanly on re-paint.
async function togglePin(code) {
  if (!AEARNED[code]) return;
  const on = PINS.indexOf(code) !== -1;
  let next;
  if (on) {
    next = PINS.filter((c) => c !== code);
  } else {
    if (PINS.length >= 3) { lvToast('You can pin 3 — unpin one to swap'); return; }
    next = PINS.concat(code);
  }
  const prev = PINS;
  try { PINS = await setPinned(next); }
  catch (e) { console.warn(e); PINS = prev; rerenderAch(); lvToast('Couldn’t save — please try again'); return; }
  rerenderAch();
  refreshMapXp();                                  // the map pill mirrors your pins
  lvToast(on ? 'Unpinned' : '📌 Pinned to your profile');
}

el.addEventListener('click', (e) => {
  const card = e.target.closest('[data-pin]');
  if (card) togglePin(card.getAttribute('data-pin'));
});
el.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('[data-pin]');
  if (card) { e.preventDefault(); togglePin(card.getAttribute('data-pin')); }
});

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

// One tight row per earning moment: the pub that earned it, the bonus reasons as
// scannable icon pills (the base "Rated a pub" is implied by naming the pub), and
// when. Each pill carries a label for hover + screen readers.
const BONUS_META = {
  first_map:  { icon: '🥇', label: 'First to map' },
  new_area:   { icon: '🗺️', label: 'New area' },
  with_note:  { icon: '📝', label: 'Wrote a note' },
  with_photo: { icon: '📸', label: 'Added a photo' }
};

function feedHtml(rows) {
  return rows.slice(0, 12).map((r) => {
    const hasBase = r.types.indexOf('rate_pub') !== -1;
    const title = r.pub || (hasBase ? XP_LABELS.rate_pub : (XP_LABELS[r.types[0]] || r.types[0]));
    const pills = r.types.filter((t) => t !== 'rate_pub' && BONUS_META[t]).map((t) => {
      const m = BONUS_META[t];
      return '<span class="lv-pill" title="' + m.label + '" aria-label="' + m.label + '">' + m.icon + '</span>';
    }).join('');
    const time = timeAgo(r.at);
    return '<div class="lv-ev">' +
      '<div class="lv-ev-body">' +
        '<div class="lv-ev-title">' + escapeHtml(title) + '</div>' +
        (pills ? '<div class="lv-ev-pills">' + pills + '</div>' : '') +
        (time ? '<div class="lv-ev-time">' + escapeHtml(time) + '</div>' : '') +
      '</div>' +
      '<div class="lv-ev-amt">+' + fmt(r.total) + '</div>' +
    '</div>';
  }).join('');
}

// A one-line momentum strip above the feed: what you've banked in the last 7 days
// and your best single earning moment. Returns '' when nothing landed this week,
// so a quiet stretch doesn't show an empty "+0".
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function momentumHtml(rows) {
  const since = Date.now() - WEEK_MS;
  const wk = rows.filter((r) => r.at && r.at >= since);
  if (!wk.length) return '';
  const total = wk.reduce((a, r) => a + r.total, 0);
  const best = wk.reduce((a, r) => (r.total > a.total ? r : a), wk[0]);
  const bestBit = wk.length > 1 && best.pub
    ? ' · best <b>' + escapeHtml(best.pub) + '</b> +' + fmt(best.total)
    : '';
  return '<div class="lv-momentum"><span class="lv-mom-fig">+' + fmt(total) +
    '</span> this week' + bestBit + '</div>';
}

let loadToken = 0;
async function render() {
  const token = ++loadToken;
  const page = document.getElementById('levelsPage');
  page.innerHTML = '<div class="lv-loading">Loading…</div>';

  let data;
  let earned = {};
  let holders = {};
  try {
    // achievements + holders + pins fail soft on their own, so only fetchXp rejects here
    const [xpData, ach, hold, pins] = await Promise.all([
      fetchXp(), fetchAchievements(), fetchTitleHolders().catch(() => ({})), fetchPinned().catch(() => [])
    ]);
    data = xpData; earned = ach || {}; holders = hold || {};
    AEARNED = earned; AHOLDERS = holders; PINS = (pins || []).slice(0, 3);
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
      '</div>' + '<div id="lvAch">' + achievementsHtml(earned, holders) + '</div>';
    return;
  }

  const rows = groupEvents(events);
  page.innerHTML =
    heroHtml(xp, pubs) +
    '<div class="lv-tiers" id="lvTiers" hidden>' +
      '<div class="sec-label">Tiers</div>' +
      '<div class="lv-ladder">' + ladderHtml(xp) + '</div>' +
    '</div>' +
    '<div id="lvAch">' + achievementsHtml(earned, holders) + '</div>' +
    (rows.length
      ? '<div class="sec-label">Recent XP</div>' + momentumHtml(rows) +
        '<div class="lv-feed">' + feedHtml(rows) + '</div>'
      : '');
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
