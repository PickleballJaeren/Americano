// ════════════════════════════════════════════════════════
// hall-of-fame.js — Hall of Fame
//
// Innhold:
//   1. Spilleridentitet  — localStorage, «Hvem er du?»
//   2. Nivåinndeling     — Utfordrer / Etablert / Elite
//   3. Nivådelte titler  — Klatrer, Skarpskytter, Ustoppelig
//   4. Felles rekorder   — Høyest rating, Mest lojal,
//                          Drømmemakkerlaget, Månedens spiller,
//                          Klubbens rivaloppgjør
//   5. Rival-seksjonen   — Rivalen, Nemesis, Du dominerer (privat)
//   6. Personlige merker — Kamp, rating, opprykk, første seier
//   7. GOAT-kåring       — halvårlig, 5-komponent scoringsmodell
//
// Initialiseres fra app.js:
//   import { hofInit } from './hall-of-fame.js';
//   hofInit({ naviger, getAktivKlubbId, getAktivSpillerId,
//             settAktivSpiller, getSpillere });
// ════════════════════════════════════════════════════════

import {
  db, SAM, STARTRATING,
  collection, doc, getDoc, getDocs, setDoc, updateDoc,
  query, where, orderBy,
} from './firebase.js';
import { app }              from './state.js';
import { escHtml }          from './ui.js';
import { lagInitialer }     from './render-helpers.js';
import { eloForventet }     from './rating.js';

// ── Injiserte avhengigheter ──────────────────────────────
let _naviger           = () => {};
let _getAktivKlubbId   = () => null;
let _getAktivSpillerId = () => null;
let _settAktivSpiller  = () => {};
let _getSpillere       = () => [];

export function hofInit(deps) {
  _naviger           = deps.naviger;
  _getAktivKlubbId   = deps.getAktivKlubbId;
  _getAktivSpillerId = deps.getAktivSpillerId;
  _settAktivSpiller  = deps.settAktivSpiller;
  _getSpillere       = deps.getSpillere ?? (() => app.spillere ?? []);
}

// ════════════════════════════════════════════════════════
// KONSTANTER
// ════════════════════════════════════════════════════════
const NIVA = {
  UTFORDRER: { id: 'utfordrer', label: 'Utfordrer', ikon: '🥉', maks: 949 },
  ETABLERT:  { id: 'etablert',  label: 'Etablert',  ikon: '🥈', min: 950,  maks: 1050 },
  ELITE:     { id: 'elite',     label: 'Elite',     ikon: '🥇', min: 1051 },
};

const KAMP_MERKER  = [25, 50, 100, 250, 500];
const RATING_MERKER = [1050, 1100, 1150, 1200];

const MIN_KAMPER_TITTEL  = 15;   // Skarpskytter
const MIN_TRENINGER_GOAT = 8;    // Minimum treninger før GOAT kan kåres
const MIN_KAMPER_RIVAL   = 5;    // Nemesis / Du dominerer
const MIN_KAMPER_MAKKER  = 10;   // Drømmemakkerlaget
const MIN_KAMPER_GOAT    = 8;    // GOAT-kvalifisering

const CACHE_TTL = 10 * 60 * 1000; // 10 min

// ════════════════════════════════════════════════════════
// CACHE — unngår gjentatte Firestore-kall
// ════════════════════════════════════════════════════════
let _cache = {};

function _cachet(nøkkel, verdi) {
  _cache[nøkkel] = { verdi, tid: Date.now() };
}

function _fraCacheEllerNull(nøkkel) {
  const c = _cache[nøkkel];
  if (!c) return null;
  if (Date.now() - c.tid > CACHE_TTL) { delete _cache[nøkkel]; return null; }
  return c.verdi;
}

export function tømHofCache() { _cache = {}; }

// ════════════════════════════════════════════════════════
// HJELPERE
// ════════════════════════════════════════════════════════

/** Returnerer nivå-objekt basert på rating. */
function _nivåFor(rating) {
  const r = rating ?? STARTRATING;
  if (r <= NIVA.UTFORDRER.maks) return NIVA.UTFORDRER;
  if (r <= NIVA.ETABLERT.maks)  return NIVA.ETABLERT;
  return NIVA.ELITE;
}

/** Henter alle ferdigspilte kamper for klubben med caching. */
async function _hentAlleKamper(klubbId) {
  const nøkkel = `kamper_${klubbId}`;
  const cached = _fraCacheEllerNull(nøkkel);
  if (cached) return cached;

  const spillerIds = new Set((_getSpillere()).map(s => s.id));
  if (!spillerIds.size) return [];

  const gyldigeTreningIds = await _hentGyldigeTreningIds(klubbId);
  const alleTreningIds    = await _hentAlleTreningIds(klubbId);

  const snap = await getDocs(query(
    collection(db, SAM.KAMPER),
    where('ferdig', '==', true)
  ));
  const alleDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Cache alle kamper inkl. mix separat — gjenbrukes av visHallOfFame
  // for oppmøte-beregning uten ekstra Firestore-kall.
  const alleInklMix = alleDocs.filter(k =>
    k.lag1Poeng != null && k.lag2Poeng != null &&
    alleTreningIds.has(k.treningId) &&
    spillerIds.has(k.lag1_s1) && spillerIds.has(k.lag2_s1)
  );
  _cachet(`kamper_inkl_mix_${klubbId}`, alleInklMix);

  const kamper = alleDocs.filter(k =>
    k.lag1Poeng != null && k.lag2Poeng != null &&
    gyldigeTreningIds.has(k.treningId) &&
    spillerIds.has(k.lag1_s1) && spillerIds.has(k.lag2_s1)
  );

  _cachet(nøkkel, kamper);
  return kamper;
}

/** Returnerer alle kamper inkl. mix fra cache (fylles av _hentAlleKamper). */
async function _hentAlleKamperInklMix(klubbId) {
  const nøkkel = `kamper_inkl_mix_${klubbId}`;
  const cached = _fraCacheEllerNull(nøkkel);
  if (cached) return cached;
  // Fallback: kjør _hentAlleKamper som fyller cachen
  await _hentAlleKamper(klubbId);
  return _fraCacheEllerNull(nøkkel) ?? [];
}

/** Henter ratinghistorikk for én spiller. */
async function _hentHistorikk(spillerId) {
  const nøkkel = `historikk_${spillerId}`;
  const cached = _fraCacheEllerNull(nøkkel);
  if (cached) return cached;

  const snap = await getDocs(query(
    collection(db, SAM.HISTORIKK),
    where('spillerId', '==', spillerId)
  ));
  const historikk = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.dato?.toMillis?.() ?? 0) - (b.dato?.toMillis?.() ?? 0));

  _cachet(nøkkel, historikk);
  return historikk;
}

/** Henter alle kamper for én spiller. */
/**
 * Henter ALLE kamper for én spiller (inkl. mix).
 * Brukes av kamp-merker — aktivitet teller uavhengig av modus.
 */
async function _hentAlleKamperForSpiller(spillerId) {
  const nøkkel = `spillerkamper_alle_${spillerId}`;
  const cached = _fraCacheEllerNull(nøkkel);
  if (cached) return cached;

  const [s1, s2, s3, s4] = await Promise.all([
    getDocs(query(collection(db, SAM.KAMPER), where('lag1_s1', '==', spillerId), where('ferdig', '==', true))),
    getDocs(query(collection(db, SAM.KAMPER), where('lag1_s2', '==', spillerId), where('ferdig', '==', true))),
    getDocs(query(collection(db, SAM.KAMPER), where('lag2_s1', '==', spillerId), where('ferdig', '==', true))),
    getDocs(query(collection(db, SAM.KAMPER), where('lag2_s2', '==', spillerId), where('ferdig', '==', true))),
  ]);
  const sett = new Map();
  for (const snap of [s1, s2, s3, s4]) snap.docs.forEach(d => sett.set(d.id, { id: d.id, ...d.data() }));
  const kamper = [...sett.values()];

  _cachet(nøkkel, kamper);
  return kamper;
}

/**
 * Henter kun konkurransekamper for én spiller (ekskluderer mix og mix-ab).
 * Brukes av rival-seksjonen — mix-kamper er sosiale og skal ikke påvirke
 * Nemesis, Rival eller «Du dominerer».
 */
async function _hentKonkurranseKamperForSpiller(spillerId, klubbId) {
  const nøkkel = `spillerkamper_konkurranse_${spillerId}`;
  const cached = _fraCacheEllerNull(nøkkel);
  if (cached) return cached;

  // Hent gyldige trenings-IDer for klubben (ekskluderer mix)
  const gyldigeTreningIds = await _hentGyldigeTreningIds(klubbId);

  const alleKamper = await _hentAlleKamperForSpiller(spillerId);
  const kamper = alleKamper.filter(k => gyldigeTreningIds.has(k.treningId));

  _cachet(nøkkel, kamper);
  return kamper;
}

/** Intern hjelper — henter og cacher gyldige trenings-IDer (ekskl. mix) for én klubb. */
async function _hentGyldigeTreningIds(klubbId) {
  if (!klubbId) return new Set();
  const nøkkel = `gyldige_treningids_${klubbId}`;
  const cached = _fraCacheEllerNull(nøkkel);
  if (cached) return cached;

  const snap = await getDocs(query(
    collection(db, SAM.TRENINGER),
    where('klubbId', '==', klubbId)
  ));
  const ids = new Set(
    snap.docs
      .filter(d => !['mix', 'mix-ab'].includes(d.data().spillModus))
      .map(d => d.id)
  );
  _cachet(nøkkel, ids);
  return ids;
}

/** Henter og cacher ALLE trenings-IDer inkl. mix og mix-ab for én klubb. */
async function _hentAlleTreningIds(klubbId) {
  if (!klubbId) return new Set();
  const nøkkel = `alle_treningids_${klubbId}`;
  const cached = _fraCacheEllerNull(nøkkel);
  if (cached) return cached;

  const snap = await getDocs(query(
    collection(db, SAM.TRENINGER),
    where('klubbId', '==', klubbId)
  ));
  const ids = new Set(snap.docs.map(d => d.id));
  _cachet(nøkkel, ids);
  return ids;
}

// ════════════════════════════════════════════════════════
// 1. SPILLERIDENTITET
// ════════════════════════════════════════════════════════

