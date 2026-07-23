// PlotMyPub — entry point. Importing auth (which pulls in map → api → core)
// runs every module's top-level DOM wiring, then we kick off routing and
// register the service worker.

import { sb } from './core.mjs';
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

// ---------- service worker (Phase 7.5) ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').then(function (reg) {
      // A new version is waiting -> activate it, then reload once.
      reg.addEventListener('updatefound', function () {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', function () {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            sw.postMessage('SKIP_WAITING');
          }
        });
      });
    }).catch(function () { /* SW is a nicety; ignore failures */ });

    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  });
}
