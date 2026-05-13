import {
  db, SAM,
  collection, doc, addDoc, updateDoc, getDoc, getDocs,
  query, where, orderBy, limit, serverTimestamp, writeBatch, runTransaction,
} from './firebase.js';
import { app, erMix } from './state.js';
import {
  getParter, blandArray, beregnPoengForKamp,
  fordelBaner, fordelBanerMix,
  lagMixKampoppsett, oppdaterMixStatistikk, hentMixStatistikk,
  neste6SpillerRunde,
} from './rotasjon.js';
import {
  getNivaaKlasse, getNivaaLabel, getNivaaRatingHTML,
  eloForventet, oppdaterRatingForKamp, beregnEloForOkt, beregnTrend,
} from './rating.js';
import {
  visMelding, visFBFeil, escHtml,
  lasUI, frigiUI, startFailSafe, stoppFailSafe,
  registrerNavigertHandler, registrerBeforeunload,
  registrerProfilCallbacks, registrerHarAktivOkt,
} from './ui.js';
import {
  krevAdmin as _krevAdminBase, pinInput, bekreftPin, lukkPinModal,
  getErAdmin, setErAdmin, nullstillAdmin, registrerPinGetter,
  registrerKlubbIdGetter, gjenopprettAdminStatus,
} from './admin.js';
import {
  lyttPaaSpillere as _lyttPaaSpillere,
  startLyttere as _startLyttere,
  stoppLyttere,
  startKampLytter as _startKampLytter,
  startOktOppstartsLytter as _startOktOppstartsLytter,
  stoppOktOppstartsLytter as _stoppOktOppstartsLytter,
} from './lyttere.js';
import {
  setAktivKlubbId as _setSpillereKlubbId,
  setKrevAdmin as _setSpillereKrevAdmin,
  nullstillSisteDeltakereCache,
  visSpillere,
  lastSisteDeltakere,
  toggleSisteDeltakere,
  getSisteDeltakereApen,
  setSisteDeltakereCache,
} from './spillere.js';
import {
  treningInit,
  startTrening, delLenke,
  visNesteRundeModal, bekreftNesteRunde,
  visAvsluttModal, avsluttTreningUI,
  nyTrening,
  gjenopprettTrening, autoAvsluttGamleTreninger,
  oppdaterAvbrytKnapp, visAvbrytOktModal, utforAvbrytOkt,
  seedDemoDataOmNødvendig,
  leggTilSpillerIOkt, fjernSpillerFraOkt,
} from './trening.js';
import {
  banerInit,
  setKampStatusCache, getKampStatusCache,
  oppdaterRundeUI, visBanerDebounced, oppdaterKampStatus, visBaner,
  apnePoenginput, navigerBane, oppdaterPoengNav,
  visDeltakerModal,
} from './baner.js';
import {
  poengInit,
  validerInndata, autolagreKamp, lukkTastaturOgScrollTilLagre, lesOgValiderPoeng,
} from './poeng.js';
import {
  resultatInit,
  visRundeResultat, beregnForflytninger,
  visSluttresultat,
} from './resultat.js';
import { profilInit, apneProfil } from './profil.js';
import {
  ledertavleInit,
  oppdaterGlobalLedertavle,
  visNullstillModal, utforNullstill,
} from './ledertavle.js';
import { globalProfilInit } from './global-profil.js';
import {
  utfordrerInit,
  sjekkVentendeUtfordringer, nullstillUtfordringBadge,
  visUtfordrerSkjerm,
  startUtfordrerLytter, stoppUtfordrerLytter,
} from './utfordrer.js';
import {
  arkivInit,
  lastArkiv, apneTreningsdetaljFraDom, apneTreningsdetalj,
  visSlettOktModal, utforSlettOkt,
  visSlettAlleOkterModal, utforSlettAlleOkter,
} from './arkiv.js';
import {
  turneringInit,
} from './turnering.js';
import {
  turneringUIInit,
  visTurneringOversikt,
  visOppsett as visTurneringOppsett,
} from './turnering-ui.js';
import {
  visPulje as visTurneringPulje,
  visBracket as visTurneringBracket,
  visResultat as visTurneringResultat,
} from './turnering-spill-ui.js';
// ════════════════════════════════════════════════════════
// KLUBB-KONFIGURASJON
// ════════════════════════════════════════════════════════
const KLUBBER = {
  'pickleball-jaeren': { navn: 'Pickleball Jæren', pin: '9436', demo: false },
  'fokus-pickleball':  { navn: 'Fokus Pickleball',  pin: '4350', demo: false },
  'demo':              { navn: 'Demo',               pin: null,   demo: true  },
};

