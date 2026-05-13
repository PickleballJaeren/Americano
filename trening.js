// ════════════════════════════════════════════════════════
// trening.js — start økt, neste runde, avslutt økt
// ════════════════════════════════════════════════════════
import {
  db, SAM, STARTRATING, PARTER_6_DOBBEL, PARTER_6_SINGEL,
  collection, doc, getDocs, getDoc, updateDoc,
  query, where, limit, serverTimestamp, writeBatch, runTransaction,
} from './firebase.js';
import { app, erMix } from './state.js';
import {
  getParter, blandArray,
  fordelBaner, fordelBanerMix,
  lagMixKampoppsett, oppdaterMixStatistikk, hentMixStatistikk,
  neste6SpillerRunde, oppdater6SpillerStreak, hent6SpillerStreak,
} from './rotasjon.js';
import { beregnEloForOkt } from './rating.js';
import {
  visMelding, visFBFeil,
  lasUI, frigiUI, startFailSafe, stoppFailSafe,
} from './ui.js';
import { setErAdmin } from './admin.js';

// ── Avhengigheter injisert fra app.js via treningInit() ──────────────────────
let _getAktivKlubbId        = () => null;
let _krevAdmin              = () => {};
let _getKampStatusCache     = () => ({});
let _setKampStatusCache     = (v) => {};
let _startLyttere           = () => {};
let _stoppLyttere           = () => {};
let _startKampLytter        = () => {};
let _oppdaterRundeUI        = () => {};
let _naviger                = () => {};
let _visSpillere            = () => {};
let _toggleSisteDeltakere   = () => {};
let _getSisteDeltakereApen  = () => false;
let _setSisteDeltakereCache = () => {};

export function treningInit(deps) {
  _getAktivKlubbId        = deps.getAktivKlubbId;
  _krevAdmin              = deps.krevAdmin;
  _getKampStatusCache     = deps.getKampStatusCache;
  _setKampStatusCache     = deps.setKampStatusCache;
  _startLyttere           = deps.startLyttere;
  _stoppLyttere           = deps.stoppLyttere;
  _startKampLytter        = deps.startKampLytter;
  _oppdaterRundeUI        = deps.oppdaterRundeUI;
  _naviger                = deps.naviger;
  _visSpillere            = deps.visSpillere;
  _toggleSisteDeltakere   = deps.toggleSisteDeltakere;
  _getSisteDeltakereApen  = deps.getSisteDeltakereApen;
  _setSisteDeltakereCache = deps.setSisteDeltakereCache;
}

/**
 * Henter gjeldende treningsdokument fra Firestore.
 * @returns {Promise<{id, data}>}
 */
async function hentTrening() {
  if (!app.treningId) throw new Error('Ingen aktiv økt.');
  const snap = await getDoc(doc(db, SAM.TRENINGER, app.treningId));
  if (!snap.exists()) throw new Error('Øktdokument ikke funnet.');
  return { id: snap.id, data: snap.data() };
}

/**
 * Setter lås på treningsdokumentet via transaksjon.
 * Stopper hvis allerede låst, avsluttet, eller runden ikke stemmer.
 * @param {number|null} forventetRunde — hvis satt, sjekkes mot Firestore-runden
 * @returns {Promise<object>} treningsdata
 */
async function lassTrening(forventetRunde = null) {
  let treningsData = null;

  await runTransaction(db, async (tx) => {
    const ref  = doc(db, SAM.TRENINGER, app.treningId);
    const snap = await tx.get(ref);

    if (!snap.exists())              throw new Error('Økt ikke funnet.');
    const data = snap.data();

    if (data.status !== 'aktiv')     throw new Error('Økten er allerede avsluttet.');
    if (data.laast === true)         throw new Error('En annen bruker jobber akkurat nå. Vent litt og prøv igjen.');

    if (forventetRunde !== null && data.gjeldendRunde !== forventetRunde) {
      throw new Error(`Runden har blitt oppdatert av en annen bruker (runde ${data.gjeldendRunde}). Last siden på nytt.`);
    }

    tx.update(ref, { laast: true });
    treningsData = data;
  });

  return treningsData;
}

/**
 * Løser låsen på treningsdokumentet.
 */
async function lossTrening() {
  if (!app.treningId || !db) return;
  try {
    await updateDoc(doc(db, SAM.TRENINGER, app.treningId), { laast: false });
  } catch (e) {
    console.warn('[Lås] Kunne ikke løse lås:', e?.message ?? e);
  }
}// ════════════════════════════════════════════════════════
// START ØKT
// ════════════════════════════════════════════════════════
export async function startTrening() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }
  if (!_getAktivKlubbId()) { visMelding('Velg en klubb først.', 'advarsel'); return; }
  // 6-spiller-format: nøyaktig 6 spillere og 2 baner
  const er6SpillerFormat = app.antallBaner === 2 && app.valgtIds.size === 6;
  const min = er6SpillerFormat ? 6 : app.antallBaner * 4;
  if (app.valgtIds.size < min) return;

  const valgte = [...app.valgtIds]
    .map(id => (app.spillere ?? []).find(s => s.id === id))
    .filter(Boolean);

  if (valgte.length < min) {
    visMelding('Noen valgte spillere finnes ikke lenger i databasen.', 'advarsel');
    return;
  }

  // ── Fordel spillere på baner ─────────────────────────────────────────────
  // KONKURRANSE : rating-sortert fordeling (beste øverst)
  // MIX         : smart matchmaking — minimerer partner/motstander-gjentakelse
  // 6-spiller/2-baner: alltid dobbel (4 spl) + singel (2 spl) uansett modus
  let baneOversikt, mixHviler = [];
  if (erMix()) {
    if (er6SpillerFormat) {
      // 6-spiller mix: tilfeldig fordeling til dobbel + singel
      const blandede = blandArray([...valgte]);
      const mp = app.poengPerKamp ?? 15;
      const dblSpl = blandede.slice(0, 4).map(s => ({ id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING }));
      const sinSpl = blandede.slice(4, 6).map(s => ({ id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING }));
      baneOversikt = [
        { baneNr: 1, erDobbel: true,  erSingel: false, maksPoeng: mp, spillere: dblSpl },
        { baneNr: 2, erDobbel: false, erSingel: true,  maksPoeng: mp, spillere: sinSpl },
      ];
    } else {
      const resultat = fordelBanerMix(valgte, app.antallBaner, app.poengPerKamp ?? 15);
      baneOversikt = resultat.baneOversikt;
      mixHviler    = resultat.hviler ?? [];
    }
  } else {
    baneOversikt = fordelBaner(valgte, app.antallBaner, app.poengPerKamp ?? 17);
  }

  // Guard: alle baner skal ha 2, 4 eller 5 spillere (2 = singel i 6-spiller-format)
  const ugyldigBane = baneOversikt.find(b => b.spillere.length < 2 || b.spillere.length > 5 || b.spillere.length === 3);
  if (ugyldigBane) {
    visMelding(`Bane ${ugyldigBane.baneNr} har ugyldig antall spillere (${ugyldigBane.spillere.length}).`, 'feil');
    return;
  }

  // Spillere som ikke fikk plass: i mix brukes hviler fra algoritmen, ellers beregnes det
  const venteliste = erMix()
    ? mixHviler.map(s => ({ id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING }))
    : valgte
        .filter(s => !new Set(baneOversikt.flatMap(b => b.spillere.map(x => x.id))).has(s.id))
        .map(s => ({ id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING }));

  // Ingen fast rundetgrense — admin avslutter manuelt
  const effektivMaksRunder = 99;

  try {
    const batch    = writeBatch(db);
    const treningRef = doc(collection(db, SAM.TRENINGER));

    // ── Mix & Match: initialiser statistikk-felter i Firestore ──────────────
    // Tomme ved runde 1 — oppdateres etter hver runde i bekreftNesteRunde.
    // Konkurranse-modus berøres ikke av disse feltene.
    const mixFelter = erMix() ? {
      mixPlayedWith:      {},
      mixPlayedAgainst:   {},
      mixGamesPlayed:     {},
      mixSitOutCount:     {},
      mixLastSitOutRunde: {},
      // 6-spiller streak — initialiseres alltid, brukes kun for er6SpillerFormat
      mix6DobbelStreak:   {},
      mix6DobbelTotalt:   {},
    } : {};

    batch.set(treningRef, {
      antallBaner:     baneOversikt.length,
      poengPerKamp:    app.poengPerKamp,
      maksRunder:      effektivMaksRunder,
      gjeldendRunde:   1,
      status:          'aktiv',
      laast:           false,
      adminSkjerm:     'baner',
      opprettetDato:   serverTimestamp(),
      avsluttetDato:   null,
      baneOversikt,
      venteliste,
      er6SpillerFormat: er6SpillerFormat,
      spillModus:      app.spillModus,
      scoringsFormat: app.scoringsFormat ?? 'americano',
      klubbId:         _getAktivKlubbId(),
      ...mixFelter,
    });

    baneOversikt.forEach(b => b.spillere.forEach(s => {
      batch.set(doc(collection(db, SAM.TS)), {
        treningId: treningRef.id, spillerId: s.id,
        spillerNavn: s.navn ?? 'Ukjent', ratingVedStart: s.rating ?? STARTRATING,
        sluttPlassering: null, paVenteliste: false,
      });
    }));
    venteliste.forEach(s => {
      batch.set(doc(collection(db, SAM.TS)), {
        treningId: treningRef.id, spillerId: s.id,
        spillerNavn: s.navn ?? 'Ukjent', ratingVedStart: s.rating ?? STARTRATING,
        sluttPlassering: null, paVenteliste: true,
      });
    });

    // Skriv kamper for runde 1
    if (erMix()) {
      skrivMixKamper(batch, treningRef.id, 1, baneOversikt);
    } else {
      baneOversikt.forEach(bane =>
        skrivKamper(batch, treningRef.id, 1, bane.baneNr, bane.spillere, bane.erSingel ?? false, bane.erDobbel ?? false)
      );
    }
    await batch.commit();

    app.treningId         = treningRef.id;
    app.baneOversikt      = baneOversikt;
    app.venteliste        = venteliste;
    app.runde             = 1;
    app.maksRunder        = effektivMaksRunder;
    app.er6SpillerFormat  = er6SpillerFormat;

    sessionStorage.setItem('aktivTreningId',      treningRef.id);
    sessionStorage.setItem('aktivTreningKlubbId', _getAktivKlubbId());
    localStorage.setItem('aktivTreningId',        treningRef.id);
    localStorage.setItem('aktivTreningKlubbId',   _getAktivKlubbId());
    try { history.replaceState(null, '', '?okt=' + treningRef.id); } catch (_) {}
    _oppdaterRundeUI();
    _naviger('baner');
    _startLyttere();
  } catch (e) {
    visFBFeil('Kunne ikke starte økt: ' + (e?.message ?? e));
  }
}
export function delLenke() {
  const url = location.href;
  if (navigator.share) {
    navigator.share({ title: 'Pb Jæren Americano', url })
      .catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => {
      visMelding('Lenke kopiert!');
    }).catch(() => {
      visMelding('Kunne ikke kopiere lenke.', 'feil');
    });
  } else {
    prompt('Kopier lenken:', url);
  }
}
window.delLenke = delLenke;

