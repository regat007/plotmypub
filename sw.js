/**
 * PlotMyPub service worker — app shell only.
 *
 * Deliberately does NOT cache:
 *   - Supabase REST/Auth/Storage/Functions (live data + auth tokens)
 *   - Google Maps JS API and tiles (Google's ToS forbids caching tiles)
 * Everything not explicitly listed below goes straight to the network.
 *
 * Caching strategy:
 *   - navigations (index.html): network-first, so a fresh deploy lands at once
 *   - other same-origin assets: stale-while-revalidate, so they serve instantly
 *     from cache but refresh in the background for next load
 * That means a deploy is always picked up within one extra load, so bumping
 * CACHE_VERSION is only needed to purge the old cache, not to avoid staleness.
 */

const CACHE_VERSION = 'plotmypub-v7';

const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/js/app.mjs',
  '/js/config.mjs',
  '/js/core.mjs',
  '/js/api.mjs',
  '/js/auth.mjs',
  '/js/map.mjs',
  '/js/router.mjs',
  '/js/views/feed.mjs',
  '/js/views/social.mjs',
  '/js/views/me.mjs',
  '/js/views/levels.mjs',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-512-maskable.png',
  '/logo.svg'
];

// Anything matching these is always network-only.
const NEVER_CACHE = [
  'supabase.co',
  'supabase.in',
  'googleapis.com',
  'gstatic.com',
  'google.com'
];

self.addEventListener('install', function (e) {
  // skipWaiting() lets a freshly installed worker take over right away instead
  // of waiting for every tab to close. Combined with clients.claim() below and
  // the page's controllerchange→reload, this makes updates fully automatic: a
  // new deploy applies itself on the user's next visit, no action required. The
  // page defers the reload while the rating form is open so nothing is lost.
  e.waitUntil(
    caches.open(CACHE_VERSION)
      // Precache each shell file, but fetch with cache:'no-cache' so we bypass
      // the browser's HTTP disk cache (GitHub Pages sends max-age=600) and store
      // the TRUE latest bytes, not a stale copy. add() would use the HTTP cache.
      .then(function (c) {
        return Promise.all(SHELL.map(function (url) {
          return fetch(url, { cache: 'no-cache' })
            .then(function (res) { if (res && res.ok) return c.put(url, res); })
            .catch(function () { /* skip missing asset */ });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys
          .filter(function (k) { return k !== CACHE_VERSION; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin, or a live-data host → don't touch it.
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some(function (h) { return url.hostname.indexOf(h) !== -1; })) return;

  // Navigations: network first, so a fresh deploy lands immediately;
  // fall back to the cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then(function (res) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put('/index.html', copy); });
          return res;
        })
        .catch(function () {
          return caches.match('/index.html').then(function (hit) {
            return hit || Response.error();
          });
        })
    );
    return;
  }

  // Static same-origin assets: stale-while-revalidate.
  // Serve the cached copy immediately when we have one, and refresh it in the
  // background so the next load gets the newest version. This is what lets us
  // split the app into separate .css/.mjs files without a staleness trap.
  e.respondWith(
    caches.match(req).then(function (hit) {
      // Revalidate with cache:'no-cache' so the background refresh reaches the
      // server (conditional request) instead of being answered by the browser's
      // still-fresh HTTP cache — otherwise we'd keep re-storing a stale asset.
      const fetching = fetch(req, { cache: 'no-cache' }).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });   // offline → fall back to cache
      return hit || fetching;
    })
  );
});

// Lets the page trigger an immediate update (see the head snippet).
self.addEventListener('message', function (e) {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