// Aktiv klubb — settes av byttKlubb()
let aktivKlubbId = null;

function getAktivKlubb() {
  return aktivKlubbId ? (KLUBBER[aktivKlubbId] ?? null) : null;
}

// Admin-PIN for aktiv klubb (null = ingen PIN = demo)
function getAdminPin() {
  return getAktivKlubb()?.pin ?? null;
}

// Lokal wrapper — tilføyer demo-modus-flagget til hvert krevAdmin-kall
// slik at alle eksisterende kallsteder ikke trenger å endres.
function krevAdminMedDemo(tittel, tekst, callback) {
  _krevAdminBase(tittel, tekst, callback, !!getAktivKlubb()?.demo);
}
// Overstyr window.krevAdmin slik at inline onclick-attributter også bruker wrapperen
window.krevAdmin = krevAdminMedDemo;

function byttKlubb(klubbId) {
  // Stopp alle lyttere fra forrige klubb før vi bytter
  stoppUtfordrerLytter();
  stoppLyttere();
  _stoppOktOppstartsLytter();

  if (!klubbId || !KLUBBER[klubbId]) {
    aktivKlubbId = null;
    oppdaterKlubbUI();
    return;
  }
  const forrigeKlubbId = aktivKlubbId;
  aktivKlubbId = klubbId;
  registrerKlubbIdGetter(() => aktivKlubbId);

  // Nullstill kun om vi faktisk bytter til en annen klubb
  if (forrigeKlubbId && forrigeKlubbId !== klubbId) {
    nullstillAdmin();
  }

  // Gjenopprett admin-status fra localStorage (overlever lukket fane)
  const erAdminFraForrige = gjenopprettAdminStatus();
  if (!erAdminFraForrige) {
    setErAdmin(KLUBBER[klubbId].demo); // demo-modus: alltid admin
  }
  nullstillSisteDeltakereCache();
  _setSpillereKlubbId(klubbId);
  oppdaterKlubbUI();
  // Start opp for valgt klubb
  initEtterKlubbValg();
  visMelding('Klubb valgt: ' + KLUBBER[klubbId].navn);
}
window.byttKlubb = byttKlubb;
window._app = app;

/** Lagrer hvilken spiller brukeren er — brukes i utfordrermodusen. */
window.settAktivSpiller = function(spillerId) {
  if (spillerId) sessionStorage.setItem('aktivSpillerId', spillerId);
  else           sessionStorage.removeItem('aktivSpillerId');
};

// ── Tilskuerskjerm-logikk ─────────────────────────────────────────────────
// Ikke-admin deltakere låses til tilskuerskjermen under aktiv økt.
// Admin navigerer fritt og styrer hva tilskuerskjermen viser.

function _navigerTilskuer(adminSkjerm) {
  if (getErAdmin()) return; // admin navigerer selv
  if (!app._oektAktiv) return; // ingen aktiv økt

  // Ikke avbryt pågående poengregistrering — tilskueren fullfører først
  const aktivSkjerm = document.querySelector('.screen.active');
  if (aktivSkjerm?.id === 'skjerm-poeng') return;

  if (adminSkjerm === 'resultat') {
    visRundeResultat();
  } else {
    naviger('tilskuer');
    oppdaterTilskuerInnhold();
  }
}

function oppdaterTilskuerInnhold() {
  // Oppdater runde-header
  const rundeEl   = document.getElementById('tilskuer-runde-hdr');
  const maksEl    = document.getElementById('tilskuer-maks-runder-hdr');
  const subEl     = document.getElementById('tilskuer-hdr-sub');
  const indEl     = document.getElementById('tilskuer-indikator-tekst');
  if (rundeEl) rundeEl.textContent = app.runde ?? 1;
  if (subEl)   subEl.textContent   = 'Baneoversikt';
  if (indEl)   indEl.textContent   = `Runde ${app.runde ?? 1} pågår`;

  // Gjenbruk bane-liste fra skjerm-baner
  const baneListeEl = document.getElementById('bane-liste');
  const tilskuerEl  = document.getElementById('tilskuer-innhold');
  if (baneListeEl && tilskuerEl) {
    tilskuerEl.innerHTML = baneListeEl.innerHTML;
  }
}
window.oppdaterTilskuerInnhold = oppdaterTilskuerInnhold; // brukes av utfordrermodusen for spillerlisten