window.startTrening = startTrening;

function skrivKamper(batch, treningId, rundeNr, baneNr, spillere, erSingel = false, erDobbel6 = false) {
  const n = spillere?.length ?? 0;
  // 6-spiller singel-bane har 2 spillere; vanlige baner trenger minst 4
  if (erSingel && n === 2) {
    const dokData = {
      treningId, baneNr: `bane${baneNr}`, rundeNr, kampNr: 1,
      erSingel: true,
      lag1_s1: spillere[0].id,  lag1_s2: null,
      lag2_s1: spillere[1].id,  lag2_s2: null,
      lag1_s1_navn: spillere[0].navn, lag1_s2_navn: null,
      lag2_s1_navn: spillere[1].navn, lag2_s2_navn: null,
      lag1Poeng: null, lag2Poeng: null, ferdig: false,
    };
    batch.set(doc(collection(db, SAM.KAMPER)), dokData);
    return;
  }
  if (n < 4) {
    console.warn(`skrivKamper: bane ${baneNr} har kun ${n} spillere — hopper over.`);
    return;
  }
  const parter = erDobbel6 ? PARTER_6_DOBBEL : getParter(n);
  parter.forEach(par => {
    const dokData = {
      treningId, baneNr: `bane${baneNr}`, rundeNr, kampNr: par.nr,
      erSingel: false,
      lag1_s1: spillere[par.lag1[0]].id,  lag1_s2: spillere[par.lag1[1]].id,
      lag2_s1: spillere[par.lag2[0]].id,  lag2_s2: spillere[par.lag2[1]].id,
      lag1_s1_navn: spillere[par.lag1[0]].navn, lag1_s2_navn: spillere[par.lag1[1]].navn,
      lag2_s1_navn: spillere[par.lag2[0]].navn, lag2_s2_navn: spillere[par.lag2[1]].navn,
      lag1Poeng: null, lag2Poeng: null, ferdig: false,
    };
    // For 5-spillerbaner: lagre hvem som hviler
    if (par.hviler != null && spillere[par.hviler]) {
      dokData.hviler_id   = spillere[par.hviler].id;
      dokData.hviler_navn = spillere[par.hviler].navn;
    }
    batch.set(doc(collection(db, SAM.KAMPER)), dokData);
  });
}

