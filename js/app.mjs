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

// ---------- service worker + "new version" prompt ----------
// Instead of silently reloading under the user, we surface a small banner and
// let them tap Refresh. That also fixes the "stuck on old version" trap: a new
// worker that's already waiting (from a previous visit) still gets offered.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  var updateBar = $('updateBar');
  var updateBtn = $('updateBtn');
  var waitingSW = null;

  function offerUpdate(sw) {
    if (!sw) return;
    waitingSW = sw;
    if (updateBar) updateBar.classList.add('show');
  }

  if (updateBtn) {
    updateBtn.addEventListener('click', function () {
      updateBtn.disabled = true;
      updateBtn.textContent = 'Updating…';
      // Tell the waiting worker to take over; controllerchange then reloads us.
      if (waitingSW) waitingSW.postMessage('SKIP_WAITING');
    });
  }

  // When the fresh worker takes control, reload once to pick up the new app.
  var reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').then(function (reg) {
      // Case 1: a new worker installed on a previous visit is already waiting.
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);

      // Case 2: a new worker is found now — offer it once it finishes installing
      // (only when there's already a controller, i.e. this isn't the first ever load).
      reg.addEventListener('updatefound', function () {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', function () {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(sw);
        });
      });

      // Proactively check for a new version on every load.
      reg.update();
    }).catch(function () { /* SW is a nicety; ignore failures */ });
  });
}
