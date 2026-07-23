// PlotMyPub — view router for the bottom-nav tabs. The map is the base layer
// (always mounted, never torn down); every other tab is a full-screen overlay
// shown on top of it. showView() toggles those overlays and the nav's active
// state; the map "view" is simply "no overlay active".

import { $ } from './core.mjs';

const views = {};      // name -> { el?, onShow? }
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

/** Show a view by name. Unknown names fall back to the map. */
export function showView(name) {
  if (name !== 'map' && !views[name]) name = 'map';
  current = name;

  document.querySelectorAll('.view-ph').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === name);
  });
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

  // Give each overlay a resting side so it slides in from the direction of its
  // nav button: tabs before the centre (map) rest off-screen left, tabs after
  // it rest off-screen right.
  const centerIdx = btns.findIndex((b) => b.dataset.view === 'map');
  btns.forEach((b, i) => {
    const v = views[b.dataset.view];
    if (v && v.el && b.dataset.view !== 'map') {
      v.el.classList.add(i < centerIdx ? 'from-left' : 'from-right');
    }
  });

  btns.forEach((b) => {
    b.addEventListener('click', () => showView(b.dataset.view));
  });
  showView('map');
}