// Mix & Match — skriv én kamp per bane per runde.
// Håndterer både dobbel (4 spl) og singel (2 spl) baner.
function skrivMixKamper(batch, treningId, rundeNr, baneOversikt) {
  baneOversikt.forEach(bane => {
    const spl = bane.spillere ?? [];

    // Singel-bane (2 spillere)
    if (bane.erSingel || spl.length === 2) {
      const [s1, s2] = spl;
      if (!s1 || !s2) return;
      batch.set(doc(collection(db, SAM.KAMPER)), {
        treningId,
        baneNr:   `bane${bane.baneNr}`,
        rundeNr,
        kampNr:   1,
        erSingel: true,
        lag1_s1: s1.id, lag1_s2: null,
        lag2_s1: s2.id, lag2_s2: null,
        lag1_s1_navn: s1.navn, lag1_s2_navn: null,
        lag2_s1_navn: s2.navn, lag2_s2_navn: null,
        lag1Poeng: null, lag2Poeng: null, ferdig: false,
      });
      return;
    }

    // Dobbel-bane (4 spillere)
    const [s1, s2, s3, s4] = spl;
    if (!s1 || !s2 || !s3 || !s4) return;
    batch.set(doc(collection(db, SAM.KAMPER)), {
      treningId,
      baneNr:   `bane${bane.baneNr}`,
      rundeNr,
      kampNr:   1,
      erSingel: false,
      lag1_s1: s1.id, lag1_s2: s2.id,
      lag2_s1: s3.id, lag2_s2: s4.id,
      lag1_s1_navn: s1.navn, lag1_s2_navn: s2.navn,
      lag2_s1_navn: s3.navn, lag2_s2_navn: s4.navn,
      lag1Poeng: null, lag2Poeng: null, ferdig: false,
    });
  });
}
// ════════════════════════════════════════════════════════
// LYTTERE — delegerer til lyttere.js
export function visNesteRundeModal() {
  _krevAdmin(
    erMix() ? 'Neste kamp' : 'Neste runde',
    erMix()
      ? 'Kun administrator kan gå videre. Nye lag trekkes automatisk.'
      : 'Kun administrator kan gå videre til neste runde. Skriv inn PIN-koden.',
    () => {
      const erSiste  = app.runde >= app.maksRunder;
      const tittelEl = document.getElementById('modal-neste-tittel');
      const tekstEl  = document.getElementById('modal-neste-tekst');
      const seBtn    = document.querySelector('#modal-neste .knapp-primaer');

      if (erMix()) {
        if (tittelEl) tittelEl.textContent = erSiste ? 'Avslutte Mix & Match?' : 'Neste kamp?';
        if (tekstEl)  tekstEl.textContent  = erSiste
          ? 'Siste kamp er ferdig! Vil du se hvem som scoret mest? 🎉'
          : `Kamp ${app.runde} er ferdig. Klar for nye lag? 🎲`;
        if (seBtn) seBtn.textContent = erSiste ? 'SE RESULTATER' : 'NYE LAG →';
      } else {
        if (tittelEl) tittelEl.textContent = 'Neste runde?';
        if (tekstEl)  tekstEl.textContent  = erSiste
          ? `Runde ${app.runde} er siste runde. Vil du se resultatene og avslutte økten?`
          : `Runde ${app.runde} er ferdig. Vil du se rangeringer og forflytninger?`;
        if (seBtn) seBtn.textContent = 'SE RESULTATER';
      }

      document.getElementById('modal-neste').style.display = 'flex';
    }
  );
}
window.visNesteRundeModal = visNesteRundeModal;
export async function bekreftNesteRunde() {
  if (!db || !app.treningId) { visMelding('Økt ikke aktiv.', 'feil'); return; }
  const n = app.rangerteBaner.length;
  if (n === 0) { visMelding('Ingen baner å flytte.', 'advarsel'); return; }

  lasUI('Starter neste runde…');
  startFailSafe(async () => { await updateDoc(doc(db, SAM.TRENINGER, app.treningId), { laast: false }); });

  try {
    await lassTrening(app.runde);

    // Vis resultater for alle brukere i klubben mens admin forbereder neste runde


    const nyRunde = app.runde + 1;

    // ══════════════════════════════════════════
    // MIX & MATCH — smart ny lagfordeling
    // Ingen opprykk/nedrykk, ingen rating-hensyn.
    // Bruker spillehistorikk og hvile-historikk for rettferdig rotasjon.
    // ══════════════════════════════════════════
    if (erMix()) {
      // Hent oppdatert statistikk fra Firestore
      const { data: treningData } = await hentTrening();
      const { playedWith, playedAgainst, gamesPlayed, sitOutCount, lastSitOutRunde } =
        hentMixStatistikk(treningData);

      // Oppdater statistikk med kampene og hvile-runden som nettopp ble spilt
      const gjeldBaneOversikt = app.baneOversikt ?? [];
      const forrigeHvilere    = app.venteliste   ?? [];
      oppdaterMixStatistikk(
        gjeldBaneOversikt, forrigeHvilere,
        playedWith, playedAgainst, gamesPlayed,
        sitOutCount, lastSitOutRunde,
        app.runde
      );

      // Alle spillere i rotasjonen
      const alleSpillere = [
        ...(app.baneOversikt ?? []).flatMap(b => b.spillere ?? []),
        ...forrigeHvilere,
      ];

      let nyBaneOversikt, nyVenteliste = [];
      const mp = app.poengPerKamp ?? 15;

      // Streak-statistikk for 6-spiller format — løftet ut slik at batch.update får tilgang
      let oppdatertDobbelStreak = null;
      let oppdatertDobbelTotalt = null;

      // 6-spiller mix: bruk rotasjonslogikk basert på forrige rundes resultat
      if (app.er6SpillerFormat) {
        const gjeldBane1 = gjeldBaneOversikt.find(b => b.baneNr === 1);
        const gjeldBane2 = gjeldBaneOversikt.find(b => b.baneNr === 2);

        if (!gjeldBane1 || !gjeldBane2) throw new Error('Kunne ikke finne bane 1 og 2.');

        // Les dobbelresultat fra cache
        const dobbelKampData = _getKampStatusCache()['bane1_1'];
        if (!dobbelKampData?.ferdig) {
          visMelding('Dobbel-kampen på bane 1 er ikke ferdig ennå.', 'advarsel');
          await lossTrening();
          return;
        }

        const finnSpiller = (id) => gjeldBane1.spillere.find(s => s.id === id);
        const lag1Spillere = [finnSpiller(dobbelKampData.lag1_s1), finnSpiller(dobbelKampData.lag1_s2)].filter(Boolean);
        const lag2Spillere = [finnSpiller(dobbelKampData.lag2_s1), finnSpiller(dobbelKampData.lag2_s2)].filter(Boolean);

        const vinnerId = dobbelKampData.lag1Poeng > dobbelKampData.lag2Poeng ? 1
                       : dobbelKampData.lag2Poeng > dobbelKampData.lag1Poeng ? 2
                       : 1;

        // Hent streak-statistikk fra Firestore og send inn i rotasjonslogikken
        const { dobbelStreak, dobbelTotalt } = hent6SpillerStreak(treningData);

        const { baneOversikt: ny6Baner } = neste6SpillerRunde(
          { lag1Spillere, lag2Spillere, vinnerId },
          gjeldBane2.spillere,
          playedWith,
          dobbelStreak,
          dobbelTotalt,
          mp
        );

        // Oppdater streak in-place basert på hvem som spiller dobbel/singel neste runde
        const nesteDobbelSpl = ny6Baner[0]?.spillere ?? [];
        const nesteSingelSpl = ny6Baner[1]?.spillere ?? [];
        oppdater6SpillerStreak(nesteDobbelSpl, nesteSingelSpl, dobbelStreak, dobbelTotalt);

        // Lagre de oppdaterte verdiene slik at batch.update kan bruke dem
        oppdatertDobbelStreak = dobbelStreak;
        oppdatertDobbelTotalt = dobbelTotalt;

        nyBaneOversikt = ny6Baner;
      } else {
        const resultat = lagMixKampoppsett(
          alleSpillere,
          playedWith, playedAgainst, gamesPlayed,
          sitOutCount, lastSitOutRunde,
          app.baneOversikt.length,
          nyRunde,
          mp
        );
        nyBaneOversikt = resultat.baneOversikt;
        nyVenteliste   = resultat.hviler ?? [];
      }

      const batch = writeBatch(db);
      batch.update(doc(db, SAM.TRENINGER, app.treningId), {
        gjeldendRunde:       nyRunde,
        baneOversikt:        nyBaneOversikt,
        venteliste:          nyVenteliste,
        laast:               false,
        // Lagre all oppdatert statistikk til Firestore
        mixPlayedWith:       playedWith,
        mixPlayedAgainst:    playedAgainst,
        mixGamesPlayed:      gamesPlayed,
        mixSitOutCount:      sitOutCount,
        mixLastSitOutRunde:  lastSitOutRunde,
        // 6-spiller streak — kun satt for er6SpillerFormat, ellers null (ignoreres)
        ...(oppdatertDobbelStreak !== null ? {
          mix6DobbelStreak: oppdatertDobbelStreak,
          mix6DobbelTotalt: oppdatertDobbelTotalt,
        } : {}),
      });
      // Mix: én kamp per bane per runde — lagene er allerede trukket i nyBaneOversikt
      skrivMixKamper(batch, app.treningId, nyRunde, nyBaneOversikt);
      await batch.commit();

      app.runde        = nyRunde;
      app.baneOversikt = nyBaneOversikt;
      app.venteliste   = nyVenteliste;
      _setKampStatusCache({});
      _oppdaterRundeUI();
      _startKampLytter();
      _naviger('baner');
      visMelding('Runde ' + nyRunde + ' startet — nye lag!');
      return;
    }

    // ══════════════════════════════════════════
    // KONKURRANSE — 6-spiller rotasjon og standard opprykk/nedrykk
    // ══════════════════════════════════════════
    if (app.er6SpillerFormat) {
      const gjeldBane1 = (app.baneOversikt ?? []).find(b => b.baneNr === 1);
      const gjeldBane2 = (app.baneOversikt ?? []).find(b => b.baneNr === 2);
      const mp = gjeldBane1?.maksPoeng ?? gjeldBane2?.maksPoeng ?? app.poengPerKamp ?? 15;

      if (!gjeldBane1 || !gjeldBane2) throw new Error('Kunne ikke finne bane 1 og 2.');

      // ── Les kampresultat fra dobbelkampen (bane 1, kamp 1) ──
      const dobbelKampData = _getKampStatusCache()['bane1_1'];
      if (!dobbelKampData?.ferdig) {
        visMelding('Dobbel-kampen på bane 1 er ikke ferdig ennå.', 'advarsel');
        await lossTrening();
        return;
      }

      const finnSpiller = (id) => gjeldBane1.spillere.find(s => s.id === id);
      const lag1Spillere = [finnSpiller(dobbelKampData.lag1_s1), finnSpiller(dobbelKampData.lag1_s2)].filter(Boolean);
      const lag2Spillere = [finnSpiller(dobbelKampData.lag2_s1), finnSpiller(dobbelKampData.lag2_s2)].filter(Boolean);

      if (lag1Spillere.length < 2 || lag2Spillere.length < 2) throw new Error('Kunne ikke rekonstruere lag fra kampdata.');

      const vinnerId = dobbelKampData.lag1Poeng > dobbelKampData.lag2Poeng ? 1
                     : dobbelKampData.lag2Poeng > dobbelKampData.lag1Poeng ? 2
                     : 1; // uavgjort: lag1 som vinner (arbitrært)

      const singelSpillere = gjeldBane2.spillere;

      // Kjør rotasjonslogikken — ingen playedWith/streak i konkurranse
      const { baneOversikt } = neste6SpillerRunde(
        { lag1Spillere, lag2Spillere, vinnerId },
        singelSpillere,
        {}, {}, {},
        mp
      );

      const batch = writeBatch(db);
      batch.update(doc(db, SAM.TRENINGER, app.treningId), {
        gjeldendRunde: nyRunde,
        baneOversikt,
        venteliste:    [],
        laast:         false,
      });
      baneOversikt.forEach(bane =>
        skrivKamper(batch, app.treningId, nyRunde, bane.baneNr, bane.spillere, bane.erSingel ?? false, bane.erDobbel ?? false)
      );
      await batch.commit();

      app.runde        = nyRunde;
      app.baneOversikt = baneOversikt;
      app.venteliste   = [];
      _setKampStatusCache({});
      _oppdaterRundeUI();
      _startKampLytter();
      _naviger('baner');
      visMelding('Runde ' + nyRunde + ' startet!');
      return;
    }

    // ══════════════════════════════════════════
    // STANDARD AMERICANO — forfremmelse/degradering
    // ══════════════════════════════════════════

    // Filtrer ut ekskluderte spillere fra alle baner og venteliste
    const ekskl = app.ekskluderteIds ?? new Set();

    // Behold midtsjiktet (alle unntatt topp og bunn) fra forrige runde
    const neste = app.rangerteBaner.map(b => {
      // Hent maksPoeng fra gjeldende baneOversikt så det ikke mistes ved ny runde
      const gjeldendeBane = (app.baneOversikt ?? []).find(ob => ob.baneNr === b.baneNr);
      return {
        baneNr:    b.baneNr,
        maksPoeng: gjeldendeBane?.maksPoeng ?? (app.poengPerKamp ?? 17),
        // For 4-spillerbane: behold plass 2 og 3 (index 1,2)
        // For 5-spillerbane: behold plass 2, 3 og 4 (index 1,2,3)
        spillere: (b.rangert ?? [])
          .filter((_, ri) => ri > 0 && ri < (b.rangert.length - 1))
          .map(r => (b.spillere ?? []).find(s => s.id === r.spillerId))
          .filter(s => s && !ekskl.has(s.id)),
      };
    });

    // Fjern ekskluderte fra venteliste
    const nyVenteliste = (app.venteliste ?? []).filter(s => !ekskl.has(s.id));

    for (let i = 0; i < app.rangerteBaner.length; i++) {
      const bane    = app.rangerteBaner[i];
      const r       = bane?.rangert ?? [];
      if (r.length < 4) continue;
      const sist    = r.length - 1;
      // finn() returnerer null for ekskluderte spillere — de hoppes over i forflytning
      const finn    = (rang) => { const s = (bane.spillere ?? []).find(s => s.id === r[rang]?.spillerId); return s && !ekskl.has(s.id) ? s : null; };
      const erForst = i === 0;
      const erSist  = i === n - 1;

      if (n === 1) {
        // Én bane: topp og bunn blir — evt. bytt siste mot venteliste
        const topp = finn(0); if (topp) neste[0].spillere.push(topp);
        if (nyVenteliste.length > 0) {
          const inn = nyVenteliste.shift();
          if (inn) neste[0].spillere.push(inn);
          const bunn = finn(sist); if (bunn) nyVenteliste.push(bunn);
        } else {
          const bunn = finn(sist); if (bunn) neste[0].spillere.push(bunn);
        }
      } else if (!erForst && !erSist) {
        const opp = finn(0);    if (opp) neste[i-1].spillere.push(opp);
        const ned = finn(sist); if (ned) neste[i+1].spillere.push(ned);
      } else if (erForst) {
        const opp = finn(0); if (opp) neste[0].spillere.push(opp);
        if (n > 1) { const ned = finn(sist); if (ned) neste[1].spillere.push(ned); }
      } else {
        if (n > 1) { const opp = finn(0); if (opp) neste[n-2].spillere.push(opp); }
        if (nyVenteliste.length > 0) {
          const inn = nyVenteliste.shift();
          if (inn) neste[n-1].spillere.push(inn);
          const ut = finn(sist); if (ut) nyVenteliste.push(ut);
        } else {
          const ned = finn(sist); if (ned) neste[n-1].spillere.push(ned);
        }
      }
    }

    // Valider at alle baner har 4 eller 5 spillere — stopp hvis ikke
    const ugyldigBaneNeste = neste.find(b => b.spillere.length < 4 || b.spillere.length > 5);
    if (ugyldigBaneNeste) {
      throw new Error(
        `Bane ${ugyldigBaneNeste.baneNr} fikk ${ugyldigBaneNeste.spillere.length} spillere etter forflytning. ` +
        `Kontroller at antall spillere er delelig med 4 (eller gir 5-spillerbaner).`
      );
    }

    const baneOversikt = neste.map(b => ({
      baneNr:    b.baneNr,
      maksPoeng: b.maksPoeng, // bevares fra runde til runde
      spillere:  b.spillere.filter(Boolean).map(s => ({
        id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING,
      })),
    }));

    const batch = writeBatch(db);
    batch.update(doc(db, SAM.TRENINGER, app.treningId), {
      gjeldendRunde:  nyRunde,
      baneOversikt,
      venteliste:     nyVenteliste,
      ekskluderteIds: [...ekskl],   // bevar liste slik andre enheter også respekterer den
      laast:          false,
      adminSkjerm:    'baner',  // atomisk med ny runde — lyttere navigerer til baner
    });
    baneOversikt.forEach(bane =>
      skrivKamper(batch, app.treningId, nyRunde, bane.baneNr, bane.spillere, false, false)
    );
    await batch.commit();

    app.runde        = nyRunde;
    app.baneOversikt = baneOversikt;
    app.venteliste   = nyVenteliste;
    _setKampStatusCache({});
    _oppdaterRundeUI();
    _startKampLytter();
    _naviger('baner');
    visMelding('Runde ' + nyRunde + ' startet!');
  } catch (e) {
    console.error('[bekreftNesteRunde]', e);
    visMelding(e?.message ?? 'Feil ved neste runde.', 'feil');
    if (!e?.message?.includes('jobber akkurat nå') && !e?.message?.includes('oppdatert av en annen')) {
      await lossTrening();
    }
  } finally {
    stoppFailSafe();
    frigiUI();
  }
}
window.bekreftNesteRunde = bekreftNesteRunde;
export function visAvsluttModal() {
  _krevAdmin(
    'Avslutt økt',
    erMix()
      ? 'Kun administrator kan avslutte Mix & Match-økten.'
      : 'Kun administrator kan avslutte økten og oppdatere ratingene. Skriv inn PIN-koden.',
    () => {
      // Oppdater modal-tekst basert på modus
      const tekstEl = document.getElementById('modal-avslutt-tekst');
      if (tekstEl) {
        tekstEl.textContent = erMix()
          ? 'Dette avslutter Mix & Match-økten og beregner sluttrangeringen. Ingen ratingendringer.'
          : 'Dette beregner sluttrangeringen og oppdaterer alle spilleres rating. Kan ikke angres.';
      }
      document.getElementById('modal-avslutt').style.display = 'flex';
    }
  );
}
window.visAvsluttModal = visAvsluttModal;
export async function avsluttTreningUI() {
  if (!db || !app.treningId) { visMelding('Økt ikke aktiv.', 'feil'); return; }
  document.getElementById('modal-avslutt').style.display = 'none';
  document.getElementById('modal-neste').style.display   = 'none';

  lasUI('Avslutter økt…');
  startFailSafe(async () => { await updateDoc(doc(db, SAM.TRENINGER, app.treningId), { laast: false }); });

  try {
    // Lås treningsdokumentet — forhindrer at to admin-er avslutter samtidig
    // Rundekonflikt-sjekk ikke nødvendig her (avslutning er alltid gyldig)
    await lassTrening(null);

    // ── Hent ALLE kamper for hele økten (alle runder) ────
    // Elo beregnes per kamp sekvensielt, så vi trenger alle runder.
    const kamperSnap = await getDocs(
      query(collection(db, SAM.KAMPER),
        where('treningId', '==', app.treningId)
      )
    );
    const alleKamper = kamperSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Finn alle fullførte runder (kamper med registrerte poeng).
    // Beskytter mot runder som er satt opp men ikke spilt.
    // Best av 3: krev bekreftet=true for å telle i rating; Americano: ferdig holder
    const harPoeng = k => k != null && k.lag1Poeng != null && k.lag2Poeng != null
      && (app.scoringsFormat !== 'best_of_3' || k.bekreftet === true);
    const alleKamperMedPoeng = alleKamper.filter(harPoeng);

    if (alleKamperMedPoeng.length === 0) {
      visMelding('Ingen kamper med registrerte poeng funnet. Sjekk at poeng er registrert.', 'advarsel');
      await lossTrening();
      return;
    }

    // ── Beregn sluttrangering på tvers av ALLE fullførte runder ──────────
    // En runde regnes som fullført kun hvis ALLE kampene i runden har registrerte poeng.
    const alleRunder = [...new Set(alleKamper.map(k => k.rundeNr))];
    const fullforteRunder = alleRunder
      .filter(rundeNr => {
        const kamperIRunde = alleKamper.filter(k => k.rundeNr === rundeNr);
        return kamperIRunde.some(harPoeng);
      })
      .sort((a, b) => a - b);

    const baneNrListe = [...new Set(alleKamper
      .filter(k => fullforteRunder.includes(k.rundeNr))
      .map(k => k.baneNr))].sort();
    const spillerTotaler = {};

    // Beregn statistikk direkte fra kamp-dokumentene ved å matche spillerId mot lag1/lag2.
    // Dette unngår avhengighet av PARTER-indekser og er alltid korrekt uansett spillerrekkefølge.
    fullforteRunder.forEach(rundeNr => {
      const kamperIRunde = alleKamper.filter(k => k.rundeNr === rundeNr && harPoeng(k));
      kamperIRunde.forEach(kamp => {
        // Hent alle spillere i denne kampen med id og navn
        const lag1 = [
          kamp.lag1_s1 ? { id: kamp.lag1_s1, navn: kamp.lag1_s1_navn ?? 'Ukjent', lag: 1 } : null,
          kamp.lag1_s2 ? { id: kamp.lag1_s2, navn: kamp.lag1_s2_navn ?? 'Ukjent', lag: 1 } : null,
        ].filter(Boolean);
        const lag2 = [
          kamp.lag2_s1 ? { id: kamp.lag2_s1, navn: kamp.lag2_s1_navn ?? 'Ukjent', lag: 2 } : null,
          kamp.lag2_s2 ? { id: kamp.lag2_s2, navn: kamp.lag2_s2_navn ?? 'Ukjent', lag: 2 } : null,
        ].filter(Boolean);

        const lag1Vant = kamp.lag1Poeng > kamp.lag2Poeng;
        const lag2Vant = kamp.lag2Poeng > kamp.lag1Poeng;

        [...lag1, ...lag2].forEach(spiller => {
          if (!spiller?.id) return;
          if (!spillerTotaler[spiller.id]) {
            spillerTotaler[spiller.id] = { spillerId: spiller.id, navn: spiller.navn, seire: 0, kamper: 0, for: 0, imot: 0, diff: 0 };
          }
          const erLag1 = spiller.lag === 1;
          const mine  = erLag1 ? kamp.lag1Poeng : kamp.lag2Poeng;
          const deres = erLag1 ? kamp.lag2Poeng : kamp.lag1Poeng;
          if ((erLag1 && lag1Vant) || (!erLag1 && lag2Vant)) {
            spillerTotaler[spiller.id].seire += 1;
          }
          spillerTotaler[spiller.id].kamper += 1;
          spillerTotaler[spiller.id].for    += mine;
          spillerTotaler[spiller.id].imot   += deres;
          spillerTotaler[spiller.id].diff   += mine - deres;
        });

        // Hvilende spiller får snittpoeng men ingen seir
        if (kamp.hviler_id) {
          if (!spillerTotaler[kamp.hviler_id]) {
            spillerTotaler[kamp.hviler_id] = { spillerId: kamp.hviler_id, navn: kamp.hviler_navn ?? 'Ukjent', seire: 0, for: 0, imot: 0, diff: 0 };
          }
          const hvilPoeng = kamp.hvilerPoeng ?? Math.ceil((kamp.lag1Poeng + kamp.lag2Poeng) / 2);
          spillerTotaler[kamp.hviler_id].for  += hvilPoeng;
          spillerTotaler[kamp.hviler_id].diff += hvilPoeng;
        }
      });
    });

    // Sluttrangering:
    // KONKURRANSE — basert på SISTE fullførte runde (bane-plassering med opprykk/nedrykk)
    // MIX         — basert på AKKUMULERT statistikk fra alle fullførte runder

    let rangerteBaner;

    if (erMix()) {
      // Mix: sorter alle spillere etter total-statistikk på tvers av alle runder
      const alle = Object.values(spillerTotaler)
        .sort((a, b) => b.for - a.for || b.seire - a.seire || b.diff - a.diff || Math.random() - 0.5);
      rangerteBaner = [{ baneNr: 1, erSingel: false, rangert: alle.map((s, i) => ({ ...s, baneRang: i + 1 })) }];

    } else {
      // Konkurranse: bruk kun siste fullførte runde
      const sisteFullforteRunde = fullforteRunder[fullforteRunder.length - 1];
      const kamperSisteRunde = alleKamper.filter(k => k.rundeNr === sisteFullforteRunde && harPoeng(k));

      const sisteRundeTotaler = {};
      kamperSisteRunde.forEach(kamp => {
        const lag1 = [
          kamp.lag1_s1 ? { id: kamp.lag1_s1, navn: kamp.lag1_s1_navn ?? 'Ukjent', lag: 1 } : null,
          kamp.lag1_s2 ? { id: kamp.lag1_s2, navn: kamp.lag1_s2_navn ?? 'Ukjent', lag: 1 } : null,
        ].filter(Boolean);
        const lag2 = [
          kamp.lag2_s1 ? { id: kamp.lag2_s1, navn: kamp.lag2_s1_navn ?? 'Ukjent', lag: 2 } : null,
          kamp.lag2_s2 ? { id: kamp.lag2_s2, navn: kamp.lag2_s2_navn ?? 'Ukjent', lag: 2 } : null,
        ].filter(Boolean);
        const lag1Vant = kamp.lag1Poeng > kamp.lag2Poeng;
        const lag2Vant = kamp.lag2Poeng > kamp.lag1Poeng;
        [...lag1, ...lag2].forEach(spiller => {
          if (!spiller?.id) return;
          if (!sisteRundeTotaler[spiller.id]) {
            sisteRundeTotaler[spiller.id] = { spillerId: spiller.id, navn: spiller.navn, seire: 0, kamper: 0, for: 0, imot: 0, diff: 0 };
          }
          const erLag1 = spiller.lag === 1;
          const mine   = erLag1 ? kamp.lag1Poeng : kamp.lag2Poeng;
          const deres  = erLag1 ? kamp.lag2Poeng : kamp.lag1Poeng;
          if ((erLag1 && lag1Vant) || (!erLag1 && lag2Vant)) sisteRundeTotaler[spiller.id].seire += 1;
          sisteRundeTotaler[spiller.id].kamper += 1;
          sisteRundeTotaler[spiller.id].for    += mine;
          sisteRundeTotaler[spiller.id].imot   += deres;
          sisteRundeTotaler[spiller.id].diff   += mine - deres;
        });
      });

      const spillerTilBane = {};
      kamperSisteRunde.forEach(k => {
        const baneNrInt = parseInt((k.baneNr ?? '').replace('bane', '')) || 0;
        if (k.lag1_s1) spillerTilBane[k.lag1_s1] = baneNrInt;
        if (k.lag1_s2) spillerTilBane[k.lag1_s2] = baneNrInt;
        if (k.lag2_s1) spillerTilBane[k.lag2_s1] = baneNrInt;
        if (k.lag2_s2) spillerTilBane[k.lag2_s2] = baneNrInt;
      });

      const baneGrupper = {};
      Object.values(sisteRundeTotaler).forEach(s => {
        const baneNr = spillerTilBane[s.spillerId] ?? 1;
        if (!baneGrupper[baneNr]) baneGrupper[baneNr] = [];
        baneGrupper[baneNr].push(s);
      });

      rangerteBaner = Object.keys(baneGrupper)
        .map(Number)
        .sort((a, b) => a - b)
        .map(baneNr => {
          const baneInfo = (app.baneOversikt ?? []).find(b => b.baneNr === baneNr);
          return {
            baneNr,
            erSingel: baneInfo?.erSingel ?? false,
            rangert: baneGrupper[baneNr]
              .sort((a, b) => b.seire - a.seire || b.diff - a.diff || b.for - a.for)
              .map((s, i) => ({ ...s, baneRang: i + 1 })),
          };
        });
    }

    const tsSnap = await getDocs(
      query(collection(db, SAM.TS), where('treningId', '==', app.treningId))
    );
    const tsMap = {};
    (tsSnap?.docs ?? []).forEach(d => {
      const data = d.data() ?? {};
      if (data.spillerId) {
        tsMap[data.spillerId] = { docId: d.id, ratingVedStart: data.ratingVedStart ?? STARTRATING };
      }
    });

    const sluttrangering = (() => {
      // 6-spiller-format: ranger alle 6 spillere sam
      // let på tvers av baner (dobbel + singel)
      if (app.er6SpillerFormat) {
        const alle = rangerteBaner.flatMap(bane =>
          (bane.rangert ?? []).map(s => ({
            ...s,
            ratingVedStart: tsMap[s.spillerId]?.ratingVedStart ?? STARTRATING,
          }))
        ).sort((a, b) => b.seire - a.seire || b.diff - a.diff || b.for - a.for);
        return alle.map((s, i) => ({ ...s, sluttPlassering: i + 1 }));
      }
      // Standard: bane-for-bane rangering
      let plassering = 1;
      return rangerteBaner
        .sort((a, b) => a.baneNr - b.baneNr)
        .flatMap(bane => {
          // Re-sorter med rating som tiebreaker nå som tsMap er tilgjengelig
          const resortert = [...(bane.rangert ?? [])].sort((a, b) =>
            b.seire - a.seire || b.diff - a.diff || b.for - a.for ||
            (tsMap[b.spillerId]?.ratingVedStart ?? STARTRATING) - (tsMap[a.spillerId]?.ratingVedStart ?? STARTRATING)
          );
          return resortert.map(s => {
            const rad = {
              ...s,
              sluttPlassering: plassering,
              ratingVedStart:  tsMap[s.spillerId]?.ratingVedStart ?? STARTRATING,
            };
            plassering++;
            return rad;
          });
        });
    })();

    if (sluttrangering.length === 0) {
      visMelding('Ingen sluttrangering tilgjengelig. Sjekk at alle poeng er registrert.', 'advarsel');
      await lossTrening();
      return;
    }

    // ── Elo-ratingberegning ───────────────────────────────────────────────
    // KONKURRANSE : Elo beregnes per kamp og skrives tilbake til spillerprofil
    // MIX         : Ingen ratingendring — spillerens rating forblir uendret

    const spillereListe = sluttrangering.map(s => ({
      id:     s.spillerId,
      rating: tsMap[s.spillerId]?.ratingVedStart ?? STARTRATING,
    }));

    const eloResultat = erMix() ? {} : beregnEloForOkt(alleKamper, spillereListe);

    app.ratingEndringer = sluttrangering.map(s => {
      if (erMix()) {
        const startRating  = tsMap[s.spillerId]?.ratingVedStart ?? STARTRATING;
        const antallKamper = s.kamper ?? 0;   // talt direkte fra kampdata
        return { ...s, ratingVedStart: startRating, endring: 0, nyRating: startRating, antallKamper };
      }
      const elo = eloResultat[s.spillerId] ?? { startRating: STARTRATING, nyRating: STARTRATING, endring: 0 };
      return { ...s, ratingVedStart: elo.startRating, endring: elo.endring, nyRating: elo.nyRating, antallKamper: 0 };
    });

    // ── Skriv alt til Firestore atomisk ──────────────────────────────────
    // KONKURRANSE : oppdaterer rating, lagrer historikk og resultater
    // MIX         : lagrer kun plassering — ingen rating- eller historikkskriving
    const batch = writeBatch(db);
    app.ratingEndringer.forEach(r => {
      if (!r.spillerId) return;

      // Konkurranse: oppdater spillerens rating i databasen
      if (!erMix()) {
        batch.update(doc(db, SAM.SPILLERE, r.spillerId), { rating: r.nyRating });
      }

      // Begge moduser: lagre sluttresultat (plassering og poeng)
      batch.set(doc(collection(db, SAM.RESULTATER)), {
        treningId:     app.treningId,
        spillerId:     r.spillerId,
        spillerNavn:   r.navn ?? 'Ukjent',
        sluttPlassering: r.sluttPlassering,
        ratingFor:     r.ratingVedStart,
        ratingEtter:   r.nyRating,
        ratingEndring: r.endring,
        dato:          serverTimestamp(),
        spillModus:    app.spillModus,
        // Mix & Match: lagre poengstatistikk (brukes i resultatvisning)
        totalPoeng:    r.for          ?? 0,
        antallKamper:  r.antallKamper ?? 0,
        seire:         r.seire        ?? 0,
        imot:          r.imot         ?? 0,
      });

      // Konkurranse: lagre i ratinghistorikk (brukes i profilgraf)
      if (!erMix()) {
        batch.set(doc(collection(db, SAM.HISTORIKK)), {
          spillerId:   r.spillerId,
          treningId:   app.treningId,
          ratingFor:   r.ratingVedStart,
          ratingEtter: r.nyRating,
          endring:     r.endring,
          plassering:  r.sluttPlassering,
          dato:        serverTimestamp(),
        });
      }

      const tsDocId = tsMap[r.spillerId]?.docId;
      if (tsDocId) batch.update(doc(db, SAM.TS, tsDocId), { sluttPlassering: r.sluttPlassering });
    });
    // Commit rating/historikk/resultater — UTEN status-endring ennå.
    // Status settes i eget kall etterpå slik at lyttere ikke trigges
    // før alle resultater er synlige i Firestore.
    batch.update(doc(db, SAM.TRENINGER, app.treningId), { laast: false });
    await batch.commit();

    // Nå er alle resultater skrevet — sett status til avsluttet.
    await updateDoc(doc(db, SAM.TRENINGER, app.treningId), {
      status: 'avsluttet',
      avsluttetDato: serverTimestamp(),
    });

    sessionStorage.removeItem('aktivTreningId'); sessionStorage.removeItem('aktivTreningKlubbId'); localStorage.removeItem('aktivTreningId'); localStorage.removeItem('aktivTreningKlubbId');
    try { history.replaceState(null, '', location.pathname); } catch (_) {}
    _stoppLyttere();
    // Nullstill treningId slik at baner-skjermen viser tom tilstand
    // om bruker navigerer dit etter avslutning
    app.treningId    = null;
    app.baneOversikt = [];
    app.venteliste   = [];
    _setKampStatusCache({});
    _naviger('slutt');
  } catch (e) {
    console.error('[avsluttTreningUI]', e);
    visMelding(e?.message ?? 'Feil ved avslutning.', 'feil');
    if (!e?.message?.includes('jobber akkurat nå')) {
      await lossTrening();
    }
  } finally {
    stoppFailSafe();
    frigiUI();
  }
}
window.avsluttTreningUI = avsluttTreningUI;
// NY ØKT
// ════════════════════════════════════════════════════════
export function nyTrening() {
  _stoppLyttere();
  app.valgtIds.clear();
  app.baneOversikt    = [];
  app.venteliste      = [];
  app.rangerteBaner   = [];
  app.ratingEndringer = [];
  app.runde           = 1;
  app.treningId       = null;
  app.aktivBane       = null;
  // Nullstill modus via settSpillModus() slik at UI-knappene også oppdateres
  if (typeof settSpillModus === 'function') settSpillModus('konkurranse');
  else app.spillModus = 'konkurranse';
  app.scoringsFormat   = 'americano';
  app.ekskluderteIds.clear();
  _setKampStatusCache({});
  // erAdmin nullstilles IKKE her — PIN gjelder fra opprettelse til avslutning av økt
  sessionStorage.removeItem('aktivTreningId'); sessionStorage.removeItem('aktivTreningKlubbId'); localStorage.removeItem('aktivTreningId'); localStorage.removeItem('aktivTreningKlubbId');
  const sokEl = document.getElementById('sok-inndata');
  if (sokEl) sokEl.value = '';
  _naviger('oppsett');
}
window.nyTrening = nyTrening;
// ════════════════════════════════════════════════════════
// AUTOMATISK AVSLUTNING — økter eldre enn 5 timer
// ════════════════════════════════════════════════════════
const AUTO_AVSLUTT_TIMER_MS = 5 * 60 * 60 * 1000; // 5 timer i millisekunder