/** Oppdaterer identitets-chip og «Min profil»-knapper overalt i appen. */
export function oppdaterIdentitetsUI() {
  const spillerId = _getAktivSpillerId();
  const spillere  = _getSpillere();
  const spiller   = spillere.find(s => s.id === spillerId);

  // Chip på hjem-skjermen
  const chip = document.getElementById('hof-identitet-chip');
  if (chip) {
    // Skjul helt hvis ingen klubb er valgt ennå
    if (!spillere.length) {
      chip.style.display = 'none';
    } else if (spiller) {
      chip.innerHTML = `
        <span style="font-size:14px">👤</span>
        <span style="font-size:14px;font-weight:600;color:var(--white)">${escHtml(spiller.navn)}</span>
        <button onclick="hofÅpneMinProfil()" style="background:var(--accent);border:none;border-radius:8px;padding:4px 10px;color:#fff;font-size:13px;cursor:pointer">Min profil</button>
        <button onclick="hofByttIdentitet()" style="background:none;border:none;color:var(--muted2);font-size:12px;cursor:pointer;text-decoration:underline">Bytt</button>`;
      chip.style.display = 'flex';
    } else {
      chip.innerHTML = `
        <span style="font-size:14px">👤</span>
        <button onclick="hofVelgIdentitet()" style="background:none;border:none;color:var(--muted2);font-size:14px;cursor:pointer;text-decoration:underline">Hvem er du? Velg deg selv →</button>`;
      chip.style.display = 'flex';
    }
  }

  // «Min profil»-knapp i ledertavlen
  const minProfilKnapp = document.getElementById('hof-min-profil-knapp');
  if (minProfilKnapp) {
    if (spiller) {
      minProfilKnapp.textContent = `👤 ${spiller.navn} — Min profil`;
      minProfilKnapp.style.display = 'flex';
    } else {
      minProfilKnapp.style.display = 'none';
    }
  }

  // Fyll identitets-velger-dropdown
  const velger = document.getElementById('hof-identitet-velger');
  if (velger) {
    const sorterte = [...spillere].sort((a, b) => (a.navn ?? '').localeCompare(b.navn ?? '', 'nb'));
    velger.innerHTML = '<option value="">— Velg deg selv —</option>' +
      sorterte.map(s => `<option value="${s.id}" ${s.id === spillerId ? 'selected' : ''}>${escHtml(s.navn)}</option>`).join('');
  }
}

window.hofVelgIdentitet = function() {
  const modal = document.getElementById('hof-identitet-modal');
  if (modal) modal.style.display = 'flex';
  oppdaterIdentitetsUI();
};

window.hofBekreftIdentitet = function() {
  const velger = document.getElementById('hof-identitet-velger');
  if (!velger?.value) return;
  _settAktivSpiller(velger.value);
  const modal = document.getElementById('hof-identitet-modal');
  if (modal) modal.style.display = 'none';
  oppdaterIdentitetsUI();
};

window.hofByttIdentitet = function() {
  _settAktivSpiller(null);
  oppdaterIdentitetsUI();
  hofVelgIdentitet();
};

window.hofÅpneMinProfil = function() {
  const spillerId = _getAktivSpillerId();
  if (spillerId && window.apneGlobalProfil) window.apneGlobalProfil(spillerId);
};

// ════════════════════════════════════════════════════════
// 2–4. HALL OF FAME — HOVED-RENDER
// ════════════════════════════════════════════════════════

export async function visHallOfFame() {
  const beholder = document.getElementById('hof-innhold');
  if (!beholder) return;

  const klubbId = _getAktivKlubbId();
  if (!klubbId || !db) {
    beholder.innerHTML = _tomTilstand('Velg klubb for å se Hall of Fame');
    return;
  }

  beholder.innerHTML = _lasterHTML('Laster Hall of Fame…');

  try {
    const spillere = _getSpillere();
    // _hentAlleKamper fyller også kamper_inkl_mix-cachen i samme kall —
    // ingen ekstra Firestore-runde for Mix-oppmøte-beregningen.
    const [kamper, historikkMap, alleKamperInklMix, goatPeriode] = await Promise.all([
      _hentAlleKamper(klubbId),
      _hentHistorikkForAlle(spillere),
      _hentAlleKamperInklMix(klubbId),
      _hentGoatKonfig(klubbId),
    ]);
    const periodeMs = goatPeriode.periodeStart.getTime();

    beholder.innerHTML = [
      _renderNivådelteSeksjoner(spillere, kamper, historikkMap, periodeMs),
      _renderFellesRekorder(spillere, kamper, historikkMap, alleKamperInklMix),
      '<div id="hof-live-stilling">' + _lasterHTML('Beregner live-stilling…') + '</div>',
      _renderGOATArkiv(klubbId),
    ].join('');

    // Last asynkrone seksjoner etter at resten er synlig
    _renderLiveStilling(klubbId);
    _renderMånedenSpiller(klubbId, spillere, kamper);

  } catch (e) {
    console.error('[HoF]', e);
    beholder.innerHTML = _tomTilstand('Kunne ikke laste Hall of Fame');
  }
}

async function _hentHistorikkForAlle(spillere) {
  const map = {};
  await Promise.all(spillere.map(async s => {
    map[s.id] = await _hentHistorikk(s.id);
  }));
  return map;
}

// ════════════════════════════════════════════════════════
// 3. NIVÅDELTE TITLER
// ════════════════════════════════════════════════════════

function _renderNivådelteSeksjoner(spillere, kamper, historikkMap, periodeMs) {
  const nivåer = [NIVA.ELITE, NIVA.ETABLERT, NIVA.UTFORDRER];
  // Filtrer kamper til GOAT-perioden — Skarpskytter og Ustoppelig
  // skal kun gjelde inneværende sesong, ikke all-time.
  const filtrerte = periodeMs
    ? kamper.filter(k => (k.dato?.toMillis?.() ?? 0) >= periodeMs)
    : kamper;
  // Fallback til alle kamper om perioden ikke har nok data ennå
  const periodeKamper = filtrerte.length >= 3 ? filtrerte : kamper;

  return nivåer.map(niv => {
    const gruppe = spillere.filter(s => _nivåFor(s.rating).id === niv.id);
    if (!gruppe.length) return '';

    const fremgang  = _beregnFremgangskonge(gruppe, historikkMap, periodeMs);
    const skarp     = _beregnSkarpskytter(gruppe, periodeKamper);
    const ukuelig   = _beregnUkuelig(gruppe, periodeKamper);

    return `
      <div class="seksjon-etikett">${niv.ikon} ${niv.label}</div>
      <div class="kort" style="margin-bottom:14px">
        <div class="kort-innhold" style="padding:0">
          ${_titelRad('📈', 'Klatrer', fremgang, v => `+${v.delta} rating siste 60 dager`)}
          ${_titelRad('🎯', 'Skarpskytter', skarp, v => `${v.winRate}% winrate · ${v.kamper} kamper`)}
          ${_titelRad('🔥', 'Ustoppelig', ukuelig, v => `${v.streak} seire på rad`)}
        </div>
      </div>`;
  }).join('');
}

function _beregnFremgangskonge(spillere, historikkMap, periodeMs) {
  const grense = periodeMs ?? (Date.now() - 60 * 24 * 60 * 60 * 1000);
  let beste = null;

  for (const s of spillere) {
    const hist = (historikkMap[s.id] ?? []).filter(h => (h.dato?.toMillis?.() ?? 0) >= grense);
    if (!hist.length) continue;
    const delta = hist.reduce((sum, h) => sum + (h.endring ?? 0), 0);
    if (!beste || delta > beste.delta) beste = { id: s.id, navn: s.navn, delta };
  }
  return beste;
}

function _beregnSkarpskytter(spillere, kamper) {
  const spillerIds = new Set(spillere.map(s => s.id));
  const stat = {};

  for (const k of kamper) {
    const ids = [
      { id: k.lag1_s1, vant: k.lag1Poeng > k.lag2Poeng },
      { id: k.lag1_s2, vant: k.lag1Poeng > k.lag2Poeng },
      { id: k.lag2_s1, vant: k.lag2Poeng > k.lag1Poeng },
      { id: k.lag2_s2, vant: k.lag2Poeng > k.lag1Poeng },
    ].filter(x => x.id && spillerIds.has(x.id));

    for (const { id, vant } of ids) {
      if (!stat[id]) stat[id] = { seire: 0, kamper: 0 };
      stat[id].kamper++;
      if (vant) stat[id].seire++;
    }
  }

  let beste = null;
  for (const s of spillere) {
    const st = stat[s.id];
    if (!st || st.kamper < MIN_KAMPER_TITTEL) continue;
    const winRate = Math.round((st.seire / st.kamper) * 100);
    if (!beste || winRate > beste.winRate) beste = { id: s.id, navn: s.navn, winRate, kamper: st.kamper };
  }
  return beste;
}

function _beregnUkuelig(spillere, kamper) {
  const spillerIds = new Set(spillere.map(s => s.id));

  // Bygg kronologisk resultatliste per spiller
  const resultater = {};
  const sorterte   = [...kamper].sort((a, b) => (a.dato?.toMillis?.() ?? 0) - (b.dato?.toMillis?.() ?? 0));

  for (const k of sorterte) {
    const legg = (id, vant) => {
      if (!id || !spillerIds.has(id)) return;
      if (!resultater[id]) resultater[id] = [];
      resultater[id].push(vant);
    };
    legg(k.lag1_s1, k.lag1Poeng > k.lag2Poeng);
    legg(k.lag1_s2, k.lag1Poeng > k.lag2Poeng);
    legg(k.lag2_s1, k.lag2Poeng > k.lag1Poeng);
    legg(k.lag2_s2, k.lag2Poeng > k.lag1Poeng);
  }

  let beste = null;
  for (const s of spillere) {
    const res = resultater[s.id] ?? [];
    let streak = 0, maks = 0;
    for (const vant of res) {
      if (vant) { streak++; maks = Math.max(maks, streak); }
      else streak = 0;
    }
    if (!beste || maks > beste.streak) beste = { id: s.id, navn: s.navn, streak: maks };
  }
  return beste;
}

// ════════════════════════════════════════════════════════
// 4. FELLES REKORDER
// ════════════════════════════════════════════════════════

function _renderFellesRekorder(spillere, kamper, historikkMap, alleKamperInklMix) {
  const høyestRating   = _beregnHøyestRating(spillere, historikkMap);
  const mestLoyal      = _beregnMestLoyal(spillere, historikkMap, alleKamperInklMix);
  const drømmemakker   = _beregnDrømmemakker(kamper);
  const rivaloppgjør   = _beregnKlubbensRivaloppgjør(kamper);

  // Månedens spiller rendres med placeholder — fylles asynkront av _renderMånedenSpiller()
  return `
    <div class="seksjon-etikett">🌍 Felles rekorder</div>
    <div class="kort" style="margin-bottom:14px">
      <div class="kort-innhold" style="padding:0">
        ${_titelRad('👑', 'Høyest rating noensinne', høyestRating, v => `${v.toppRating} rating`)}
        ${_titelRad('🏅', 'Mest lojale spiller', mestLoyal, v => `${v.antallTreninger} treninger`)}
        ${_renderDrømmemakkerRad(drømmemakker)}
        <div id="hof-maneden-rad"><div style="padding:12px 16px;color:var(--muted2);font-size:14px">⚡ Laster månedens spiller…</div></div>
      </div>
    </div>
    ${rivaloppgjør ? _renderRivaloppgjørKort(rivaloppgjør) : ''}`;
}

/**
 * Rendrer Månedens spiller-raden asynkront og injiserer i DOM.
 * Viser siste arkiverte vinner + live-kandidat for inneværende måned.
 */
