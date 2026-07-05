// ════════════════════════════════════════════════════════
// sw.js — Service Worker
// Cache-shell strategi: cacher app-skallet (HTML, CSS, JS)
// for rask oppstart. Firebase/Firestore-kall går alltid
// direkte til nett — aldri fra cache.
// ════════════════════════════════════════════════════════

// ── VIKTIG VED DEPLOY ───────────────────────────────────
// Øk VERSJON med 1 hver gang du pusher endringer til GitHub.
// Dette er alt som skal til for at alle mobiler automatisk
// plukker opp ny versjon neste gang de åpner appen.
// ════════════════════════════════════════════════════════
const VERSJON    = 8;                        // ← øk denne ved hver deploy
const CACHE_NAVN = `pb-jaeren-v${VERSJON}`;

const SHELL = [
  './',
  './index.html',
  './style.css',
  './turnering.css',
  './app.js',
  './state.js',
  './firebase.js',
  './konstanter.js',
  './render-helpers.js',
  './batch-helpers.js',
  './rotasjon.js',
  './rating.js',
  './ui.js',
  './admin.js',
  './lyttere.js',
  './spillere.js',
  './baner.js',
  './poeng.js',
  './resultat.js',
  './trening.js',
  './profil.js',
  './global-profil.js',
  './ledertavle.js',
  './arkiv.js',
  './utfordrer.js',
  './hall-of-fame.js',
  './turnering.js',
  './turnering-logikk.js',
  './turnering-ui.js',
  './turnering-spill-ui.js',
  './turnering-skjermer.html',
  './viewer.html',
  './mix-viewer.html',
  './mix-skjerm.html',
  './logo.svg',
  './icon-192.png',
  './icon-512.png',
];

// ── INSTALL — cach app-skallet ──────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAVN).then(cache => cache.addAll(SHELL))
  );
  // skipWaiting() umiddelbart: ny SW tar over uten å vente på at alle
  // faner lukkes. controllerchange i index.html håndterer reload.
  self.skipWaiting();
});

// ── MESSAGE — brukeren trykket "Last på nytt" ───────────
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
  self.clients.claim();
});

// ── FETCH — cache-first for shell, nett-first for alt annet ──
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // La Firebase, Firestore og Google Fonts alltid gå til nett
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

  // Cache-first for lokale filer
  // Bruk pathname uten query-parametere for cache-oppslag
  // slik at ?okt=... ikke hindrer treff på index.html eller mix-viewer.html
  // Network-first: alltid hent siste versjon fra nett
  e.respondWith(
    fetch(e.request).then(response => {
      if (e.request.method === 'GET' && response.status === 200) {
        const kopi = response.clone();
        caches.open(CACHE_NAVN).then(cache => cache.put(e.request, kopi));
      }
      return response;
    }).catch(() =>
      caches.match(e.request, { ignoreSearch: true })
        .then(cached => cached ?? caches.match('./index.html'))
    )
  );
});