/**
 * Sjekker alle aktive økter og avslutter de som er eldre enn 5 timer.
 * Kalles stille ved oppstart — brukeren ser ingenting med mindre noe faktisk avsluttes.
 * Ratingendringer beregnes IKKE (økten ble ikke offisielt avsluttet av admin).
 */
export async function autoAvsluttGamleTreninger() {
  try {
    const snap = await getDocs(
      query(collection(db, SAM.TRENINGER), where('status', '==', 'aktiv'), where('klubbId', '==', _getAktivKlubbId()))
    );
    if (snap.empty) return;

    const naaNaa = Date.now();

    for (const d of snap.docs) {
      const data          = d.data();
      const referanseDato = data.sisteAktivitetDato ?? data.opprettetDato;
      const referanseMs   = referanseDato?.toDate?.()?.getTime?.() ?? null;
      if (!referanseMs) continue;

      const alderMs = naaNaa - referanseMs;
      if (alderMs < AUTO_AVSLUTT_TIMER_MS) continue;

      // Økten er eldre enn 5 timer — avslutt automatisk
      console.info(`[AutoAvslutt] Avslutter økt ${d.id} (${Math.round(alderMs / 3600000)} timer gammel)`);

      try {
        await updateDoc(d.ref, {
          status:            'avsluttet',
          avsluttetDato:     serverTimestamp(),
          laast:             false,
          autoAvsluttet:     true,  // markerer at dette ikke var manuell avslutning
        });

        // Rydd opp sessionStorage om dette var vår egen økt
        if (sessionStorage.getItem('aktivTreningId') === d.id) {
          sessionStorage.removeItem('aktivTreningId'); sessionStorage.removeItem('aktivTreningKlubbId'); localStorage.removeItem('aktivTreningId'); localStorage.removeItem('aktivTreningKlubbId');
        }
      } catch (e) {
        console.warn(`[AutoAvslutt] Kunne ikke avslutte ${d.id}:`, e?.message ?? e);
      }
    }
  } catch (e) {
    console.warn('[AutoAvslutt] Sjekk feilet:', e?.message ?? e);
  }
}// ════════════════════════════════════════════════════════
// INIT — gjenoppretter aktiv økt fra Firestore ved oppstart
// ════════════════════════════════════════════════════════
export async function gjenopprettTrening(treningId) {
  const snap = await getDoc(doc(db, SAM.TRENINGER, treningId));
  if (!snap.exists() || snap.data()?.status !== 'aktiv') return false;
  const data = snap.data();

  // Ikke gjenopprett økt som tilhører en annen klubb
  if (data.klubbId && data.klubbId !== _getAktivKlubbId()) {
    console.debug(`[Init] Økt ${treningId} tilhører ${data.klubbId} — hopper over (aktiv klubb: ${_getAktivKlubbId()}).`);
    return false;
  }

  // Sjekk om økten er eldre enn 5 timer basert på sist registrerte aktivitet
  // (sisteAktivitetDato oppdateres ved hvert poengoppslag — eldre felt: opprettetDato)
  const referanseDato = data.sisteAktivitetDato ?? data.opprettetDato;
  const referanseMs   = referanseDato?.toDate?.()?.getTime?.() ?? null;
  if (referanseMs && (Date.now() - referanseMs) >= AUTO_AVSLUTT_TIMER_MS) {
    console.info(`[Init] Økt ${treningId} er for gammel — gjenoppretter ikke.`);
    visMelding('Økten er eldre enn 5 timer og ble ikke gjenopprettet.', 'advarsel');
    return false;
  }

  app.treningId         = treningId;
  app.runde             = data.gjeldendRunde    ?? 1;
  app.baneOversikt      = data.baneOversikt     ?? [];
  app.venteliste        = data.venteliste       ?? [];
  app.antallBaner       = data.antallBaner      ?? 3;
  app.poengPerKamp      = data.poengPerKamp     ?? 15;
  app.maksRunder        = 99; // ingen fast grense
  app.er6SpillerFormat  = data.er6SpillerFormat ?? false;
  app.spillModus        = data.spillModus       ?? 'konkurranse';
  app.scoringsFormat    = data.scoringsFormat   ?? 'americano';
  app.ekskluderteIds    = new Set(data.ekskluderteIds ?? []);
  sessionStorage.setItem('aktivTreningId',      treningId);
  sessionStorage.setItem('aktivTreningKlubbId', data.klubbId ?? _getAktivKlubbId());
  localStorage.setItem('aktivTreningId',        treningId);
  localStorage.setItem('aktivTreningKlubbId',   data.klubbId ?? _getAktivKlubbId());
  try { history.replaceState(null, '', '?okt=' + treningId); } catch (_) {}
  _oppdaterRundeUI();
  // Vis lastindikator mens kamp-lytteren henter data fra Firestore
  const baneLaster = document.getElementById('bane-laster');
  if (baneLaster) baneLaster.style.display = 'flex';
  _startLyttere();
  _naviger('baner');
  return true;
}// ════════════════════════════════════════════════════════
// DEMO-DATA — seeder fiktive spillere og én avsluttet økt
// Kalles kun om demo-klubben ikke har spillere fra før
// ════════════════════════════════════════════════════════
const DEMO_SPILLERE = [
  { navn: 'Anna Larsen',    rating: 1120 },
  { navn: 'Bjørn Eriksen',  rating: 1085 },
  { navn: 'Camilla Dahl',   rating: 1043 },
  { navn: 'David Hansen',   rating: 1018 },
  { navn: 'Eva Nilsen',     rating:  982 },
  { navn: 'Fredrik Berg',   rating:  961 },
  { navn: 'Guro Andersen',  rating:  934 },
  { navn: 'Henrik Holm',    rating:  907 },
];

