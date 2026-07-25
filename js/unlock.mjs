// PlotMyPub — achievement unlock notifications + one-tap pin.
//
// Achievements are awarded SERVER-SIDE (supabase/migrations/0005_achievements.sql
// and friends) by a trigger on `ratings`; the client only ever READS them. There
// is no push, so we spot a fresh unlock by diffing the earned set against a
// per-(profile, group) snapshot in localStorage. The trigger runs inside the
// rating's own transaction, so by the time submitPub() resolves the badge is
// already in the ledger and fetchAchievements() will see it.
//
// The FIRST time we ever see a profile+group we seed the snapshot silently — so
// historic / backfilled badges never blast a returning user. After that, any
// code missing from the snapshot is genuinely new and earns a celebration popup.
// See memory: achievements-design, avoid-generic-ai-gamification.
import { S } from './core.mjs';
import { ACHIEVEMENTS, RARITY, RARITY_ORDER } from './achievements.mjs';
import { fetchAchievements, fetchPinned, setPinned } from './api.mjs';
import { refreshMapXp } from './mapxp.mjs';

const BY_CODE = {};
ACHIEVEMENTS.forEach((a) => { BY_CODE[a.code] = a; });

// Backdrop glow behind the medal, tinted to the rarity (mirrors the ring metal).
const HALO = {
  common:    'rgba(63,110,166,.35)',
  rare:      'rgba(212,127,39,.35)',
  epic:      'rgba(123,75,196,.40)',
  legendary: 'rgba(240,216,120,.45)'
};

// ---- snapshot (per profile + group) ------------------------------------------
function snapKey() { return 'pmp:ach:' + S.PROFILE.id + ':' + S.ACTIVE_GROUP.id; }
function readSnap() {
  try { return JSON.parse(localStorage.getItem(snapKey()) || 'null'); } catch (e) { return null; }
}
function writeSnap(codes) {
  try { localStorage.setItem(snapKey(), JSON.stringify(codes)); } catch (e) { /* private mode etc. */ }
}

// ---- detection ---------------------------------------------------------------
let queue = [];      // badge codes waiting to be celebrated
let showing = false;

/** Diff the earned set against our snapshot and celebrate anything new. Pass the
 *  earned map if you already have it (the Levels/Me tabs fetch it on render);
 *  otherwise we fetch. Fail-soft throughout — a notification is a nicety. */
export async function checkForUnlocks(earned) {
  if (!S.PROFILE || !S.ACTIVE_GROUP) return;
  try {
    const map = earned || await fetchAchievements();
    const codes = Object.keys(map);
    const prev = readSnap();
    writeSnap(codes);                       // snapshot always tracks the latest
    if (prev === null) return;              // first sight of this profile+group → seed silently
    const fresh = codes.filter((c) => prev.indexOf(c) === -1 && BY_CODE[c]);
    if (!fresh.length) return;
    // Rarest last, so a batch (e.g. a pub crawl) builds toward the big one.
    fresh.sort((a, b) => RARITY_ORDER.indexOf(BY_CODE[a].rarity) - RARITY_ORDER.indexOf(BY_CODE[b].rarity));
    queue = queue.concat(fresh);
    if (!showing) next();
  } catch (e) { console.warn(e); }
}

// ---- the popup ---------------------------------------------------------------
let overlay = null;
let currentCode = null;

function medalHtml(a) {
  return '<div class="ach-medal ' + a.rarity + '">' +
    '<div class="ach-rays"></div>' +
    '<div class="ach-ring"><div class="ach-disc"><span class="ach-emoji">' + a.emoji +
      '</span><span class="ach-gloss"></span></div></div>' +
  '</div>';
}

function ensureOverlay() {
  if (overlay) return overlay;
  const ov = document.createElement('div');
  ov.className = 'unlock-ov';
  ov.id = 'unlockOv';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-labelledby', 'unlockName');
  ov.innerHTML =
    '<div class="unlock-bg" data-uclose></div>' +
    '<div class="unlock-pop" id="unlockPop">' +
      '<div class="unlock-halo"></div>' +
      '<div class="unlock-eyebrow">Badge unlocked</div>' +
      '<div class="unlock-medal" id="unlockMedal"></div>' +
      '<div class="unlock-name" id="unlockName"></div>' +
      '<div class="unlock-meta"><span class="ach-chip" id="unlockChip"></span>' +
        '<span class="ach-xp" id="unlockXp"></span></div>' +
      '<div class="unlock-obj" id="unlockObj"></div>' +
      '<div class="unlock-actions">' +
        '<button class="unlock-btn unlock-btn-primary" id="unlockPin" type="button"></button>' +
        '<button class="unlock-btn unlock-btn-ghost" data-uclose type="button">Maybe later</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', (e) => { if (e.target.hasAttribute('data-uclose')) dismiss(); });
  ov.querySelector('#unlockPin').addEventListener('click', onPin);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && overlay.classList.contains('open')) dismiss();
  });
  overlay = ov;
  return ov;
}

function next() {
  const code = queue.shift();
  if (!code) { showing = false; currentCode = null; return; }
  showing = true;
  currentCode = code;
  const a = BY_CODE[code];
  const r = RARITY[a.rarity];
  const ov = ensureOverlay();
  const pop = ov.querySelector('#unlockPop');
  pop.className = 'unlock-pop' + (a.rarity === 'legendary' ? ' leg' : '');
  pop.style.setProperty('--halo', HALO[a.rarity]);
  ov.querySelector('#unlockMedal').innerHTML = medalHtml(a);
  ov.querySelector('#unlockName').textContent = a.name;
  const chip = ov.querySelector('#unlockChip');
  chip.className = 'ach-chip ' + a.rarity;
  chip.textContent = r.label;
  ov.querySelector('#unlockXp').textContent = '+' + r.xp + ' XP';
  ov.querySelector('#unlockObj').textContent = a.objective;   // now unlocked → safe to reveal
  const pinBtn = ov.querySelector('#unlockPin');
  pinBtn.textContent = '📌 Pin to profile';
  pinBtn.disabled = false;
  ov.classList.add('open');
  // A little haptic nod on mobile — a richer buzz for a legendary.
  if (navigator.vibrate) { try { navigator.vibrate(a.rarity === 'legendary' ? [0, 40, 60, 40] : 30); } catch (e) {} }
}

// Pin the badge that's currently on show, straight from the celebration. Reads
// the live pin list so it respects the 3-badge cap and never clobbers the others.
async function onPin() {
  const btn = this;
  if (!currentCode) return;
  btn.disabled = true;
  try {
    const cur = await fetchPinned();
    if (cur.indexOf(currentCode) !== -1) {
      btn.textContent = 'Already pinned ✓';
    } else if (cur.length >= 3) {
      btn.textContent = 'Profile full — unpin one first';
      btn.disabled = false;
      return;
    } else {
      await setPinned(cur.concat(currentCode));
      refreshMapXp();
      btn.textContent = 'Pinned to profile ✓';
    }
  } catch (e) {
    console.warn(e);
    btn.textContent = 'Couldn’t pin — try again';
    btn.disabled = false;
    return;
  }
  setTimeout(dismiss, 700);
}

function dismiss() {
  if (overlay) {
    overlay.classList.add('closing');   // keeps it visible while the exit anim plays
    overlay.classList.remove('open');
  }
  setTimeout(() => {                 // let it fade before the next one (or settle empty)
    if (overlay) overlay.classList.remove('closing');
    next();
  }, 200);
}