async function _renderMånedenSpiller(klubbId, spillere, kamper) {
  const beholder = document.getElementById('hof-maneden-rad');
  if (!beholder) return;

  try {
    const { siste, live } = await _hentMånedenSpillerData(klubbId, spillere, kamper);
    const nå = new Date();
    const månedLabel = new Date(nå.getFullYear(), nå.getMonth(), 1)
      .toLocaleDateString('no-NO', { month: 'long', year: 'numeric' });

    // Live-rad for inneværende måned
    const liveHTML = live
      ? `<div style="display:flex;align-items:center;gap:12px;padding:10px 16px">
          <div style="font-size:22px">⚡</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;font-weight:600;color:var(--white)">${escHtml(live.navn)}</div>
            <div style="font-size:12px;color:var(--muted2);margin-top:2px">${månedLabel} (pågår) · ${live.kamper} kamper</div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div style="font-family:'DM Mono',monospace;font-size:16px;font-weight:700;color:var(--green2)">+${live.overperfPst}%</div>
            <div style="font-size:11px;color:var(--muted2)">over forventet</div>
          </div>
        </div>`
      : `<div style="padding:12px 16px;font-size:13px;color:var(--muted2)">⚡ Månedens spiller — ikke nok data ennå (min. 3 kamper)</div>`;

    // Siste arkiverte vinner (forrige måned)
    const sisteHTML = siste
      ? `<div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-top:1px solid var(--border);opacity:.65">
          <div style="font-size:18px">🏆</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--white)">${escHtml(siste.navn)}</div>
            <div style="font-size:12px;color:var(--muted2);margin-top:1px">${_formatMånedNøkkel(siste.måned)} · ${siste.kamper} kamper</div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div style="font-family:'DM Mono',monospace;font-size:14px;font-weight:600;color:var(--muted2)">+${siste.overperfPst}%</div>
          </div>
        </div>`
      : '';

    beholder.innerHTML = liveHTML + sisteHTML;
  } catch (e) {
    console.warn('[MånedenSpiller]', e?.message ?? e);
    const el = document.getElementById('hof-maneden-rad');
    if (el) el.innerHTML = '<div style="padding:12px 16px;color:var(--muted2);font-size:13px">⚡ Månedens spiller — kunne ikke laste</div>';
  }
}

function _beregnHøyestRating(spillere, historikkMap) {
  let beste = null;
  for (const s of spillere) {
    const hist     = historikkMap[s.id] ?? [];
    const toppHist = hist.length ? Math.max(...hist.map(h => h.ratingEtter ?? STARTRATING)) : STARTRATING;
    const toppRating = Math.max(s.rating ?? STARTRATING, toppHist);
    if (!beste || toppRating > beste.toppRating) beste = { id: s.id, navn: s.navn, toppRating };
  }
  return beste;
}

function _beregnMestLoyal(spillere, historikkMap, alleKamperInklMix) {
  // Bygg oppmøte-kart fra alle kamper (inkl. mix) — teller unike trenings-IDer per spiller
  const treningSetMap = {};
  for (const k of (alleKamperInklMix ?? [])) {
    if (!k.treningId) continue;
    for (const id of [k.lag1_s1, k.lag1_s2, k.lag2_s1, k.lag2_s2].filter(Boolean)) {
      if (!treningSetMap[id]) treningSetMap[id] = new Set();
      treningSetMap[id].add(k.treningId);
    }
  }
  let beste = null;
  for (const s of spillere) {
    // Bruk kamp-basert oppmøte (inkl. mix) om tilgjengelig, ellers fall tilbake på historikk
    const antallTreninger = treningSetMap[s.id]?.size ?? (historikkMap[s.id] ?? []).length;
    if (!beste || antallTreninger > beste.antallTreninger) beste = { id: s.id, navn: s.navn, antallTreninger };
  }
  return beste;
}

function _beregnDrømmemakker(kamper) {
  const parMap = {};

  for (const k of kamper) {
    const registrerPar = (id1, id2, vant) => {
      if (!id1 || !id2) return;
      // Sorter ID-ene for konsistent nøkkel, men behold mapping til navn
      const sortert = [id1, id2].sort();
      const nøkkel  = sortert.join('_');
      if (!parMap[nøkkel]) parMap[nøkkel] = { id1: sortert[0], id2: sortert[1], navn1: null, navn2: null, seire: 0, kamper: 0 };
      parMap[nøkkel].kamper++;
      if (vant) parMap[nøkkel].seire++;

      // Hent navn fra kamp-dokumentet basert på faktisk ID-plassering
      const hentNavn = (id) => {
        if (k.lag1_s1 === id) return k.lag1_s1_navn;
        if (k.lag1_s2 === id) return k.lag1_s2_navn;
        if (k.lag2_s1 === id) return k.lag2_s1_navn;
        if (k.lag2_s2 === id) return k.lag2_s2_navn;
        return null;
      };
      // Oppdater kun om navn mangler (unngå å overskrive med null)
      if (!parMap[nøkkel].navn1) parMap[nøkkel].navn1 = hentNavn(sortert[0]);
      if (!parMap[nøkkel].navn2) parMap[nøkkel].navn2 = hentNavn(sortert[1]);
    };

    if (k.lag1_s1 && k.lag1_s2) registrerPar(k.lag1_s1, k.lag1_s2, k.lag1Poeng > k.lag2Poeng);
    if (k.lag2_s1 && k.lag2_s2) registrerPar(k.lag2_s1, k.lag2_s2, k.lag2Poeng > k.lag1Poeng);
  }

  let beste = null;
  for (const par of Object.values(parMap)) {
    if (par.kamper < MIN_KAMPER_MAKKER) continue;
    const winRate = Math.round((par.seire / par.kamper) * 100);
    if (!beste || winRate > beste.winRate) beste = { ...par, winRate };
  }
  return beste;
}

// ════════════════════════════════════════════════════════
// MÅNEDENS SPILLER — arkivert månedlig
// ════════════════════════════════════════════════════════

/**
 * Beregner overperformance for én spiller over en liste kamper.
 * Returnerer { id, navn, overperfPst, kamper } eller null.
 */
function _beregnMånedsVinner(spillere, kamper) {
  const ratingMap = {};
  spillere.forEach(s => { ratingMap[s.id] = s.rating ?? STARTRATING; });

  const bidragMap = {};
  for (const k of kamper) {
    const rA = (ratingMap[k.lag1_s1] ?? STARTRATING + (ratingMap[k.lag1_s2] ?? STARTRATING)) / (k.lag1_s2 ? 2 : 1);
    const rB = (ratingMap[k.lag2_s1] ?? STARTRATING + (ratingMap[k.lag2_s2] ?? STARTRATING)) / (k.lag2_s2 ? 2 : 1);
    const forventetA = eloForventet(rA, rB);
    const faktiskA   = k.lag1Poeng > k.lag2Poeng ? 1 : k.lag1Poeng < k.lag2Poeng ? 0 : 0.5;

    const registrer = (id, navn, faktisk, forventet) => {
      if (!id || !ratingMap[id]) return;
      if (!bidragMap[id]) bidragMap[id] = { navn: navn ?? 'Ukjent', sum: 0, kamper: 0 };
      bidragMap[id].sum    += (faktisk - forventet);
      bidragMap[id].kamper++;
    };

    registrer(k.lag1_s1, k.lag1_s1_navn, faktiskA,     forventetA);
    registrer(k.lag1_s2, k.lag1_s2_navn, faktiskA,     forventetA);
    registrer(k.lag2_s1, k.lag2_s1_navn, 1 - faktiskA, 1 - forventetA);
    registrer(k.lag2_s2, k.lag2_s2_navn, 1 - faktiskA, 1 - forventetA);
  }

  let beste = null;
  for (const [id, b] of Object.entries(bidragMap)) {
    if (b.kamper < 3) continue;
    const overperfPst = Math.round((b.sum / b.kamper) * 100);
    if (!beste || overperfPst > beste.overperfPst) beste = { id, navn: b.navn, overperfPst, kamper: b.kamper };
  }
  return beste;
}

/**
 * Henter månedArkiv fra klubb-dokumentet.
 * Returnerer array sortert med nyeste først.
 */
async function _hentMånedArkiv(klubbId) {
  try {
    const snap = await getDoc(doc(db, 'klubber', klubbId));
    return (snap.data()?.månedArkiv ?? []).sort((a, b) => b.måned.localeCompare(a.måned));
  } catch { return []; }
}

/**
 * Arkiverer månedens vinner for forrige måned dersom det ikke allerede
 * er gjort. Kalles automatisk ved lasting av Hall of Fame.
 * Bruker setDoc med merge:true — trygt å kalle flere ganger.
 */
async function _arkiverForrigeMånedHvisNødvendig(klubbId, spillere, kamper) {
  const nå         = new Date();
  const forrigeMnd = new Date(nå.getFullYear(), nå.getMonth() - 1, 1);
  const månedNøkkel = `${forrigeMnd.getFullYear()}-${String(forrigeMnd.getMonth() + 1).padStart(2, '0')}`;

  // Sjekk om allerede arkivert
  const arkiv = await _hentMånedArkiv(klubbId);
  if (arkiv.some(a => a.måned === månedNøkkel)) return; // allerede gjort

  // Filtrer kamper for forrige kalendermåned
  const fraMs = forrigeMnd.getTime();
  const tilMs = new Date(nå.getFullYear(), nå.getMonth(), 1).getTime();
  const månedKamper = kamper.filter(k => {
    const d = k.dato?.toMillis?.() ?? 0;
    return d >= fraMs && d < tilMs;
  });

  const vinner = _beregnMånedsVinner(spillere, månedKamper);
  if (!vinner) return; // ikke nok data — arkiver ikke

  const nyPost = {
    måned:       månedNøkkel,
    spillerId:   vinner.id,
    navn:        vinner.navn,
    overperfPst: vinner.overperfPst,
    kamper:      vinner.kamper,
    kåretDato:   new Date().toISOString(),
  };

  // Legg til i arkivet (maks 24 måneder — ca. 2 år)
  const oppdatert = [nyPost, ...arkiv].slice(0, 24);
  await setDoc(doc(db, 'klubber', klubbId), { månedArkiv: oppdatert }, { merge: true });
}

/**
 * Henter live-kandidat for inneværende måned (ikke arkivert ennå).
 */
function _beregnLiveMånedKandidat(spillere, kamper) {
  const nå   = new Date();
  const fraMs = new Date(nå.getFullYear(), nå.getMonth(), 1).getTime();
  const månedKamper = kamper.filter(k => (k.dato?.toMillis?.() ?? 0) >= fraMs);
  return _beregnMånedsVinner(spillere, månedKamper);
}

/**
 * Erstatter gammel _beregnMånedenSpiller — returnerer { arkiv, live }
 * der arkiv er siste arkiverte vinner og live er inneværende måneds kandidat.
 * Arkivering av forrige måned skjer som sideeffekt asynkront.
 */
async function _hentMånedenSpillerData(klubbId, spillere, kamper) {
  // Arkiver forrige måned i bakgrunnen (ingen await — blokkerer ikke UI)
  _arkiverForrigeMånedHvisNødvendig(klubbId, spillere, kamper).catch(e =>
    console.warn('[MånedArkiv]', e?.message ?? e)
  );

  const arkiv = await _hentMånedArkiv(klubbId);
  const live  = _beregnLiveMånedKandidat(spillere, kamper);
  return { siste: arkiv[0] ?? null, live };
}

/** Formaterer månednøkkel "2025-06" til "Juni 2025" */
function _formatMånedNøkkel(nøkkel) {
  if (!nøkkel) return '';
  const [år, mnd] = nøkkel.split('-');
  return new Date(Number(år), Number(mnd) - 1, 1)
    .toLocaleDateString('no-NO', { month: 'long', year: 'numeric' });
}

