// PlotMyPub — entry point. Importing auth (which pulls in map → api → core)
// runs every module's top-level DOM wiring, then we kick off routing and
// register the service worker.

import { sb, $ } from './core.mjs';
import { route } from './auth.mjs';
import { registerView, initNav } from './router.mjs';
// View modules self-register (and mount their placeholder) on import.
import './views/feed.mjs';
import './views/social.mjs';
import './views/me.mjs';
import './views/levels.mjs';

// ---------- nav ----------
registerView('map', {});   // the base layer; no overlay of its own
initNav();

// ---------- boot ----------
// Maps JS is no longer loaded on the gate — it boots on demand in enterApp().
sb.auth.onAuthStateChange(() => route());
route();

// ---------- service worker + automatic updates ----------
// The worker force-activates a new version (skipWaiting + clients.claim in
// sw.js), which fires controllerchange here; we reload once to pick up the new
// build. No banner, no tap, no cache-clearing — a deploy just lands on the
// user's next visit. The one guard: if the rating form is open we wait for it
// to close first, so an in-progress rating is never reloaded away.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  var reloading = false;

  function applyUpdate() {
    if (reloading) return;
    var form = $('form');
    if (form && form.style.display === 'flex') {   // mid-rating → try again shortly
      setTimeout(applyUpdate, 1500);
      return;
    }
    reloading = true;
    location.reload();
  }

  navigator.serviceWorker.addEventListener('controllerchange', applyUpdate);

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js')
      .then(function (reg) { reg.update(); })   // proactively check on every load
      .catch(function () { /* SW is a nicety; ignore failures */ });
  });
}
