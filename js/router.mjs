// PlotMyPub — view router for the bottom-nav tabs. The map is the base layer
// (always mounted, never torn down); every other tab is a full-screen overlay
// shown on top of it. showView() toggles those overlays and the nav's active
// state; the map "view" is simply "no overlay active".

import { $ } from './core.mjs';

const views = {};      // name -> { el?, onShow? }
const order = {};       // name -> tab index (nav order), used for slide direction
let current = null;

/** Register a view with an optional element + onShow callback. */
export function registerView(name, opts = {}) {
  views[name] = opts;
}

/** Build a "coming soon" placeholder view, mount it into #app, and register it.
 *  Each future tab replaces its placeholder module with a real one. */
export function placeholderView(name, { emoji, title, blurb }) {
  const el = document.createElement('section');
  el.className = 'view-ph';
  el.dataset.view = name;
  el.setAttribute('role', 'tabpanel');
  el.innerHTML =
    '<div class="ph-emoji">' + emoji + '</div>' +
    '<h2>' + title + '</h2>' +
    '<p>' + blurb + '</p>' +
    '<div class="ph-soon">Coming soon</div>';
  $('app').appendChild(el);
  registerView(name, { el });
  return el;
}

/** Show a view by name. Unknown names fall back to the map.
 *  Tabs slide as a horizontal filmstrip: moving toward a higher-index tab, the
 *  outgoing panel exits left and the incoming one enters from the right (and the
 *  reverse when moving toward a lower-index tab). The map is the static base
 *  layer — it has no panel, so overlays simply slide over/off it. */
export function showView(name) {
  if (name !== 'map' && !views[name]) name = 'map';
  if (name === current) return;

  const from = current;
  if (from && views[from] && views[from].onHide) views[from].onHide();
  const movingRight = (order[name] || 0) > (order[from] || 0);
  const enterSide = movingRight ? 'slide-right' : 'slide-left';
  const exitSide  = movingRight ? 'slide-left'  : 'slide-right';

  // Send the outgoing panel off the opposite way to travel.
  const outEl = from && views[from] && views[from].el;
  if (outEl) {
    outEl.classList.remove('active', 'slide-left', 'slide-right', 'no-anim');
    outEl.classList.add(exitSide);
  }

  // Park the incoming panel just off-screen on the entry side (no animation),
  // commit that position, then release it to slide into place.
  const inEl = views[name] && views[name].el;   // map has no panel
  if (inEl) {
    inEl.classList.add('no-anim');
    inEl.classList.remove('active', 'slide-left', 'slide-right');
    inEl.classList.add(enterSide);
    void inEl.offsetWidth;                       // commit the off-screen start
    inEl.classList.remove('no-anim', 'slide-left', 'slide-right');
    inEl.classList.add('active');
  }

  current = name;

  document.querySelectorAll('#nav .navbtn').forEach((b) => {
    const on = b.dataset.view === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  const v = views[name];
  if (v && v.onShow) v.onShow();
}

export function currentView() { return current; }

/** Wire the nav buttons and land on the map. Call once at boot. */
export function initNav() {
  const btns = [...document.querySelectorAll('#nav .navbtn')];

  // Record each tab's position so showView knows which way to slide.
  btns.forEach((b, i) => { order[b.dataset.view] = i; });

  btns.forEach((b) => {
    b.addEventListener('click', () => showView(b.dataset.view));
  });
  showView('map');
}