function _beregnKlubbensRivaloppgjør(kamper) {
  const møterMap = {};

  for (const k of kamper) {
    const lag1 = [k.lag1_s1, k.lag1_s2].filter(Boolean);
    const lag2 = [k.lag2_s1, k.lag2_s2].filter(Boolean);
    const lag1Vant = k.lag1Poeng > k.lag2Poeng;

    for (const id1 of lag1) {
      for (const id2 of lag2) {
        // Sorter alltid slik at nøkkelen er konsistent uavhengig av kampretning
        const sortert   = [id1, id2].sort();
        const nøkkel    = sortert.join('_');
        const førstErId1 = sortert[0] === id1; // id1 (lag1-spiller) er først i sortert rekkefølge

        if (!møterMap[nøkkel]) møterMap[nøkkel] = {
          id1: sortert[0], id2: sortert[1],
          navn1: null, navn2: null,
          møter: 0, seire1: 0, seire2: 0,
          kampIds: new Set(),
        };

        // Lagre navn på riktig plass basert på sortert rekkefølge
        const oppføring = møterMap[nøkkel];
        if (!oppføring.navn1) oppføring.navn1 = førstErId1 ? k.lag1_s1_navn ?? k.lag1_s2_navn : k.lag2_s1_navn ?? k.lag2_s2_navn;
        if (!oppføring.navn2) oppføring.navn2 = førstErId1 ? k.lag2_s1_navn ?? k.lag2_s2_navn : k.lag1_s1_navn ?? k.lag1_s2_navn;

        // Tel kun én gang per kamp per par
        if (oppføring.kampIds.has(k.id)) continue;
        oppføring.kampIds.add(k.id);
        oppføring.møter++;

        // seire1 = seire for sortert[0], seire2 = seire for sortert[1]
        // id1 er på lag1-siden, så lag1Vant betyr id1 vant
        const id1Vant = lag1Vant;
        if (førstErId1) {
          if (id1Vant) oppføring.seire1++; else oppføring.seire2++;
        } else {
          if (id1Vant) oppføring.seire2++; else oppføring.seire1++;
        }
      }
    }
  }

  return Object.values(møterMap).sort((a, b) => b.møter - a.møter)[0] ?? null;
}

function _renderRivaloppgjørKort(r) {
  const ini1 = lagInitialer(r.navn1 ?? '?');
  const ini2 = lagInitialer(r.navn2 ?? '?');
  const leder = r.seire1 > r.seire2 ? r.navn1 : r.seire2 > r.seire1 ? r.navn2 : null;

  return `
    <div class="seksjon-etikett">⚔️ Klubbens største rivaloppgjør</div>
    <div class="kort" style="margin-bottom:14px">
      <div class="kort-hode">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:22px">⚔️</span>
          <div>
            <div style="font-family:'Bebas Neue',cursive;font-size:20px;letter-spacing:1px;color:var(--yellow)">${escHtml(r.navn1 ?? '?')} vs ${escHtml(r.navn2 ?? '?')}</div>
            <div style="font-size:13px;color:var(--muted2)">${r.møter} møter totalt</div>
          </div>
        </div>
      </div>
      <div class="kort-innhold">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
          <div style="flex:1;text-align:center">
            <div class="lb-avatar" style="margin:0 auto 6px">${ini1}</div>
            <div style="font-size:15px;font-weight:600">${escHtml(r.navn1 ?? '?')}</div>
          </div>
          <div style="font-family:'Bebas Neue',cursive;font-size:42px;color:var(--yellow);display:flex;align-items:center;gap:8px">
            <span style="color:${r.seire1 >= r.seire2 ? 'var(--green2)' : 'var(--muted2)'}">${r.seire1}</span>
            <span style="color:var(--muted);font-size:24px">–</span>
            <span style="color:${r.seire2 >= r.seire1 ? 'var(--green2)' : 'var(--muted2)'}">${r.seire2}</span>
          </div>
          <div style="flex:1;text-align:center">
            <div class="lb-avatar" style="margin:0 auto 6px;background:var(--orange)">${ini2}</div>
            <div style="font-size:15px;font-weight:600">${escHtml(r.navn2 ?? '?')}</div>
          </div>
        </div>
        ${leder ? `<div style="text-align:center;font-size:14px;color:var(--muted2)">🏆 ${escHtml(leder)} leder det historiske oppgjøret</div>` : '<div style="text-align:center;font-size:14px;color:var(--muted2)">Likt i det historiske oppgjøret</div>'}
      </div>
    </div>`;
}

// ════════════════════════════════════════════════════════
// 5. RIVAL-SEKSJONEN (privat — kun i spillerprofilen)
// ════════════════════════════════════════════════════════

/**
 * Vises i global-profil-skjermen.
 * Kalles fra global-profil.js: await visRivalSeksjon(spillerId)
 */
export async function visRivalSeksjon(spillerId) {
  const beholder = document.getElementById('hof-rival-seksjon');
  if (!beholder) return;

  const erMinProfil = spillerId === _getAktivSpillerId();
  if (!erMinProfil) { beholder.style.display = 'none'; return; }

  beholder.style.display = 'block';
  beholder.innerHTML = _lasterHTML('Beregner rivaloppgjør…');

  try {
    const klubbId = _getAktivKlubbId();
    const kamper = await _hentKonkurranseKamperForSpiller(spillerId, klubbId);
    if (!kamper.length) { beholder.innerHTML = ''; return; }

    const motstanderMap = {};

    for (const k of kamper) {
      const erLag1 = k.lag1_s1 === spillerId || k.lag1_s2 === spillerId;
      const vant   = erLag1 ? k.lag1Poeng > k.lag2Poeng : k.lag2Poeng > k.lag1Poeng;
      const dato   = k.dato?.toMillis?.() ?? 0;

      // Hent alle motstandere i denne kampen (1 eller 2)
      const motstandere = erLag1
        ? [{ id: k.lag2_s1, navn: k.lag2_s1_navn }, { id: k.lag2_s2, navn: k.lag2_s2_navn }]
        : [{ id: k.lag1_s1, navn: k.lag1_s1_navn }, { id: k.lag1_s2, navn: k.lag1_s2_navn }];

      for (const mot of motstandere.filter(m => m.id)) {
        if (!motstanderMap[mot.id]) motstanderMap[mot.id] = {
          id: mot.id, navn: mot.navn ?? 'Ukjent',
          seire: 0, kamper: 0, sisteDato: null, siste5: [],
          kampIds: new Set(),
        };

        // Tel kun én gang per kamp per motstander — unngår dobbelttelling
        if (motstanderMap[mot.id].kampIds.has(k.id)) continue;
        motstanderMap[mot.id].kampIds.add(k.id);
        motstanderMap[mot.id].kamper++;
        if (vant) motstanderMap[mot.id].seire++;

        if (!motstanderMap[mot.id].sisteDato || dato > motstanderMap[mot.id].sisteDato) {
          motstanderMap[mot.id].sisteDato = dato;
        }
        motstanderMap[mot.id].siste5.push({ vant, dato });
      }
    }

    // Sorter siste 5 kronologisk og behold de 5 siste
    for (const m of Object.values(motstanderMap)) {
      m.siste5 = m.siste5.sort((a, b) => b.dato - a.dato).slice(0, 5).map(x => x.vant);
      m.winRate = Math.round((m.seire / m.kamper) * 100);
    }

    const alle     = Object.values(motstanderMap);
    const rival    = [...alle].sort((a, b) => b.kamper - a.kamper)[0];
    const kvalifiserte = alle.filter(m => m.kamper >= MIN_KAMPER_RIVAL);
    // Bruk separate sorterte kopier — .sort() muterer in-place og ville ellers
    // gi samme person i begge slots om det bare er én kvalifisert motstander.
    // Nemesis: lavest winRate. Dominerer: høyest winRate OG faktisk over 50%.
    const nemesis   = [...kvalifiserte].sort((a, b) => a.winRate - b.winRate)[0] ?? null;
    const dominerer = [...kvalifiserte]
      .filter(m => m.winRate > 50)
      .sort((a, b) => b.winRate - a.winRate)[0] ?? null;

    beholder.innerHTML = `
      <div class="seksjon-etikett">⚔️ Dine rivaloppgjør</div>
      ${rival    ? _renderRivalKort(rival,    'rival')    : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
        ${nemesis   ? _renderMiniRivalKort(nemesis,   '😤', 'Nemesis',      false) : ''}
        ${dominerer ? _renderMiniRivalKort(dominerer, '🏆', 'Du dominerer', true)  : ''}
      </div>`;

  } catch (e) {
    console.warn('[HoF rival]', e?.message ?? e);
    beholder.innerHTML = '';
  }
}

function _renderRivalKort(m, type) {
  const ini      = lagInitialer(m.navn);
  const datoStr  = m.sisteDato
    ? new Date(m.sisteDato).toLocaleDateString('nb-NO', { day: 'numeric', month: 'short' })
    : '—';
  const w = m.seire, l = m.kamper - m.seire;

  return `
    <div class="kort" style="margin-bottom:8px">
      <div class="kort-hode">
        <div style="display:flex;align-items:center;gap:10px;flex:1">
          <div class="lb-avatar">${ini}</div>
          <div>
            <div style="font-size:16px;font-weight:600">${escHtml(m.navn)}</div>
            <div style="font-size:12px;color:var(--muted2);margin-top:1px">⚔️ Din rival — flest møter</div>
          </div>
        </div>
      </div>
      <div class="kort-innhold">
        <div style="display:flex;align-items:center;margin-bottom:10px">
          <div style="font-family:'Bebas Neue',cursive;font-size:48px;color:${w >= l ? 'var(--green2)' : 'var(--muted2)'};flex:1;text-align:center">${w}</div>
          <div style="font-size:18px;color:var(--muted)">–</div>
          <div style="font-family:'Bebas Neue',cursive;font-size:48px;color:${l >= w ? 'var(--red2)' : 'var(--muted2)'};flex:1;text-align:center">${l}</div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--muted2);background:rgba(255,255,255,.04);padding:4px 10px;border-radius:20px">${m.kamper} møter totalt</span>
          <span style="font-size:12px;color:var(--muted2);background:rgba(255,255,255,.04);padding:4px 10px;border-radius:20px">Sist: ${datoStr}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:12px;color:var(--muted2);margin-right:2px">Siste 5:</span>
          ${m.siste5.map(v => `<div style="width:22px;height:22px;border-radius:50%;background:${v ? 'rgba(34,197,94,.2)' : 'rgba(220,38,38,.2)'};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:${v ? 'var(--green2)' : 'var(--red2)'}">${v ? 'S' : 'T'}</div>`).join('')}
        </div>
      </div>
    </div>`;
}

function _renderMiniRivalKort(m, ikon, etikett, erDominans) {
  const ini   = lagInitialer(m.navn);
  const w     = m.seire, l = m.kamper - m.seire;
  const farge = erDominans ? 'var(--green2)' : 'var(--red2)';

  return `
    <div class="kort" style="margin:0">
      <div style="padding:10px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
        <div class="lb-avatar" style="width:32px;height:32px;font-size:14px">${ini}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(m.navn)}</div>
          <div style="font-size:11px;color:var(--muted2)">${ikon} ${etikett}</div>
        </div>
      </div>
      <div style="padding:10px 12px;display:flex;align-items:center;gap:6px">
        <div style="font-family:'Bebas Neue',cursive;font-size:28px;color:${erDominans ? 'var(--green2)' : 'var(--muted2)'};flex:1;text-align:center">${w}</div>
        <div style="font-size:14px;color:var(--muted)">–</div>
        <div style="font-family:'Bebas Neue',cursive;font-size:28px;color:${erDominans ? 'var(--muted2)' : 'var(--red2)'};flex:1;text-align:center">${l}</div>
      </div>
      <div style="padding:0 12px 10px;font-size:12px;color:var(--muted2)">${m.winRate}% winrate · ${m.kamper} møter</div>
    </div>`;
}