export async function seedDemoDataOmNødvendig() {
  if (!db || _getAktivKlubbId() !== 'demo') return;
  try {
    const snap = await getDocs(
      query(collection(db, SAM.SPILLERE), where('klubbId', '==', 'demo'), limit(1))
    );
    if (!snap.empty) return; // Demo-data finnes allerede

    console.info('[Demo] Seeder demo-data…');
    const batch = writeBatch(db);

    // Opprett spillere
    const spillerRefs = DEMO_SPILLERE.map(s => {
      const ref = doc(collection(db, SAM.SPILLERE));
      batch.set(ref, { navn: s.navn, rating: s.rating, klubbId: 'demo', opprettetDato: serverTimestamp() });
      return { ref, ...s };
    });

    // Opprett én avsluttet økt
    const treningRef = doc(collection(db, SAM.TRENINGER));
    batch.set(treningRef, {
      klubbId:       'demo',
      antallBaner:   2,
      poengPerKamp:  15,
      maksRunder:    3,
      gjeldendRunde: 3,
      status:        'avsluttet',
      laast:         false,
      spillModus:    'konkurranse',
      er6SpillerFormat: false,
      opprettetDato: serverTimestamp(),
      avsluttetDato: serverTimestamp(),
      baneOversikt:  [],
      venteliste:    [],
    });

    // Resultater per spiller
    const plasSorted = [...spillerRefs].sort((a, b) => b.rating - a.rating);
    plasSorted.forEach((s, i) => {
      const endring = [18, 12, 7, 3, -3, -7, -12, -18][i] ?? 0;
      batch.set(doc(collection(db, SAM.RESULTATER)), {
        treningId:       treningRef.id,
        klubbId:         'demo',
        spillerId:       s.ref.id,
        spillerNavn:     s.navn,
        sluttPlassering: i + 1,
        ratingFor:       s.rating - endring,
        ratingEtter:     s.rating,
        ratingEndring:   endring,
        spillModus:      'konkurranse',
        dato:            serverTimestamp(),
      });
      batch.set(doc(collection(db, SAM.HISTORIKK)), {
        spillerId:   s.ref.id,
        klubbId:     'demo',
        treningId:   treningRef.id,
        ratingFor:   s.rating - endring,
        ratingEtter: s.rating,
        endring,
        plassering:  i + 1,
        dato:        serverTimestamp(),
      });
    });

    await batch.commit();
    console.info('[Demo] Demo-data seeded OK');
  } catch (e) {
    console.warn('[Demo] Seeding feilet:', e?.message ?? e);
  }
}// ════════════════════════════════════════════════════════
// AVBRYT ØKT — kun tilgjengelig i runde 1 uten registrerte poeng
// Sletter økten og sender tilbake til oppsett med spillerlisten intakt
// ════════════════════════════════════════════════════════