function oppdaterKlubbUI() {
  const klubb    = getAktivKlubb();
  const navn     = klubb?.navn ?? '';
  const erDemo   = klubb?.demo ?? false;

  // Oppdater klubbnavn i alle headere
  document.querySelectorAll('[id$="klubbnavn"], .app-name[id="oppsett-klubbnavn"]').forEach(el => {
    el.textContent = navn || 'Pickleball';
  });

  // Vis/skjul demo-info
  const demoInfo = document.getElementById('demo-info');
  if (demoInfo) demoInfo.style.display = erDemo ? 'block' : 'none';

  // Sett riktig verdi i select
  const velger = document.getElementById('klubb-velger');
  if (velger && aktivKlubbId) velger.value = aktivKlubbId;

  // Oppdater app-sub (under klubbnavnet) på oppsett-skjermen
  const appSub = document.querySelector('#skjerm-oppsett .app-sub');
  if (appSub) appSub.textContent = 'Americano' + (erDemo ? ' · Demo' : '');
}

/**
 * Bytter spillmodus basert på brukervalg i oppsett-skjermen.
 * Oppdaterer app.spillModus og justerer UI-elementer deretter.
 * @param {'konkurranse'|'mix'} modus
 */
function settSpillModus(modus) {
  app.spillModus = modus;

  // Mix: scoringsformat ikke relevant — tilbakestill til americano
  if (modus === 'mix') settScoringFormat('americano');

  // Oppdater knappestiler
  const btnKonk = document.getElementById('modus-knapp-konkurranse');
  const btnMix  = document.getElementById('modus-knapp-mix');
  if (btnKonk) btnKonk.classList.toggle('modus-aktiv', modus === 'konkurranse');
  if (btnMix)  btnMix.classList.toggle('modus-aktiv',  modus === 'mix');

  // Vis/skjul info-boks for valgt modus
  const infoKonk = document.getElementById('modus-info-konkurranse');
  const infoMix  = document.getElementById('modus-info-mix');
  if (infoKonk) infoKonk.style.display = modus === 'konkurranse' ? 'block' : 'none';
  if (infoMix)  infoMix.style.display  = modus === 'mix'         ? 'block' : 'none';

  // Vis/skjul scoringsformat-velger (kun relevant for konkurranse)
  const scoringVelger = document.getElementById('scoring-format-velger');
  if (scoringVelger) scoringVelger.style.display = modus === 'konkurranse' ? 'block' : 'none';

  // Oppdater spillerliste — viser/skjuler rating basert på modus
  visSpillere();
}
window.settSpillModus = settSpillModus;

/**
 * Bytter scoringsformat i konkurransemodus.
 * @param {'americano'|'best_of_3'} format
 */
function settScoringFormat(format) {
  app.scoringsFormat = format;

  const btnAm  = document.getElementById('scoring-knapp-americano');
  const btnB3  = document.getElementById('scoring-knapp-best3');
  if (btnAm) btnAm.classList.toggle('modus-aktiv', format === 'americano');
  if (btnB3)  btnB3.classList.toggle('modus-aktiv',  format === 'best_of_3');

  // Skjul poeng-per-kamp-trinnet når best av 3 er valgt
  const poengTrinn = document.getElementById('poeng-per-kamp-trinn');
  if (poengTrinn) poengTrinn.style.display = format === 'best_of_3' ? 'none' : '';

  // Vis riktig info-tekst
  const infoAm = document.getElementById('scoring-info-americano');
  const infoB3 = document.getElementById('scoring-info-best3');
  if (infoAm) infoAm.style.display = format === 'americano' ? 'block' : 'none';
  if (infoB3) infoB3.style.display = format === 'best_of_3' ? 'block' : 'none';
}
window.settScoringFormat = settScoringFormat;

// ════════════════════════════════════════════════════════
// HJEMSKJERM
// ════════════════════════════════════════════════════════

/**
 * Oppdaterer status-seksjonen på hjemskjermen basert på app-tilstand.
 * Kalles automatisk via naviger('hjem').
 */