// ════════════════════════════════════════════════════════
// 6. PERSONLIGE MERKER
// ════════════════════════════════════════════════════════

/**
 * Vises i global-profil-skjermen.
 * Kalles fra global-profil.js: await visMerker(spillerId, kamper, historikk)
 */
export async function visMerker(spillerId, alleKamper, historikk) {
  const beholder = document.getElementById('hof-merker-seksjon');
  if (!beholder) return;

  try {
    const stat       = _beregnMerkeStat(spillerId, alleKamper, historikk);
    const niva       = _nivåFor(stat.toppRating);
    const forrigeNiv = stat.harVærtEtablert ? NIVA.ETABLERT : null;

    beholder.innerHTML = `
      <div class="seksjon-etikett">🎖️ Dine merker</div>
      <div class="kort" style="margin-bottom:14px">
        <div class="kort-innhold">

          <div style="margin-bottom:14px">
            <div style="font-size:13px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Kamper spilt</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${KAMP_MERKER.map(mål => _merkePill(stat.totalKamper >= mål, `${mål}`, `${mål} kamper`)).join('')}
            </div>
            <div style="margin-top:8px">
              ${_fremgangsbar(stat.totalKamper, KAMP_MERKER)}
            </div>
          </div>

          <div style="margin-bottom:14px">
            <div style="font-size:13px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Topprating oppnådd</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${RATING_MERKER.map(mål => _merkePill(stat.toppRating >= mål, `${mål}`, `${mål} rating`)).join('')}
            </div>
          </div>

          <div>
            <div style="font-size:13px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Milepæler</div>
            <div style="display:flex;flex-direction:column;gap:8px">
              ${_milepælKort(stat.harFørsteSeier,   '🌟', 'Første seier',        'Du har vunnet din første kamp')}
              ${_milepælKort(stat.harVærtEtablert,  '🥈', 'Etablert spiller',    'Du har nådd 950 i rating — over snittet i klubben')}
              ${_milepælKort(stat.harVærtElite,     '🥇', 'Elite spiller',       'Du har nådd 1050 i rating — blant klubbens beste')}
            </div>
          </div>

        </div>
      </div>`;

  } catch (e) {
    console.warn('[HoF merker]', e?.message ?? e);
    beholder.innerHTML = '';
  }
}

function _beregnMerkeStat(spillerId, kamper, historikk) {
  const egneKamper = kamper.filter(k =>
    k.lag1_s1 === spillerId || k.lag1_s2 === spillerId ||
    k.lag2_s1 === spillerId || k.lag2_s2 === spillerId
  );
  const totalKamper = egneKamper.filter(k => k.ferdig).length;

  const harFørsteSeier = egneKamper.some(k => {
    const erLag1 = k.lag1_s1 === spillerId || k.lag1_s2 === spillerId;
    return erLag1 ? k.lag1Poeng > k.lag2Poeng : k.lag2Poeng > k.lag1Poeng;
  });

  const toppHist   = historikk.length ? Math.max(...historikk.map(h => h.ratingEtter ?? STARTRATING)) : STARTRATING;
  const toppRating = Math.max(toppHist, STARTRATING);

  // Opprykksmerker — basert på toppRating historisk
  const harVærtEtablert = toppRating >= NIVA.ETABLERT.min;
  const harVærtElite    = toppRating >= NIVA.ELITE.min;

  return { totalKamper, harFørsteSeier, toppRating, harVærtEtablert, harVærtElite };
}

function _merkePill(oppnådd, kortNavn, tittel) {
  return `<div title="${escHtml(tittel)}" style="
    display:flex;align-items:center;gap:5px;
    padding:6px 12px;border-radius:20px;font-size:13px;font-weight:600;
    background:${oppnådd ? 'rgba(234,179,8,0.15)' : 'rgba(255,255,255,0.03)'};
    border:1px solid ${oppnådd ? 'var(--yellow)' : 'var(--border)'};
    color:${oppnådd ? 'var(--yellow)' : 'var(--muted)'}">
    ${oppnådd ? '🏅' : '🔒'} ${escHtml(kortNavn)}
  </div>`;
}

/**
 * Større kort-variant for milepæler — viser ikon, tittel og forklaringstekst.
 * Låste merker viser hva som kreves; oppnådde merker viser hva du oppnådde.
 */
function _milepælKort(oppnådd, ikon, tittel, forklaring) {
  const bg     = oppnådd ? 'rgba(234,179,8,0.08)'   : 'rgba(255,255,255,0.02)';
  const border = oppnådd ? '1px solid rgba(234,179,8,0.4)' : '1px solid var(--border)';
  const farge  = oppnådd ? 'var(--yellow)'  : 'var(--muted)';
  const sub    = oppnådd ? 'var(--muted2)'  : 'var(--muted)';

  return `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;background:${bg};border:${border}">
      <div style="font-size:24px;flex-shrink:0;opacity:${oppnådd ? '1' : '0.35'}">${oppnådd ? ikon : '🔒'}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600;color:${farge}">${escHtml(tittel)}</div>
        <div style="font-size:12px;color:${sub};margin-top:2px;line-height:1.4">${escHtml(forklaring)}</div>
      </div>
      ${oppnådd ? `<div style="font-size:18px">✓</div>` : ''}
    </div>`;
}

function _fremgangsbar(nåværende, milepæler) {
  const neste = milepæler.find(m => m > nåværende);
  if (!neste) return `<div style="font-size:12px;color:var(--green2)">✓ Alle kamp-merker oppnådd!</div>`;

  const forrige = [...milepæler].reverse().find(m => m <= nåværende) ?? 0;
  const pst     = Math.min(100, Math.round(((nåværende - forrige) / (neste - forrige)) * 100));

  return `
    <div style="font-size:12px;color:var(--muted2);margin-bottom:4px">${nåværende} / ${neste} kamper mot neste merke</div>
    <div style="height:6px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden">
      <div style="height:100%;width:${pst}%;background:var(--yellow);border-radius:3px;transition:width .4s"></div>
    </div>`;
}

// ════════════════════════════════════════════════════════
// 7. GOAT-KÅRING
// ════════════════════════════════════════════════════════

/**
 * Henter GOAT-konfig fra klubb-dokumentet.
 * Returnerer defaults (kalenderhalvår) hvis ikke konfigurert.
 */
/**
 * Henter gjeldende GOAT-periode (fra/til) for en klubb.
 * Eksportert slik at ledertavle.js kan filtrere sesongkåringen
 * på samme periode som GOAT bruker — ett konsistent sesongbegrep.
 * @returns {{ fra: Date, til: Date, periodeLabel: string }}
 */
export async function hentGoatPeriode(klubbId) {
  const konfig = await _hentGoatKonfig(klubbId);
  const fra    = konfig.periodeStart;
  const til    = konfig.kåringsDato;
  const fraStr = fra.toLocaleDateString('no-NO', { day: 'numeric', month: 'short' });
  const tilStr = til.toLocaleDateString('no-NO', { day: 'numeric', month: 'short', year: 'numeric' });
  return { fra, til, periodeLabel: `${fraStr} – ${tilStr}` };
}

async function _hentGoatKonfig(klubbId) {
  try {
    const snap = await getDoc(doc(db, 'klubber', klubbId));
    const konfig = snap.data()?.goatKonfig ?? {};
    const nå = new Date();
    const erFørste = nå.getMonth() < 6;
    const år = nå.getFullYear();
    return {
      periodeStart:      konfig.periodeStart?.toDate?.() ?? (erFørste ? new Date(år, 0, 1) : new Date(år, 6, 1)),
      kåringsDato:       konfig.kåringsDato?.toDate?.()  ?? (erFørste ? new Date(år, 5, 30, 23, 59) : new Date(år, 11, 31, 23, 59)),
      nestePeriodeStart: konfig.nestePeriodeStart?.toDate?.() ?? null,
    };
  } catch {
    const nå = new Date();
    const erFørste = nå.getMonth() < 6;
    const år = nå.getFullYear();
    return {
      periodeStart:      erFørste ? new Date(år, 0, 1) : new Date(år, 6, 1),
      kåringsDato:       erFørste ? new Date(år, 5, 30, 23, 59) : new Date(år, 11, 31, 23, 59),
      nestePeriodeStart: null,
    };
  }
}

/** Lagrer GOAT-konfig til klubb-dokumentet. */
async function _lagreGoatKonfig(klubbId, { periodeStart, kåringsDato, nestePeriodeStart }) {
  // setDoc med merge:true oppretter dokumentet hvis det ikke finnes ennå —
  // updateDoc ville feilet hvis 'klubber'-samlingen mangler i Firestore.
  await setDoc(doc(db, 'klubber', klubbId), {
    goatKonfig: {
      periodeStart:      periodeStart,
      kåringsDato:       kåringsDato,
      nestePeriodeStart: nestePeriodeStart ?? null,
    },
  }, { merge: true });
}

/** Formatter Date til YYYY-MM-DD for input[type=date]. */
function _tilDatoInput(d) {
  return d ? d.toISOString().slice(0, 10) : '';
}

/** Parser YYYY-MM-DD streng til Date (lokal midnatt). */
function _fraDatoInput(s) {
  if (!s) return null;
  const [år, mnd, dag] = s.split('-').map(Number);
  return new Date(år, mnd - 1, dag);
}

/**
 * Beregner GOAT-poengsummen for ett halvår.
 * @param {string} klubbId
 * @param {Date}   fra
 * @param {Date}   til
 * @param {string|null} ekskluderSpillerId — forsvarende mester
 */