export function oppdaterAvbrytKnapp() {
  const knapp = document.getElementById('avbryt-runde1-knapp');
  if (!knapp) return;
  // Vis kun i runde 1 og ingen poeng er registrert ennå
  const ingenPoeng = Object.values(_getKampStatusCache()).every(k => !k.ferdig);
  knapp.style.display = (app.runde === 1 && ingenPoeng) ? 'inline-flex' : 'none';
}

export function visAvbrytOktModal() {
  _krevAdmin('Avbryt økt', 'Kun administrator kan avbryte økten.', () => {
    document.getElementById('modal-avbryt-okt').style.display = 'flex';
  });
}
window.visAvbrytOktModal = visAvbrytOktModal;

export async function utforAvbrytOkt() {
  document.getElementById('modal-avbryt-okt').style.display = 'none';
  if (!db || !app.treningId) return;

  try {
    // Lås treningsdokumentet først — forhindrer at andre skriver til økten
    // mens vi sletter den. lassTrening kaster om økten allerede er låst.
    await lassTrening(null);

    // Hent alle relaterte dokumenter parallelt for å spare tid
    const [kampSnap, tsSnap] = await Promise.all([
      getDocs(query(collection(db, SAM.KAMPER), where('treningId', '==', app.treningId))),
      getDocs(query(collection(db, SAM.TS),     where('treningId', '==', app.treningId))),
    ]);

    // Bygg og commit én enkelt batch.
    // writeBatch er atomær — enten slettes alt, eller ingenting.
    // Treningsdokumentet slettes sist som naturlig barriere:
    // om batch feiler halvveis vil treningsdokumentet fortsatt eksistere
    // og neste forsøk vil finne og rydde opp de gjenværende dokumentene.
    const batch = writeBatch(db);
    kampSnap.docs.forEach(d => batch.delete(d.ref));
    tsSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(doc(db, SAM.TRENINGER, app.treningId));
    await batch.commit();

    // Nullstill app-tilstand men behold spillerlisten og valgte spillere
    const bevarteValgte = new Set(app.valgtIds);
    _stoppLyttere();
    sessionStorage.removeItem('aktivTreningId'); sessionStorage.removeItem('aktivTreningKlubbId'); localStorage.removeItem('aktivTreningId'); localStorage.removeItem('aktivTreningKlubbId');
    try { history.replaceState(null, '', location.pathname); } catch (_) {}

    app.treningId    = null;
    app.baneOversikt = [];
    app.venteliste   = [];
    app.runde        = 1;
    _setKampStatusCache({});

    // Gjenopprett valgte spillere
    app.valgtIds = bevarteValgte;

    visMelding('Økt avbrutt — du er tilbake på oppsett.');
    _naviger('oppsett');
    _visSpillere();

    // Bygg cache fra valgte spillere
    _setSisteDeltakereCache({ spillerIds: [...bevarteValgte], hentetMs: Date.now() });

  } catch (e) {
    visFBFeil('Kunne ikke avbryte økt: ' + (e?.message ?? e));
  }
}
window.utforAvbrytOkt = utforAvbrytOkt;
export function visAvsluttEllerAvbryt() {
  if (app.runde === 1 && Object.values(_getKampStatusCache()).every(k => !k.ferdig)) {
    visAvbrytOktModal();
  } else {
    visAvsluttModal();
  }
}
window.visAvsluttEllerAvbryt = visAvsluttEllerAvbryt;

