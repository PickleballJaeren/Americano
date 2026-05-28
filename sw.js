// ════════════════════════════════════════════════════════
// sw.js — Service Worker
// Strategi:
//   JS/CSS/HTML  → Network-first (alltid siste versjon)
//   Bilder/ikoner → Cache-first  (endres sjelden)
//   Firebase      → Alltid nett
//
// Oppdateringsflyt:
//   Ny SW installeres → skipWaiting() kalles umiddelbart
//   → clients.claim() → alle faner får ny versjon uten
//   at brukeren må gjøre noe.
// ════════════════════════════════════════════════════════

const CACHE_NAVN = 'pb-jaeren-v3';

const SHELL_STATISK = [
  './logo.svg',
  './icon-192.png',
  './icon-512.png',
];

// ── INSTALL — cach kun statiske filer ──────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAVN).then(cache => cache.addAll(SHELL_STATISK))
  );
  // Ta over umiddelbart — ingen ventetid på fane-lukking
  self.skipWaiting();
});

// ── MESSAGE ─────────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── ACTIVATE — rydd opp gamle cacher ───────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAVN)
          .map(k => caches.delete(k))
      )
    )
  );
  // Overta alle åpne faner umiddelbart
  self.clients.claim();
});

// ── FETCH ───────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Firebase/Firestore/Google — alltid nett, aldri cache
  const erEkstern =
    url.hostname.includes('firebase') ||
    url.hostname.includes('firestore') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('gstatic') ||
    url.hostname.includes('fonts.g');

  if (erEkstern) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Bilder og ikoner — cache-first (endres ikke ofte)
  const erStatisk = /\.(png|jpg|jpeg|svg|ico|webp)$/.test(url.pathname);
  if (erStatisk) {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res.status === 200) {
            const kopi = res.clone();
            caches.open(CACHE_NAVN).then(c => c.put(e.request, kopi));
          }
          return res;
        });
      })
    );
    return;
  }

  // JS, CSS, HTML — network-first med cache-fallback
  // Brukerne får alltid siste versjon når de er online.
  // Ved nettverksfeil brukes cached versjon.
  e.respondWith(
    fetch(e.request).then(response => {
      if (e.request.method === 'GET' && response.status === 200) {
        const kopi = response.clone();
        caches.open(CACHE_NAVN).then(cache =>
          cache.put(e.request, kopi)
        );
      }
      return response;
    }).catch(() =>
      caches.match(e.request, { ignoreSearch: true })
        .then(cached => cached ?? caches.match('./index.html'))
    )
  );
});