export async function beregnGOAT(klubbId, fra, til, ekskluderSpillerId = null) {
  if (!db || !klubbId) return [];

  const spillere = _getSpillere();
  const [alleKamper, historikkMap] = await Promise.all([
    _hentAlleKamper(klubbId),
    _hentHistorikkForAlle(spillere),
  ]);

  const fraMs = fra.getTime();
  const tilMs = til.getTime();

  // Hent avsluttetDato fra treningsdokumentene — kamp-dokumenter mangler dato
  // på eldre kamper (serverTimestamp ble ikke satt ved poenglagring).
  const alleTreningIdsGOAT = [...new Set(alleKamper.map(k => k.treningId).filter(Boolean))];
  const treningDatoMapGOAT = {};
  if (alleTreningIdsGOAT.length) {
    const snaps = await Promise.all(alleTreningIdsGOAT.map(id => getDoc(doc(db, SAM.TRENINGER, id))));
    snaps.forEach(snap => {
      if (snap.exists()) {
        const d = snap.data();
        treningDatoMapGOAT[snap.id] = (d.avsluttetDato ?? d.opprettetDato)?.toMillis?.() ?? 0;
      }
    });
  }

  const periodeKamper = alleKamper.filter(k => {
    const d = treningDatoMapGOAT[k.treningId] ?? k.dato?.toMillis?.() ?? 0;
    return d >= fraMs && d <= tilMs;
  });

  // Bygg startrating-kart: ratingen spilleren HAD ved periodens start.
  const ratingMap = {};
  for (const s of spillere) {
    const hist = (historikkMap[s.id] ?? []).filter(h => {
      const d = h.dato?.toMillis?.() ?? 0;
      return d >= fraMs && d <= tilMs && h.type !== 'halvårsjustering';
    });
    if (hist.length) {
      const tidligst = hist.reduce((a, b) =>
        (a.dato?.toMillis?.() ?? 0) <= (b.dato?.toMillis?.() ?? 0) ? a : b);
      ratingMap[s.id] = (tidligst.ratingEtter ?? STARTRATING) - (tidligst.endring ?? 0);
    } else {
      ratingMap[s.id] = s.rating ?? STARTRATING;
    }
  }

  // Dynamiske sjiktgrenser basert på startratingene (topp 25% / midtre 50% / bunn 25%)
  const alleRatinger = Object.values(ratingMap).sort((a, b) => a - b);
  const antall       = alleRatinger.length;
  const grenseTopp   = alleRatinger[Math.floor(antall * 0.75)] ?? STARTRATING;
  const grenseBunn   = alleRatinger[Math.floor(antall * 0.25)] ?? STARTRATING;
  const _sjiktFor    = r => r >= grenseTopp ? 'topp' : r <= grenseBunn ? 'bunn' : 'midtre';

  const scorerMap = {};
  const totalTreninger = new Set(periodeKamper.map(k => k.treningId)).size;

  // Bygg oppmøte-kart fra periodeKamper — samme kilde som totalTreninger,
  // slik at oppmøte aldri kan overstige totalTreninger og gi > 20p.
  const oppmøteMap = {}; // spillerId → Set<treningId>
  for (const k of periodeKamper) {
    if (!k.treningId) continue;
    for (const id of [k.lag1_s1, k.lag1_s2, k.lag2_s1, k.lag2_s2].filter(Boolean)) {
      if (!oppmøteMap[id]) oppmøteMap[id] = new Set();
      oppmøteMap[id].add(k.treningId);
    }
  }

  // --- Komponent A: Ratingutvikling (30p) ---
  for (const s of spillere) {
    const hist = (historikkMap[s.id] ?? []).filter(h => {
      const d = h.dato?.toMillis?.() ?? 0;
      return d >= fraMs && d <= tilMs;
    });
    const delta = hist.reduce((sum, h) => sum + (h.endring ?? 0), 0);
    if (!scorerMap[s.id]) scorerMap[s.id] = {
      id: s.id, navn: s.navn, A: 0, B: 0, C: 0, D: 0, E: 0, oppmøte: 0,
      sjikt: _sjiktFor(ratingMap[s.id] ?? STARTRATING),
    };
    scorerMap[s.id].A        = delta;
    scorerMap[s.id].oppmøte  = oppmøteMap[s.id]?.size ?? 0; // antall unike treninger i perioden
  }

  // Normaliser A til 30p
  const maks_A = Math.max(1, ...Object.values(scorerMap).map(s => s.A));
  for (const s of Object.values(scorerMap)) s.A = Math.round((Math.max(0, s.A) / maks_A) * 30);

  // --- Komponent B: Overprestasjonsrate (25p) ---
  const bidragMap = {};
  for (const k of periodeKamper) {
    const rA       = ((ratingMap[k.lag1_s1] ?? STARTRATING) + (ratingMap[k.lag1_s2] ?? STARTRATING)) / (k.lag1_s2 ? 2 : 1);
    const rB       = ((ratingMap[k.lag2_s1] ?? STARTRATING) + (ratingMap[k.lag2_s2] ?? STARTRATING)) / (k.lag2_s2 ? 2 : 1);
    const forventet = eloForventet(rA, rB);
    const faktisk   = k.lag1Poeng > k.lag2Poeng ? 1 : k.lag1Poeng < k.lag2Poeng ? 0 : 0.5;

    const reg = (id, f, fv) => {
      if (!id || !ratingMap[id]) return;
      if (!bidragMap[id]) bidragMap[id] = { sum: 0, kamper: 0 };
      bidragMap[id].sum += (f - fv); bidragMap[id].kamper++;
    };
    reg(k.lag1_s1, faktisk, forventet);
    reg(k.lag1_s2, faktisk, forventet);
    reg(k.lag2_s1, 1 - faktisk, 1 - forventet);
    reg(k.lag2_s2, 1 - faktisk, 1 - forventet);
  }
  for (const s of Object.values(scorerMap)) {
    const b = bidragMap[s.id];
    s._overperf = b && b.kamper >= 3 ? b.sum / b.kamper : -99;
  }
  const maks_B = Math.max(0.001, ...Object.values(scorerMap).map(s => s._overperf));
  for (const s of Object.values(scorerMap)) s.B = Math.round((Math.max(0, s._overperf) / maks_B) * 25);

  // --- Komponent C: Oppmøte (20p) ---
  const maks_C = Math.max(1, totalTreninger);
  for (const s of Object.values(scorerMap)) {
    const pst = s.oppmøte / maks_C;
    s.C = s.oppmøte / maks_C >= 0.4 ? Math.round(pst * 20) : 0; // 0 ved < 40% oppmøte
  }

  // --- Komponent D: Makkereffekt (15p) ---
  // Måler om du løfter laget utover hva Elo-ratingen tilsier.
  // Per kamp: faktisk resultat − Elo-forventet(eget lag vs motstander).
  const makkerMap = {};
  for (const k of periodeKamper) {
    const rL1 = ((ratingMap[k.lag1_s1] ?? STARTRATING) + (ratingMap[k.lag1_s2] ?? STARTRATING)) / (k.lag1_s2 ? 2 : 1);
    const rL2 = ((ratingMap[k.lag2_s1] ?? STARTRATING) + (ratingMap[k.lag2_s2] ?? STARTRATING)) / (k.lag2_s2 ? 2 : 1);
    const fv1  = eloForventet(rL1, rL2); // forventet for lag 1
    const fv2  = 1 - fv1;               // forventet for lag 2
    const f1   = k.lag1Poeng > k.lag2Poeng ? 1 : k.lag1Poeng < k.lag2Poeng ? 0 : 0.5;
    const f2   = 1 - f1;

    const regMakker = (id, makker, faktisk, forventet) => {
      if (!id || !makker || !ratingMap[id]) return;
      if (!makkerMap[id]) makkerMap[id] = { sum: 0, kamper: 0 };
      makkerMap[id].sum    += (faktisk - forventet);
      makkerMap[id].kamper++;
    };
    regMakker(k.lag1_s1, k.lag1_s2, f1, fv1);
    regMakker(k.lag1_s2, k.lag1_s1, f1, fv1);
    regMakker(k.lag2_s1, k.lag2_s2, f2, fv2);
    regMakker(k.lag2_s2, k.lag2_s1, f2, fv2);
  }
  for (const s of Object.values(scorerMap)) {
    const m = makkerMap[s.id];
    s._makker = m && m.kamper >= 3 ? m.sum / m.kamper : 0;
  }
  const maks_D = Math.max(0.001, ...Object.values(scorerMap).map(s => s._makker));
  for (const s of Object.values(scorerMap)) s.D = Math.round((s._makker / maks_D) * 15);

  // --- Komponent E: Lengste vinnstreak (10p) ---
  const streakMap = {};
  const sorterteKamper = [...periodeKamper].sort((a, b) => (a.dato?.toMillis?.() ?? 0) - (b.dato?.toMillis?.() ?? 0));
  for (const k of sorterteKamper) {
    const legg = (id, vant) => {
      if (!id || !ratingMap[id]) return;
      if (!streakMap[id]) streakMap[id] = { nåværende: 0, maks: 0 };
      if (vant) { streakMap[id].nåværende++; streakMap[id].maks = Math.max(streakMap[id].maks, streakMap[id].nåværende); }
      else streakMap[id].nåværende = 0;
    };
    legg(k.lag1_s1, k.lag1Poeng > k.lag2Poeng);
    legg(k.lag1_s2, k.lag1Poeng > k.lag2Poeng);
    legg(k.lag2_s1, k.lag2Poeng > k.lag1Poeng);
    legg(k.lag2_s2, k.lag2Poeng > k.lag1Poeng);
  }
  const maks_E = Math.max(1, ...Object.values(streakMap).map(s => s.maks));
  for (const s of Object.values(scorerMap)) {
    s._streak = streakMap[s.id]?.maks ?? 0;
    s.E       = Math.round((s._streak / maks_E) * 10);
  }

  // --- Totalsum og sortering ---
  const resultater = Object.values(scorerMap)
    .filter(s => s.id !== ekskluderSpillerId && s.C > 0) // må ha oppmøte
    .map(s => ({
      ...s,
      total: s.A + s.B + s.C + s.D + s.E,
    }))
    .sort((a, b) => b.total - a.total);

  return resultater;
}

/**
 * Beregner alle tre halvårskåringer i én operasjon.
 * Returnerer { goat, jokeren, kriger, scoreboard } der
 * goat    = beste totalscore i toppsjiktet (25%)
 * jokeren = beste totalscore i midtsjiktet (50%)
 * kriger  = beste totalscore i bunnsjiktet (25%)
 *
 * @param {string} klubbId
 * @param {Date}   fra
 * @param {Date}   til
 * @returns {Promise<{ goat, jokeren, kriger, scoreboard }>}
 */
export async function beregnKåringer(klubbId, fra, til) {
  const alle = await beregnGOAT(klubbId, fra, til);

  // Sjekk minimum antall treninger
  // Bruker avsluttetDato fra treningsdokumentet — kamp-dokumenter har ikke
  // dato satt (serverTimestamp ble ikke skrevet ved poenglagring i eldre kamper).
  const alleKamper = await _hentAlleKamper(klubbId);
  const fraMs = fra.getTime(), tilMs = til.getTime();

  // Hent avsluttetDato for alle unike trenings-IDer i kamp-listen
  const alleTreningIds = [...new Set(alleKamper.map(k => k.treningId).filter(Boolean))];
  const treningDatoMap = {};
  if (alleTreningIds.length) {
    const snaps = await Promise.all(alleTreningIds.map(id => getDoc(doc(db, SAM.TRENINGER, id))));
    snaps.forEach(snap => {
      if (snap.exists()) {
        const d = snap.data();
        treningDatoMap[snap.id] = (d.avsluttetDato ?? d.opprettetDato)?.toMillis?.() ?? 0;
      }
    });
  }

  // Filtrer kamper basert på treningens dato, ikke kamp-dokumentets dato
  const periodeKamper = alleKamper.filter(k => {
    const d = treningDatoMap[k.treningId] ?? k.dato?.toMillis?.() ?? 0;
    return d >= fraMs && d <= tilMs;
  });
  const totalTreninger = new Set(periodeKamper.map(k => k.treningId).filter(Boolean)).size;

  if (totalTreninger < MIN_TRENINGER_GOAT) {
    return { goat: null, jokeren: null, kriger: null, scoreboard: [], forFåTreninger: true, totalTreninger };
  }

  const topp   = alle.filter(s => s.sjikt === 'topp');
  const midtre = alle.filter(s => s.sjikt === 'midtre');
  const bunn   = alle.filter(s => s.sjikt === 'bunn');

  return {
    goat:       topp[0]   ?? null,
    jokeren:    midtre[0] ?? null,
    kriger:     bunn[0]   ?? null,
    scoreboard: alle,
    forFåTreninger: false,
    totalTreninger,
  };
}