// ════════════════════════════════════════════════════════
// ADMINISTRER DELTAKERE — legg til / fjern spillere midt i økt
// ════════════════════════════════════════════════════════

/**
 * Lagrer ekskluderteIds og venteliste til Firestore.
 * Kalles etter endringer i administrer-deltakere-modalen.
 */
async function _lagreDeltakerEndring() {
  if (!db || !app.treningId) return;
  await updateDoc(doc(db, SAM.TRENINGER, app.treningId), {
    ekskluderteIds: [...(app.ekskluderteIds ?? new Set())],
    venteliste:     app.venteliste ?? [],
  });
}

/**
 * Legger en spiller til ventelisten for inneværende økt.
 * Spilleren kommer inn fra neste runde.
 */
export async function leggTilSpillerIOkt(spillerId) {
  const spiller = (app.spillere ?? []).find(s => s.id === spillerId);
  if (!spiller) return;

  // Fjern fra ekskluderte om de var der
  app.ekskluderteIds?.delete(spillerId);

  // Ikke legg til om de allerede er på en bane eller venteliste
  const paBane = (app.baneOversikt ?? []).some(b =>
    (b.spillere ?? []).some(s => s.id === spillerId)
  );
  const paVenteliste = (app.venteliste ?? []).some(s => s.id === spillerId);

  if (!paBane && !paVenteliste) {
    app.venteliste = [...(app.venteliste ?? []), {
      id:     spiller.id,
      navn:   spiller.navn   ?? 'Ukjent',
      rating: spiller.rating ?? STARTRATING,
    }];
  }

  await _lagreDeltakerEndring();
  visMelding(`${spiller.navn} lagt til på venteliste — kommer inn neste runde.`);
}
window.leggTilSpillerIOkt = leggTilSpillerIOkt;

/**
 * Markerer en spiller som ekskludert — de tas ikke med fra neste runde.
 * Inneværende kamp fullføres normalt.
 */
export async function fjernSpillerFraOkt(spillerId) {
  const spiller = (app.spillere ?? []).find(s => s.id === spillerId)
    ?? (app.baneOversikt ?? []).flatMap(b => b.spillere ?? []).find(s => s.id === spillerId)
    ?? (app.venteliste   ?? []).find(s => s.id === spillerId);
  const navn = spiller?.navn ?? 'Spiller';

  if (!app.ekskluderteIds) app.ekskluderteIds = new Set();
  app.ekskluderteIds.add(spillerId);

  // Fjern umiddelbart fra venteliste
  app.venteliste = (app.venteliste ?? []).filter(s => s.id !== spillerId);

  await _lagreDeltakerEndring();
  visMelding(`${navn} tas ut etter denne runden.`);
}
window.fjernSpillerFraOkt = fjernSpillerFraOkt;