function visHjemStatus() {
  const dot        = document.getElementById('hjem-status-dot');
  const tekst      = document.getElementById('hjem-status-tekst');
  const sub        = document.getElementById('hjem-status-sub');
  const fortsett   = document.getElementById('hjem-fortsett-knapp');
  const startKnapp = document.getElementById('hjem-start-knapp');

  const harOkt = !!app.treningId;

  if (dot) dot.classList.toggle('aktiv', harOkt);

  if (harOkt) {
    if (tekst) tekst.textContent = erMix() ? '🎲 Mix & Match pågår' : '🟢 Økt pågår';
    if (sub)   sub.textContent   = erMix() ? `Kamp ${app.runde}` : `Runde ${app.runde}`;
    if (fortsett)   fortsett.style.display   = 'block';
    if (startKnapp) startKnapp.textContent   = 'START NY ØKT';
  } else {
    if (tekst) tekst.textContent = 'Ingen aktiv økt';
    if (sub)   sub.textContent   = '';
    if (fortsett)   fortsett.style.display   = 'none';
    if (startKnapp) startKnapp.textContent   = 'START NY ØKT';
  }
}
window.visHjemStatus = visHjemStatus;

/**
 * Sett logo-bilde på hjemskjermen.
 * Kall denne med filsti etter at logoen er tilgjengelig.
 * Eksempel: settHjemLogo('/logo.png')
 */
function settHjemLogo(src) {
  const img = document.getElementById('hjem-logo-img');
  if (img) img.src = src;
}
window.settHjemLogo = settHjemLogo;