/** Rendrer GOAT-arkiv-seksjonen (tidligere vinnere). */
async function _renderLiveStilling(klubbId) {
  const el = document.getElementById('hof-live-stilling');
  if (!el) return;

  try {
    const konfig = await _hentGoatKonfig(klubbId);
    const nå     = new Date();

    // Vis ingenting hvis perioden ikke har startet ennå
    if (nå < konfig.periodeStart) {
      el.innerHTML = '';
      return;
    }

    // Bruk nå som til-dato for live-bilde, men ikke etter kåringsdatoen
    const til = nå < konfig.kåringsDato ? nå : konfig.kåringsDato;
    const { goat, jokeren, kriger, scoreboard, forFåTreninger, totalTreninger } = await beregnKåringer(klubbId, konfig.periodeStart, til);

    const fmtDato = d => d.toLocaleDateString('no-NO', { day: 'numeric', month: 'short' });
    const kåringsDatoStr = fmtDato(konfig.kåringsDato);

    const lederKort = (ikon, tittel, farge, vinner) => {
      if (!vinner) return `
        <div style="flex:1;min-width:120px;background:rgba(255,255,255,.04);border-radius:10px;padding:10px 12px">
          <div style="font-size:11px;color:var(--muted2);margin-bottom:4px">${ikon} ${tittel}</div>
          <div style="font-size:12px;color:var(--muted2)">Ikke nok data</div>
        </div>`;
      return `
        <div style="flex:1;min-width:120px;background:rgba(255,255,255,.04);border-radius:10px;padding:10px 12px">
          <div style="font-size:11px;color:var(--muted2);margin-bottom:6px">${ikon} ${tittel}</div>
          <div style="font-size:13px;font-weight:600;color:${farge};margin-bottom:2px">${escHtml(vinner.navn)}</div>
          <div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:700;color:${farge}">${vinner.total}p</div>
          <div style="font-size:10px;color:var(--muted2);margin-top:3px">A${vinner.A} B${vinner.B} C${vinner.C} D${vinner.D} E${vinner.E}</div>
        </div>`;
    };

    const toppHTML = forFåTreninger
      ? `<div style="font-size:13px;color:var(--muted2);text-align:center;padding:8px 0">
           ${totalTreninger} av ${MIN_TRENINGER_GOAT} treninger gjennomført — stilling tilgjengelig fra trening ${MIN_TRENINGER_GOAT}
         </div>`
      : `<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
           ${lederKort('🐐', 'GOAT', 'var(--yellow)', goat)}
           ${lederKort('🎭', 'Jokeren', '#a78bfa', jokeren)}
           ${lederKort('⚔️', 'Krigeren', '#fb923c', kriger)}
         </div>
         <div style="font-size:11px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Alle spillere</div>
         <div>
           ${scoreboard.slice(0, 8).map((s, i) => `
             <div style="display:flex;align-items:center;gap:8px;padding:6px 0;${i < Math.min(scoreboard.length, 8) - 1 ? 'border-bottom:1px solid rgba(255,255,255,.06)' : ''}">
               <div style="font-size:13px;color:var(--muted2);width:16px;text-align:right">${i + 1}</div>
               <div style="font-size:14px">${s.sjikt === 'topp' ? '🐐' : s.sjikt === 'midtre' ? '🎭' : '⚔️'}</div>
               <div style="flex:1;font-size:13px;font-weight:600">${escHtml(s.navn)}</div>
               <div style="font-family:'DM Mono',monospace;font-size:14px;font-weight:700;color:${i === 0 ? 'var(--yellow)' : 'var(--white)'}">${s.total}</div>
             </div>`).join('')}
         </div>`;

    el.innerHTML = `
      <div class="seksjon-etikett">📊 Live-stilling</div>
      <div class="kort" style="margin-bottom:14px">
        <div class="kort-innhold">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div style="font-size:13px;color:var(--muted2)">Foreløpig — oppdateres løpende</div>
            <div style="font-size:12px;color:var(--muted2)">Kåres ${kåringsDatoStr}</div>
          </div>
          ${toppHTML}
        </div>
      </div>`;

  } catch (e) {
    console.error('[HoF live]', e);
    const el2 = document.getElementById('hof-live-stilling');
    if (el2) el2.innerHTML = '';
  }
}

function _renderGOATArkiv(klubbId) {
  // Arkivet lagres i en dedikert Firestore-samling eller som felt på klubb-dokumentet.
  // Versjon 1: vises kun dersom admin har lagret tidligere resultater.
  // Dette er et placeholder som utvides i versjon 2.
  return `
    <div class="seksjon-etikett">🐐 GOAT-kåringen</div>
    <div class="kort" style="margin-bottom:14px">
      <div class="kort-innhold" style="text-align:center;padding:20px 16px">
        <div style="font-size:36px;margin-bottom:8px">🐐</div>
        <div onclick="hofVisGOATInfo()" style="font-family:'Bebas Neue',cursive;font-size:22px;letter-spacing:1px;color:var(--yellow);cursor:pointer;display:inline-flex;align-items:center;gap:8px">
          Halvårlig GOAT-kåring
          <span style="font-size:16px;font-family:sans-serif;opacity:0.7">ℹ️</span>
        </div>
        <div style="font-size:14px;color:var(--muted2);margin-top:6px;line-height:1.5">Kåres to ganger i året.<br>Vinnerne arkiveres her permanent.</div>
        ${window.getErAdmin?.() ? `
          <button class="knapp knapp-primaer" onclick="hofVisGOATBeregner()" style="margin-top:14px;font-family:'Bebas Neue',cursive;font-size:18px;letter-spacing:1px">🏆 BEREGN GOAT-VINNER</button>
          <button class="knapp" onclick="hofVisGOATKonfig()" style="margin-top:8px;font-size:14px;color:var(--muted2)">⚙️ Konfigurer periode</button>
        ` : ''}
      </div>
    </div>`;
}

