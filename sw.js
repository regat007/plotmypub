/**
 * PlotMyPub service worker — app shell only.
 *
 * Deliberately does NOT cache:
 *   - Supabase REST/Auth/Storage/Functions (live data + auth tokens)
 *   - Google Maps JS API and tiles (Google's ToS forbids caching tiles)
 * Everything not explicitly listed below goes straight to the network.
 *
 * Bump CACHE_VERSION on every deploy that changes index.html.
 */

const CACHE_VERSION = 'plotmypub-v1';

const SHELL = [
  '/',
  '/index.html',
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
  e.waitUntil(
    caches.open(CACHE_VERSION)
      // addAll fails the whole install if one file 404s; be forgiving.
      .then(function (c) {
        return Promise.all(SHELL.map(function (url) {
          return c.add(url).catch(function () { /* skip missing asset */ });
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
      fetch(req)
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

  // Static same-origin assets: cache first.
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});

// Lets the page trigger an immediate update (see the head snippet).
self.addEventListener('message', function (e) {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