window.visDelAppModal = function() {
  krevAdminMedDemo('Del appen', 'Kun administrator kan dele applenken.', () => {
    const url = location.href.replace(/[?#].*$/, '');
    document.getElementById('del-app-url-tekst').textContent = url;
    document.getElementById('del-app-kopiert').textContent = '';
    document.getElementById('modal-del-app').style.display = 'flex';

    setTimeout(() => {
      const boks = document.getElementById('del-app-qr-innhold');
      if (!boks) return;
      boks.innerHTML = '';
      if (typeof QRCode !== 'undefined') {
        new QRCode(boks, {
          text:         url,
          width:        132,
          height:       132,
          colorDark:    '#000000',
          colorLight:   '#ffffff',
          correctLevel: QRCode.CorrectLevel.M,
        });
      } else {
        boks.innerHTML = `<div style="font-size:11px;color:#333;word-break:break-all;padding:4px">${url}</div>`;
      }
    }, 50);
  });
};

window.lukkDelAppModal = function() {
  document.getElementById('modal-del-app').style.display = 'none';
};

window.kopierAppUrl = async function() {
  const url = document.getElementById('del-app-url-tekst').textContent;
  try {
    await navigator.clipboard.writeText(url);
    const el = document.getElementById('del-app-kopiert');
    el.textContent = '✓ Lenke kopiert!';
    setTimeout(() => { el.textContent = ''; }, 2500);
  } catch (e) {
    visMelding('Kunne ikke kopiere — kopier manuelt.', 'advarsel');
  }
};

// ════════════════════════════════════════════════════════
// OPPSETT — TRINNVELGERE
// ════════════════════════════════════════════════════════
function juster(key, dir) {
  if (key === 'baner')  app.antallBaner  = Math.max(1, Math.min(7,  app.antallBaner  + dir));
  if (key === 'poeng')  app.poengPerKamp = Math.max(5, Math.min(50, app.poengPerKamp + dir));
  document.getElementById('verdi-baner').textContent  = app.antallBaner;
  document.getElementById('verdi-poeng').textContent  = app.poengPerKamp;
  document.getElementById('maks-hint').textContent    = app.poengPerKamp;
  visSpillere(); // visSpillere oppdaterer spiller-info og min-antall dynamisk
}
window.juster = juster;

// ════════════════════════════════════════════════════════
// SPILLERLISTE — delegerer til lyttere.js
// ════════════════════════════════════════════════════════
function lyttPaaSpillere() {
  _lyttPaaSpillere(aktivKlubbId, {
    onSpillere: () => {
      visSpillere();
      oppdaterGlobalLedertavle();
      sjekkVentendeUtfordringer();
      // Forhåndslast cache i bakgrunnen uten å åpne panelet
      lastSisteDeltakere();
    },
  });
}

// ════════════════════════════════════════════════════════
// OPPSTARTSLYTTER — felles hjelpefunksjon
// Starter lytteren som fanger opp ny økt fra admin.
// Kalles etter avsluttet/avbrutt økt og ved ingen aktiv økt ved oppstart.
function _startVentPaaOkt() {
  _startOktOppstartsLytter(aktivKlubbId, {
    onNyOktFunnet: async (treningId) => {
      const ok = await gjenopprettTrening(treningId);
      if (ok) {
        visMelding('Økt startet — kobler til…');
      } else {
        // Gjenoppretting feilet — start lytteren på nytt så vi ikke mister neste økt
        _startVentPaaOkt();
      }
    },
  });
}

// ════════════════════════════════════════════════════════
function _lyttereCallbacks() {
  return {
    onOktOppdatert:    ()  => { oppdaterRundeUI(); visBanerDebounced(); oppdaterTilskuerInnhold(); },
    onNyRunde:           ()  => { setKampStatusCache({}); _navigerTilskuer('baner'); },
    onOktAvsluttet:      ()  => {
      app._oektAktiv = false;
      app.treningId  = null;
      stoppLyttere();
      naviger('slutt');
      visHjemStatus();
      // Restart oppstartslytter så tilskuer automatisk kobles til neste økt
      _startVentPaaOkt();
    },
    onOktAvbrutt:        ()  => {
      // Økt avbrutt av admin (slettet fra Firestore) — send alle til hjemskjermen
      app._oektAktiv = false;
      app.treningId  = null;
      stoppLyttere();
      naviger('hjem');
      visHjemStatus();
      // Restart oppstartslytter så tilskuer automatisk kobles til neste økt
      _startVentPaaOkt();
    },
    onVisResultater:     ()  => { app._oektAktiv = false; naviger('slutt'); },
    onVisRundeResultat:  async () => { await visRundeResultat(); },
    onAdminSkjermEndret: (skjerm) => _navigerTilskuer(skjerm),
    onKamper:          (k) => oppdaterKampStatus(k),
    onKampStatusReset: ()  => setKampStatusCache({}),
  };
}

function startKampLytter() {
  _startKampLytter(_lyttereCallbacks());
}

function startLyttere() {
  _startLyttere(_lyttereCallbacks());
}

// ════════════════════════════════════════════════════════
// ØKTARKIV
// ── arkiv.js: lastArkiv, apneTreningsdetalj, slettOkt, slettAlleOkter ──
// ════════════════════════════════════════════════════════

async function init() {
  // Koble admin.js til app-spesifikk PIN-logikk
  registrerPinGetter(() => getAdminPin() ?? '');
  registrerKlubbIdGetter(() => aktivKlubbId ?? '');
  _setSpillereKrevAdmin(krevAdminMedDemo);

  // Koble profil.js (økt-profil)
  profilInit({ naviger });

  // Koble ledertavle.js
  ledertavleInit({ krevAdmin: krevAdminMedDemo });

  // Koble global-profil.js
  globalProfilInit({ naviger });

  // Koble utfordrer.js
  utfordrerInit({
    getAktivKlubbId:   () => aktivKlubbId,
    getAktivSpillerId: () => sessionStorage.getItem('aktivSpillerId'),
  });

  // Registrer profil-callbacks i ui.js (erstatter window-globals)
  registrerProfilCallbacks({
    nullstillUtfordringBadge,
    visUtfordrerSkjerm,
  });

  // Koble arkiv.js
  arkivInit({
    naviger:         naviger,
    krevAdmin:       krevAdminMedDemo,
    getAktivKlubbId: () => aktivKlubbId,
  });

  // Koble turnering.js
  turneringInit({
    naviger:         naviger,
    krevAdmin:       krevAdminMedDemo,
    getAktivKlubbId: () => aktivKlubbId,
  });

  // Koble turnering-ui.js
  turneringUIInit({
    naviger:   naviger,
    krevAdmin: krevAdminMedDemo,
  });

  // Koble resultat.js
  resultatInit({
    naviger:           naviger,
    krevAdmin:         krevAdminMedDemo,
    visAvsluttModal:   visAvsluttModal,
    bekreftNesteRunde: bekreftNesteRunde,
  });

  // Koble poeng.js
  poengInit({
    oppdaterPoengNav: oppdaterPoengNav,
  });

  // Koble baner.js
  banerInit({
    naviger:              naviger,
    oppdaterAvbrytKnapp:  oppdaterAvbrytKnapp,
    getAktivKlubbId:      () => aktivKlubbId,
  });

  // Koble trening.js
  treningInit({
    getAktivKlubbId:        () => aktivKlubbId,
    krevAdmin:              krevAdminMedDemo,
    getKampStatusCache:     getKampStatusCache,
    setKampStatusCache:     setKampStatusCache,
    startLyttere:           startLyttere,
    stoppLyttere:           stoppLyttere,
    startKampLytter:        startKampLytter,
    oppdaterRundeUI:        oppdaterRundeUI,
    naviger:                naviger,
    visSpillere:            visSpillere,
    toggleSisteDeltakere:   toggleSisteDeltakere,
    getSisteDeltakereApen:  getSisteDeltakereApen,
    setSisteDeltakereCache: setSisteDeltakereCache,
  });

  // Koble ui.js til app-spesifikk logikk
  registrerNavigertHandler(skjerm => {
    if (skjerm === 'baner')    { app._oektAktiv = true; visBaner(); oppdaterTilskuerInnhold(); }
    if (skjerm === 'slutt')    visSluttresultat();
    if (skjerm === 'spillere') oppdaterGlobalLedertavle();
    if (skjerm === 'arkiv')    lastArkiv();
    if (skjerm === 'hjem')     visHjemStatus();
    // Start sanntidslytter på utfordrer-skjermen, stopp ved navigering bort
    if (skjerm === 'utfordrer') startUtfordrerLytter();
    else stoppUtfordrerLytter();
    if (skjerm === 'turnering')          visTurneringOversikt();
    if (skjerm === 'turnering-oppsett')  { const t = app.aktivTurnering; if (t) visTurneringOppsett(t); }
    if (skjerm === 'turnering-pulje')    { const t = app.aktivTurnering; if (t) visTurneringPulje(t);   }
    if (skjerm === 'turnering-bracket')  { const t = app.aktivTurnering; if (t) visTurneringBracket(t); }
    if (skjerm === 'turnering-resultat') { const t = app.aktivTurnering; if (t) visTurneringResultat(t);}
  });
  registrerBeforeunload(() => !!app.treningId);
  registrerHarAktivOkt(() => !!app.treningId);

  // Eksponer getErAdmin globalt for inline onclick-attributter
  window.getErAdmin = getErAdmin;
  window.leggTilSpillerIOkt = leggTilSpillerIOkt;
  window.fjernSpillerFraOkt = fjernSpillerFraOkt;
  window.visDeltakerModal   = visDeltakerModal;

  if (!db) {
    visFBFeil('Firebase er ikke konfigurert. Oppdater FB_CONFIG øverst i skriptet.');
    return;
  }

  // Vis hjemskjerm alltid ved oppstart — bruker velger klubb der
  naviger('hjem');
  return;
}

async function initEtterKlubbValg() {
  if (!db || !aktivKlubbId) return;

  // Seed demo-data om nødvendig (kjører kun for demo-klubben og kun én gang)
  await seedDemoDataOmNødvendig();

  lyttPaaSpillere();

  // Kjør auto-avslutning stille i bakgrunnen — blokkerer ikke oppstarten
  autoAvsluttGamleTreninger();

  try {
    // Steg 0: sjekk URL-parameter ?okt= (delt lenke)
    const urlParams = new URLSearchParams(location.search);
    const urlOktId = urlParams.get('okt');
    if (urlOktId) {
      const ok = await gjenopprettTrening(urlOktId);
      if (ok) { visMelding('Koblet til økt!'); return; }
      // Ugyldig/gammel økt-ID i URL — fortsett normalt
      try { history.replaceState(null, '', location.pathname); } catch (_) {}
    }

    // Steg 1: prøv sessionStorage (raskest) eller localStorage (overlever lukket fane)
    // Sjekk at lagret økt tilhører samme klubb som er valgt nå.
    const lagretId =
      sessionStorage.getItem('aktivTreningId') ??
      localStorage.getItem('aktivTreningId');
    const lagretKlubbId =
      sessionStorage.getItem('aktivTreningKlubbId') ??
      localStorage.getItem('aktivTreningKlubbId');

    if (lagretId && lagretKlubbId === aktivKlubbId) {
      const ok = await gjenopprettTrening(lagretId);
      if (ok) { visMelding('Økt gjenopprettet'); return; }
      sessionStorage.removeItem('aktivTreningId');
      sessionStorage.removeItem('aktivTreningKlubbId');
      localStorage.removeItem('aktivTreningId');
      localStorage.removeItem('aktivTreningKlubbId');
    } else if (lagretId && lagretKlubbId !== aktivKlubbId) {
      // Økt tilhører annen klubb — ikke forsøk gjenoppretting
      sessionStorage.removeItem('aktivTreningId');
      sessionStorage.removeItem('aktivTreningKlubbId');
      localStorage.removeItem('aktivTreningId');
      localStorage.removeItem('aktivTreningKlubbId');
    }

    // Steg 2: søk i Firestore etter nyeste aktive økt
    // (fanger opp tilfeller der sessionStorage er tom — ny fane, annen enhet, osv.)
    // Merk: ingen orderBy her — unngår krav om sammensatt Firestore-indeks.
    // Det skal aldri være mer enn én aktiv økt av gangen.
    const aktivSnap = await getDocs(
      query(
        collection(db, SAM.TRENINGER),
        where('status', '==', 'aktiv'),
        where('klubbId', '==', aktivKlubbId),
        limit(1)
      )
    );

    if (!aktivSnap.empty) {
      const treningId = aktivSnap.docs[0].id;
      const ok = await gjenopprettTrening(treningId);
      if (ok) { visMelding('Økt gjenopprettet'); return; }
      // Økt finnes men ble avvist (for gammel) — meldingen er allerede vist
    }
  } catch (e) {
    console.warn('Gjenoppretting feilet:', e?.message ?? e);
    sessionStorage.removeItem('aktivTreningId'); sessionStorage.removeItem('aktivTreningKlubbId'); localStorage.removeItem('aktivTreningId'); localStorage.removeItem('aktivTreningKlubbId');
    visMelding('Kunne ikke gjenopprette økt: ' + (e?.message ?? 'ukjent feil'), 'feil');
  }

  // Ingen aktiv økt funnet — start lytter som fanger opp når admin oppretter økt
  // mens tilskuer allerede er i appen. Lytteren stopper seg selv så snart en økt dukker opp.
  _startVentPaaOkt();
  try { history.replaceState(null, '', location.pathname); } catch (_) {}
}

init();

// Når bruker kommer tilbake til appen etter å ha hatt den i bakgrunnen,
// sjekk om runden har endret seg eller økten er avsluttet.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') {
    stoppUtfordrerLytter(); // frigjør lytter når app er i bakgrunnen
    return;
  }
  // Restart utfordrer-lytter hvis utfordrer-skjermen er aktiv
  if (document.getElementById('skjerm-utfordrer')?.classList.contains('active')) {
    startUtfordrerLytter();
  }
  // Tilskuer i ventemodus (ingen aktiv økt) — sjekk om admin har startet en ny økt
  if (!db) return;
  if (!app.treningId) {
    if (aktivKlubbId) {
      try {
        const snap = await getDocs(
          query(collection(db, SAM.TRENINGER),
            where('status', '==', 'aktiv'),
            where('klubbId', '==', aktivKlubbId),
            limit(1)
          )
        );
        if (!snap.empty) {
          const ok = await gjenopprettTrening(snap.docs[0].id);
          if (ok) visMelding('Økt startet — kobler til…');
          else _startVentPaaOkt();
        }
      } catch (_) {}
    }
    return;
  }
  try {
    const snap = await getDoc(doc(db, SAM.TRENINGER, app.treningId));
    if (!snap.exists()) return;
    const data = snap.data() ?? {};

    // Økt avsluttet av admin mens bruker var borte
    if (data.status === 'avsluttet') {
      if (app.treningId) sessionStorage.setItem('aktivTreningId', app.treningId);
      stoppLyttere();
      naviger('slutt');
      return;
    }

    // Ny runde startet av admin mens bruker var borte
    const nyRunde = data.gjeldendRunde ?? app.runde;
    if (nyRunde > app.runde) {
      app.runde = nyRunde;
      app._oektAktiv = true;
      oppdaterRundeUI();
      startKampLytter();
      visBanerDebounced();
      if (getErAdmin()) naviger('baner');
      else { naviger('tilskuer'); oppdaterTilskuerInnhold(); }
    }
  } catch (_) {}
});