/** Vises når admin trykker «Beregn GOAT-vinner» — modal med halvår-velger og scorekort. */
window.hofVisGOATBeregner = async function() {
  const modal = document.getElementById('hof-goat-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  const innhold = document.getElementById('hof-goat-innhold');
  if (innhold) innhold.innerHTML = _lasterHTML('Beregner GOAT-poeng…');

  try {
    const klubbId  = _getAktivKlubbId();
    const konfig   = await _hentGoatKonfig(klubbId);
    const fra      = konfig.periodeStart;
    const til      = konfig.kåringsDato;
    const fmtDato  = d => d.toLocaleDateString('no-NO', { day: 'numeric', month: 'short', year: 'numeric' });
    const periode  = `${fmtDato(fra)} – ${fmtDato(til)}`;

    const { goat, jokeren, kriger, scoreboard, forFåTreninger, totalTreninger } = await beregnKåringer(klubbId, fra, til);

    if (forFåTreninger) {
      if (innhold) innhold.innerHTML = _tomTilstand(`Kun ${totalTreninger} av ${MIN_TRENINGER_GOAT} nødvendige treninger er gjennomført. Kom tilbake senere!`);
      return;
    }
    if (!scoreboard.length) {
      if (innhold) innhold.innerHTML = _tomTilstand('Ikke nok data for inneværende periode');
      return;
    }

    // Hjelpefunksjon: rendrer én kåringsblokk
    const kåringsBlokk = (ikon, tittel, sitat, vinner, farge) => {
      if (!vinner) return `
        <div style="padding:14px 0;border-bottom:1px solid var(--border)">
          <div style="font-size:12px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">${ikon} ${tittel}</div>
          <div style="font-size:13px;color:var(--muted2)">Ikke nok data i dette sjiktet</div>
        </div>`;
      return `
        <div style="padding:14px 0;border-bottom:1px solid var(--border)">
          <div style="font-size:12px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">${ikon} ${tittel}</div>
          <div style="font-size:12px;color:var(--muted2);font-style:italic;margin-bottom:8px;line-height:1.4">${sitat}</div>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="lb-avatar" style="width:36px;height:36px;font-size:14px">${lagInitialer(vinner.navn)}</div>
            <div style="flex:1">
              <div style="font-size:15px;font-weight:700;color:${farge}">${escHtml(vinner.navn)}</div>
              <div style="font-size:11px;color:var(--muted2);margin-top:2px">Rating +${vinner.A}p · Form +${vinner.B}p · Oppmøte +${vinner.C}p · Makker +${vinner.D}p · Streak +${vinner.E}p</div>
            </div>
            <div style="font-family:'DM Mono',monospace;font-size:20px;font-weight:700;color:${farge}">${vinner.total}</div>
          </div>
        </div>`;
    };

    // Topp 5 scoreboard (hele feltet)
    const topp5 = scoreboard.slice(0, 5);
    const scoreboardHTML = `
      <div style="margin-top:16px">
        <div style="font-size:12px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Topp 5 — åpent scorekort</div>
        ${topp5.map((s, i) => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 0;${i < topp5.length - 1 ? 'border-bottom:1px solid var(--border)' : ''}">
            <div style="font-family:'Bebas Neue',cursive;font-size:20px;color:var(--muted);width:20px">${i + 1}</div>
            <div class="lb-avatar" style="width:32px;height:32px;font-size:13px">${lagInitialer(s.navn)}</div>
            <div style="flex:1">
              <div style="font-size:14px;font-weight:600">${escHtml(s.navn)}</div>
              <div style="font-size:11px;color:var(--muted2);margin-top:2px">${s.sjikt === 'topp' ? '🐐' : s.sjikt === 'midtre' ? '🎭' : '⚔️'} Rating +${s.A}p · Form +${s.B}p · Oppmøte +${s.C}p · Makker +${s.D}p · Streak +${s.E}p</div>
            </div>
            <div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:700;color:${i === 0 ? 'var(--yellow)' : 'var(--white)'}">${s.total}</div>
          </div>`).join('')}
      </div>`;

    if (innhold) innhold.innerHTML = `
      <div style="text-align:center;margin-bottom:16px">
        <div style="font-size:13px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">${escHtml(periode)}</div>
        <div style="font-family:'Bebas Neue',cursive;font-size:24px;letter-spacing:1px;color:var(--yellow)">Halvårskåringen</div>
      </div>
      ${kåringsBlokk('🐐', 'GOAT', '«Beiter på motstanderne og topper statistikken.»', goat, 'var(--yellow)')}
      ${kåringsBlokk('🎭', 'Jokeren', '«Spilleren du aldri helt kan regne med – bortsett fra at han stadig overrasker.»', jokeren, '#a78bfa')}
      ${kåringsBlokk('⚔️', 'Krigeren', '«Spilleren som møter opp, kjemper hver ball og nekter å la ratingen definere seg.»', kriger, '#fb923c')}
      ${scoreboardHTML}`;

  } catch (e) {
    console.error('[HoF GOAT]', e);
    if (innhold) innhold.innerHTML = _tomTilstand('Feil ved GOAT-beregning');
  }
};

window.hofLukkGOATModal = function() {
  const modal = document.getElementById('hof-goat-modal');
  if (modal) modal.style.display = 'none';
};

/** Admin: viser skjema for å sette periodestart, kåringsdato og neste periodestart. */
window.hofVisGOATKonfig = async function() {
  const modal = document.getElementById('hof-goat-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  const innhold = document.getElementById('hof-goat-innhold');
  if (innhold) innhold.innerHTML = _lasterHTML('Henter konfigurasjon…');

  const klubbId = _getAktivKlubbId();
  const konfig  = await _hentGoatKonfig(klubbId);

  if (!innhold) return;
  innhold.innerHTML = `
    <div style="margin-bottom:16px">
      <div style="font-size:13px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Admin</div>
      <div style="font-family:'Bebas Neue',cursive;font-size:22px;letter-spacing:1px;color:var(--yellow)">Kåringskonfigurasjon</div>
    </div>

    <div style="display:flex;flex-direction:column;gap:14px;margin-bottom:20px">
      <div>
        <div style="font-size:12px;color:var(--muted2);margin-bottom:6px">Periodens startdato</div>
        <input type="date" id="goat-fra" value="${_tilDatoInput(konfig.periodeStart)}"
          style="width:100%;padding:8px 10px;background:rgba(255,255,255,.07);border:1px solid var(--border);border-radius:8px;color:var(--white);font-size:14px">
        <div style="font-size:11px;color:var(--muted2);margin-top:4px">Kamper og treninger fra denne datoen teller med.</div>
      </div>
      <div>
        <div style="font-size:12px;color:var(--muted2);margin-bottom:6px">Kåringsdato (periodens slutt)</div>
        <input type="date" id="goat-til" value="${_tilDatoInput(konfig.kåringsDato)}"
          style="width:100%;padding:8px 10px;background:rgba(255,255,255,.07);border:1px solid var(--border);border-radius:8px;color:var(--white);font-size:14px">
        <div style="font-size:11px;color:var(--muted2);margin-top:4px">Datoen kåringen gjennomføres og vinneren kåres.</div>
      </div>
      <div>
        <div style="font-size:12px;color:var(--muted2);margin-bottom:6px">Neste periodes startdato</div>
        <input type="date" id="goat-neste" value="${_tilDatoInput(konfig.nestePeriodeStart ?? null)}"
          style="width:100%;padding:8px 10px;background:rgba(255,255,255,.07);border:1px solid var(--border);border-radius:8px;color:var(--white);font-size:14px">
        <div style="font-size:11px;color:var(--muted2);margin-top:4px">Valgfritt. Ny periode starter automatisk denne datoen.</div>
      </div>
    </div>

    <div id="goat-konfig-feil" style="display:none;font-size:13px;color:#f87171;margin-bottom:12px"></div>

    <button onclick="hofLagreGOATKonfig()"
      style="width:100%;padding:12px;background:var(--yellow);color:#000;border:none;border-radius:10px;font-family:'Bebas Neue',cursive;font-size:18px;letter-spacing:1px;cursor:pointer">
      💾 Lagre konfigurasjon
    </button>`;
};

window.hofLagreGOATKonfig = async function() {
  const fra   = _fraDatoInput(document.getElementById('goat-fra')?.value);
  const til   = _fraDatoInput(document.getElementById('goat-til')?.value);
  const neste = _fraDatoInput(document.getElementById('goat-neste')?.value);
  const feilEl = document.getElementById('goat-konfig-feil');

  if (!fra || !til) {
    if (feilEl) { feilEl.textContent = 'Startdato og kåringsdato er påkrevd.'; feilEl.style.display = 'block'; }
    return;
  }
  if (til <= fra) {
    if (feilEl) { feilEl.textContent = 'Kåringsdato må være etter startdato.'; feilEl.style.display = 'block'; }
    return;
  }
  if (neste && neste <= til) {
    if (feilEl) { feilEl.textContent = 'Neste periodestart må være etter kåringsdato.'; feilEl.style.display = 'block'; }
    return;
  }
  if (feilEl) feilEl.style.display = 'none';

  try {
    const klubbId = _getAktivKlubbId();
    // Sett kåringsdato til slutten av dagen
    til.setHours(23, 59, 59);
    await _lagreGoatKonfig(klubbId, { periodeStart: fra, kåringsDato: til, nestePeriodeStart: neste });
    window.hofLukkGOATModal();
  } catch (e) {
    console.error('[HoF konfig]', e);
    if (feilEl) { feilEl.textContent = 'Kunne ikke lagre. Prøv igjen.'; feilEl.style.display = 'block'; }
  }
};

/** Viser info-modal med neste kåringsdato og komponentforklaring. */
window.hofVisGOATInfo = async function() {
  const modal   = document.getElementById('hof-goat-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  const innhold = document.getElementById('hof-goat-innhold');
  if (!innhold) return;

  const klubbId   = _getAktivKlubbId();
  const konfig    = await _hentGoatKonfig(klubbId);
  const fmtDato   = d => d ? d.toLocaleDateString('no-NO', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  const nesteKåring = fmtDato(konfig.kåringsDato);
  const periode     = `${fmtDato(konfig.periodeStart)} – ${fmtDato(konfig.kåringsDato)}`;

  const titler = [
    ['🐐', 'GOAT',    'var(--yellow)', '«Beiter på motstanderne og topper statistikken.»',                                        'Spillere i øverste 25% av ratingen ved periodens start. Beste totalpoeng vinner.'],
    ['🎭', 'Jokeren', '#a78bfa',       '«Spilleren du aldri helt kan regne med – bortsett fra at han stadig overrasker.»',         'Spillere i midtre 50% av ratingen ved periodens start. Beste totalpoeng vinner.'],
    ['⚔️', 'Krigeren','#fb923c',       '«Spilleren som møter opp, kjemper hver ball og nekter å la ratingen definere seg.»',       'Spillere i nedre 25% av ratingen ved periodens start. Beste totalpoeng vinner.'],
  ];

  const komponenter = [
    ['A', '30p', '📈 Ratingutvikling',     'Hvor mye ratingen din har økt i perioden'],
    ['B', '25p', '🎯 Overprestasjonsrate', 'Vinner du mer enn Elo-ratingen din tilsier?'],
    ['C', '20p', '📅 Oppmøte',             'Andel treninger deltatt (min. 40% kreves)'],
    ['D', '15p', '🤝 Makkereffekt',        'Løfter laget ditt over Elo-forventningen?'],
    ['E', '10p', '🔥 Lengste vinnstreak',  'Beste sammenhengende vinnrekke i perioden'],
  ];

  innhold.innerHTML = `
    <div style="text-align:center;margin-bottom:20px">
      <div style="font-size:13px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Halvårskåringen</div>
      <div style="font-family:'Bebas Neue',cursive;font-size:24px;letter-spacing:1px;color:var(--yellow)">🐐 Jokeren ⚔️</div>
    </div>

    <div style="background:rgba(255,255,255,.05);border-radius:10px;padding:12px 14px;margin-bottom:16px">
      <div style="font-size:12px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Neste kåring</div>
      <div style="font-size:16px;font-weight:700;color:var(--white)">📅 ${nesteKåring}</div>
      <div style="font-size:13px;color:var(--muted2);margin-top:4px">Inneværende periode: ${periode}</div>
    </div>

    <div style="font-size:12px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Tre titler — én vinner per sjikt</div>
    ${titler.map(([ikon, tittel, farge, sitat, forklaring], i, arr) => `
      <div style="padding:10px 0;${i < arr.length - 1 ? 'border-bottom:1px solid var(--border)' : ''}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-size:18px">${ikon}</span>
          <div style="font-family:'Bebas Neue',cursive;font-size:18px;letter-spacing:1px;color:${farge}">${tittel}</div>
        </div>
        <div style="font-size:12px;color:var(--muted2);font-style:italic;margin-bottom:4px;line-height:1.4">${sitat}</div>
        <div style="font-size:12px;color:var(--muted2);line-height:1.4">${forklaring}</div>
      </div>`).join('')}

    <div style="font-size:12px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin:16px 0 8px">Slik beregnes poengsummen</div>
    ${komponenter.map(([bokstav, maks, tittel, beskr], i, arr) => `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;${i < arr.length - 1 ? 'border-bottom:1px solid var(--border)' : ''}">
        <div style="font-family:'Bebas Neue',cursive;font-size:18px;color:var(--yellow);width:16px;flex-shrink:0">${bokstav}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600">${tittel}</div>
          <div style="font-size:12px;color:var(--muted2);margin-top:2px;line-height:1.4">${escHtml(beskr)}</div>
        </div>
        <div style="font-family:'DM Mono',monospace;font-size:14px;font-weight:700;color:var(--white);flex-shrink:0">${maks}</div>
      </div>`).join('')}

  `;
};

// ════════════════════════════════════════════════════════
// GJENBRUKBARE UI-BYGGEBLOKKER
// ════════════════════════════════════════════════════════

/** Dedikert renderer for Drømmemakkerlaget — har to spillere, ikke én. */
function _renderDrømmemakkerRad(par) {
  if (!par) return `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border)">
      <span style="font-size:18px">🤝</span>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:600">Drømmemakkerlaget</div>
        <div style="font-size:12px;color:var(--muted2)">Ikke nok data ennå (min. ${MIN_KAMPER_MAKKER} kamper sammen)</div>
      </div>
    </div>`;

  const navn1 = par.navn1 ?? '?';
  const navn2 = par.navn2 ?? '?';
  const ini1  = lagInitialer(navn1);
  const ini2  = lagInitialer(navn2);

  return `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border)">
      <span style="font-size:18px">🤝</span>
      <div style="display:flex;gap:4px;flex-shrink:0">
        <div class="lb-avatar" style="width:32px;height:32px;font-size:13px;cursor:pointer"
             onclick="apneGlobalProfil('${par.id1}')">${ini1}</div>
        <div class="lb-avatar" style="width:32px;height:32px;font-size:13px;cursor:pointer"
             onclick="apneGlobalProfil('${par.id2}')">${ini2}</div>
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600">Drømmemakkerlaget</div>
        <div style="font-size:12px;color:var(--muted2);margin-top:1px">${escHtml(navn1)} + ${escHtml(navn2)}</div>
        <div style="font-size:13px;font-weight:600;color:var(--yellow);margin-top:2px">${par.winRate}% winrate · ${par.kamper} kamper</div>
      </div>
    </div>`;
}

function _titelRad(ikon, tittel, vinner, beskrivelse) {
  if (!vinner) return `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border)">
      <span style="font-size:18px">${ikon}</span>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:600">${tittel}</div>
        <div style="font-size:12px;color:var(--muted2)">Ikke nok data ennå</div>
      </div>
    </div>`;

  return `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);cursor:pointer"
         onclick="apneGlobalProfil('${vinner.id}')">
      <span style="font-size:18px">${ikon}</span>
      <div class="lb-avatar" style="width:32px;height:32px;font-size:13px">${lagInitialer(vinner.navn)}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600">${tittel}</div>
        <div style="font-size:12px;color:var(--muted2);margin-top:1px">${escHtml(vinner.navn)}</div>
        <div style="font-size:13px;font-weight:600;color:var(--yellow);margin-top:2px">${beskrivelse(vinner)}</div>
      </div>
    </div>`;
}

function _lasterHTML(tekst) {
  return `<div class="laster" style="padding:20px;justify-content:center"><div class="laster-snurr"></div>${escHtml(tekst)}</div>`;
}

function _tomTilstand(tekst) {
  return `<div style="padding:20px;text-align:center;color:var(--muted2);font-size:15px">${escHtml(tekst)}</div>`;
}
