// ════════════════════════════════════════════════════════
// spillere.js — CRUD spillere, søk, toggle, siste deltakere
// ════════════════════════════════════════════════════════
import {
  db, SAM, STARTRATING,
  collection, doc, addDoc, getDocs,
  query, where, orderBy, limit, serverTimestamp, writeBatch,
} from './firebase.js';
import { lagBatchHjelper } from './batch-helpers.js';
import { app, erMix } from './state.js';
import { getNivaaKlasse, getNivaaRatingHTML } from './rating.js';
import { visMelding, visFBFeil, escHtml } from './ui.js';

// aktivKlubbId injiseres fra app.js via setAktivKlubbId()
let _aktivKlubbId = null;
export function setAktivKlubbId(id) { _aktivKlubbId = id; }

// krevAdminMedDemo injiseres fra app.js via setKrevAdmin()
let _krevAdmin = null;
export function setKrevAdmin(fn) { _krevAdmin = fn; }

function lagSpillerHTML(s, erAktiv, erVente) {
  const navn   = s.navn ?? 'Ukjent';
  const ini    = navn.split(' ').map(w => w[0] ?? '').join('').slice(0,2).toUpperCase() || '?';
  const rating = typeof s.rating === 'number' ? s.rating : STARTRATING;
  let kl    = 'spiller-element';
  let merke = '';
  if (erAktiv) { kl += ' valgt'; }
  if (erVente) { kl += ' ventende'; merke = '<span class="vl-merke">VL</span>'; }
  const hake = (erAktiv || erVente)
    ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
    : '';

  // Mix: ingen nivåfarger i spillerlisten
  if (!erAktiv && !erVente && !erMix()) kl += ' ' + getNivaaKlasse(rating);

  // Mix: skjul rating-linje under spillernavn
  const ratingLinje = erMix()
    ? ''
    : `<div class="spiller-rating-linje">⭐ ${getNivaaRatingHTML(rating)}</div>`;

  return `<div class="${escHtml(kl)}" data-id="${escHtml(s.id)}" onclick="veksleSpiller('${escHtml(s.id)}')">
    <div class="spiller-avatar">${escHtml(ini)}</div>
    <div class="lb-navn" style="font-size:18px;font-weight:500">
      <div>${escHtml(navn)}</div>
      ${ratingLinje}
    </div>
    ${merke}
    <div class="spiller-hake">${hake}</div>
  </div>`;
}

// Beregn aktiv/ventende-status basert på valgte spillere
function _beregnSpillerStatus() {
  const er6Format = app.antallBaner === 2 && app.valgtIds.size === 6;
  const min = er6Format ? 6 : app.antallBaner * 4;
  const sorterteValgte = [...app.valgtIds]
    .map(id => (app.spillere ?? []).find(s => s.id === id))
    .filter(Boolean)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  return {
    min, er6Format,
    aktiveIds:   new Set(sorterteValgte.slice(0, min).map(s => s.id)),
    ventendeIds: new Set(sorterteValgte.slice(min).map(s => s.id)),
  };
}

// Oppdater tellere og start-knapp uten å røre listen
function _oppdaterSpillerTellere(min, er6Format) {
  const n = app.valgtIds.size;
  document.getElementById('valgt-antall').textContent  = n;
  document.getElementById('aktive-antall').textContent = Math.min(n, min);
  document.getElementById('vl-antall').textContent     = Math.max(0, n - min);
  document.getElementById('start-knapp').disabled      = n < (er6Format ? 6 : min);
  const spillerInfoEl = document.getElementById('spiller-info');
  if (spillerInfoEl) {
    spillerInfoEl.innerHTML = er6Format
      ? `Nøyaktig <span id="min-antall" class="spiller-info-antall">6</span> spillere <span class="spiller-info-muted">— 4 dobbel + 2 singel format aktivert</span>`
      : `Minst <span id="min-antall" class="spiller-info-antall">${min}</span> spillere <span class="spiller-info-muted">— ekstra settes på venteliste</span>`;
  }
}

// Full rebuild — brukes kun ved søk og første lasting

// ════════════════════════════════════════════════════════
// SISTE DELTAKERE — viser de 20 siste unike spillerne
// som har deltatt på trening, sortert alfabetisk
// ════════════════════════════════════════════════════════
let _sisteDeltakereApen = false;
let _sisteDeltakereCache = null; // { ids: Set, hentetMs }

export function getSisteDeltakereApen()    { return _sisteDeltakereApen; }
export function setSisteDeltakereCache(v)  { _sisteDeltakereCache = v; }
const SISTE_DELTAKERE_TTL_MS = 5 * 60 * 1000; // 5 min cache

export async function toggleSisteDeltakere() {
  _sisteDeltakereApen = !_sisteDeltakereApen;

  const panel = document.getElementById('siste-deltakere-panel');
  const pil   = document.getElementById('siste-deltakere-pil');
  if (panel) panel.style.display = _sisteDeltakereApen ? 'block' : 'none';
  if (pil)   pil.style.transform = _sisteDeltakereApen ? 'rotate(180deg)' : '';

  if (_sisteDeltakereApen) {
    // Behold alltid valgte spillere i cachen uavhengig av Firestore-henting
    if (_sisteDeltakereCache && app.valgtIds.size > 0) {
      const merged = [...new Set([...app.valgtIds, ..._sisteDeltakereCache.spillerIds])];
      _sisteDeltakereCache.spillerIds = merged;
    }
    await lastSisteDeltakere();
  }
}
window.toggleSisteDeltakere = toggleSisteDeltakere;

export async function lastSisteDeltakere() {
  if (!db || !_aktivKlubbId) return;

  // ── Regel: valgte spillere forsvinner ALDRI ──────────────────
  // Bygg alltid listen fra valgtIds + tidligere cache FØR Firestore-kall
  const tidligereCacheIds = _sisteDeltakereCache?.spillerIds ?? [];
  const sikkerListe = [...new Set([...app.valgtIds, ...tidligereCacheIds])];

  // Oppdater cache og vis umiddelbart
  _sisteDeltakereCache = {
    spillerIds: sikkerListe,
    hentetMs:   _sisteDeltakereCache?.hentetMs ?? 0,
  };
  visSisteDeltakere(sikkerListe);

  // ── Hopp over Firestore om cachen er fersk nok ───────────────
  const naa = Date.now();
  if ((naa - (_sisteDeltakereCache.hentetMs ?? 0)) < SISTE_DELTAKERE_TTL_MS) return;

  // ── Hent fra Firestore i bakgrunnen ─────────────────────────
  try {
    const treningSnap = await getDocs(
      query(
        collection(db, SAM.TRENINGER),
        where('klubbId', '==', _aktivKlubbId),
        where('status', '==', 'avsluttet'),
        orderBy('avsluttetDato', 'desc'),
        limit(10)
      )
    );

    const sett  = new Set([...app.valgtIds]);
    const unike = [...app.valgtIds];

    // Legg til fra Firestore-treninger
    if (!treningSnap.empty) {
      const treningIds = treningSnap.docs.map(d => d.id);
      const chunks = [];
      for (let i = 0; i < treningIds.length; i += 10) chunks.push(treningIds.slice(i, i + 10));

      for (const chunk of chunks) {
        if (chunk.length === 0) continue;
        const snap = await getDocs(query(collection(db, SAM.TS), where('treningId', 'in', chunk)));
        snap.docs.forEach(d => {
          const id = d.data().spillerId;
          if (id && !sett.has(id) && unike.length < 20) { sett.add(id); unike.push(id); }
        });
      }
    }

    // Legg til fra aktiv økt
    if (app.treningId) {
      try {
        const snap = await getDocs(query(collection(db, SAM.TS), where('treningId', '==', app.treningId)));
        snap.docs.forEach(d => {
          const id = d.data().spillerId;
          if (id && !sett.has(id)) { sett.add(id); unike.push(id); }
        });
      } catch (_) {}
    }

    // Legg til ALLE spillere fra ratinglisten (app.spillere) i listen
    (app.spillere ?? []).forEach(s => {
      if (!sett.has(s.id)) { sett.add(s.id); unike.push(s.id); }
    });

    // Sorter alfabetisk (historikk-spillere som ikke er i app.spillere bakerst)
    const alleSpillereIds = (app.spillere ?? []).map(s => s.id);
    const historikkKunIds = unike.filter(id => !alleSpillereIds.includes(id));
    const ferdigListe = [...new Set([...alleSpillereIds, ...historikkKunIds])]
      .filter(id => sett.has(id) || app.valgtIds.has(id));
    _sisteDeltakereCache = { spillerIds: ferdigListe, hentetMs: Date.now() };
    visSisteDeltakere(ferdigListe);

  } catch (e) {
    console.warn('[SisteDeltakere]', e?.message ?? e);
    // Ved feil: behold det vi allerede viser — ikke overskriv
  }
}

function visSisteDeltakere(spillerIds) {
  const liste = document.getElementById('siste-deltakere-liste');
  if (!liste) return;

  const { aktiveIds: _aIds, ventendeIds: _vIds } = _beregnSpillerStatus();

  // Finn spillerobjektene fra app.spillere (allerede sortert etter rating desc)
  // Bevar ratingrekkefølgen fra app.spillere, men sett nylig lagt til spillere øverst
  const spillere = spillerIds
    .map(id => (app.spillere ?? []).find(s => s.id === id))
    .filter(Boolean)
    .sort((a, b) => {
      const aValgt = (_aIds.has(a.id) || _vIds.has(a.id)) ? 1 : 0;
      const bValgt = (_aIds.has(b.id) || _vIds.has(b.id)) ? 1 : 0;
      if (aValgt !== bValgt) return aValgt - bValgt;
      // Sorter alfabetisk
      return (a.navn ?? '').localeCompare(b.navn ?? '', 'nb');
    });

  if (spillere.length === 0) {
    liste.innerHTML = '<div class="tom-tilstand-liten" style="text-align:center">Ingen spillere funnet.</div>';
    return;
  }

  // Del i uvalgte og valgte med separator
  const uvalgte = spillere.filter(s => !_aIds.has(s.id) && !_vIds.has(s.id));
  const valgte  = spillere.filter(s =>  _aIds.has(s.id) ||  _vIds.has(s.id));

  let html = uvalgte.map(s => lagSpillerHTML(s, false, false)).join('');

  if (valgte.length > 0) {
    if (uvalgte.length > 0) {
      html += `<div class="spiller-liste-separator">Valgte</div>`;
    }
    html += valgte.map(s => lagSpillerHTML(s, _aIds.has(s.id), _vIds.has(s.id))).join('');
  }

  liste.innerHTML = html;
}

// Oppdater siste-deltakere-listen når spillerstatus endres (f.eks. ved toggle)
// Bygger alltid listen på nytt så sorteringen (uvalgte øverst) er korrekt
function oppdaterSisteDeltakereInPlace() {
  if (!_sisteDeltakereApen) return;
  const base = _sisteDeltakereCache?.spillerIds ?? [];
  const merged = [...new Set([...app.valgtIds, ...base])];
  if (merged.length === 0) return;
  visSisteDeltakere(merged);
}

// Nullstill cache når klubb byttes
export function nullstillSisteDeltakereCache() {
  _sisteDeltakereCache = null;
  _sisteDeltakereApen  = false;
  const panel = document.getElementById('siste-deltakere-panel');
  const pil   = document.getElementById('siste-deltakere-pil');
  if (panel) panel.style.display = 'none';
  if (pil)   pil.style.transform = '';
}


// Viser søkeresultater direkte i siste-deltakere-panelet
function visSokIPanel(q) {
  const liste = document.getElementById('siste-deltakere-liste');
  if (!liste) return;
  const qLow = (q ?? '').toLowerCase();
  const { aktiveIds, ventendeIds } = _beregnSpillerStatus();

  // Søketreff (uvalgte) + alle allerede valgte spillere
  const treffIds = new Set(
    (app.spillere ?? [])
      .filter(s => (s.navn ?? '').toLowerCase().includes(qLow))
      .map(s => s.id)
  );
  const visIds = new Set([...treffIds, ...aktiveIds, ...ventendeIds]);

  const treff = (app.spillere ?? [])
    .filter(s => visIds.has(s.id))
    .sort((a, b) => {
      // Uvalgte søketreff øverst, valgte nederst
      const aValgt = (aktiveIds.has(a.id) || ventendeIds.has(a.id)) ? 1 : 0;
      const bValgt = (aktiveIds.has(b.id) || ventendeIds.has(b.id)) ? 1 : 0;
      if (aValgt !== bValgt) return aValgt - bValgt;
      return (a.navn ?? '').localeCompare(b.navn ?? '', 'nb');
    });

  // Del i to grupper: søketreff (uvalgte) og valgte
  const sokTreff  = treff.filter(s => !aktiveIds.has(s.id) && !ventendeIds.has(s.id));
  const valgte    = treff.filter(s =>  aktiveIds.has(s.id) ||  ventendeIds.has(s.id));

  // Legg alltid til valgte spillere som ikke er i søketreff
  const allValgte = (app.spillere ?? []).filter(s =>
    (aktiveIds.has(s.id) || ventendeIds.has(s.id)) && !visIds.has(s.id)
  );
  const alleValgte = [...valgte, ...allValgte]
    .sort((a, b) => (a.navn ?? '').localeCompare(b.navn ?? '', 'nb'));

  if (sokTreff.length === 0 && alleValgte.length === 0) {
    liste.innerHTML = '<div class="tom-tilstand-liten" style="text-align:center">Ingen treff.</div>';
    return;
  }

  let html = sokTreff.map(s => lagSpillerHTML(s, false, false)).join('');

  if (alleValgte.length > 0) {
    html += `<div class="spiller-liste-separator">Valgte</div>`;
    html += alleValgte.map(s =>
      lagSpillerHTML(s, aktiveIds.has(s.id), ventendeIds.has(s.id))
    ).join('');
  }

  liste.innerHTML = html;
}

export function visSpillere() {
  const q = (document.getElementById('sok-inndata').value ?? '').toLowerCase();
  const { min, er6Format, aktiveIds, ventendeIds } = _beregnSpillerStatus();
  const filtrerte = (app.spillere ?? []).filter(s => (s.navn ?? '').toLowerCase().includes(q));
  document.getElementById('spiller-liste').innerHTML = filtrerte.map(s =>
    lagSpillerHTML(s, aktiveIds.has(s.id), ventendeIds.has(s.id))
  ).join('');
  _oppdaterSpillerTellere(min, er6Format);
}
window.visSpillere = visSpillere;

// In-place oppdatering ved toggle — ingen innerHTML, ingen scroll-hopp
function _oppdaterSpillerListeInPlace() {
  const { min, er6Format, aktiveIds, ventendeIds } = _beregnSpillerStatus();
  document.querySelectorAll('#spiller-liste [data-id]').forEach(el => {
    const sid     = el.dataset.id;
    const erAktiv = aktiveIds.has(sid);
    const erVente = ventendeIds.has(sid);
    const erValgt = erAktiv || erVente;
    const spiller = (app.spillere ?? []).find(s => s.id === sid);
    const rating  = spiller?.rating ?? STARTRATING;
    el.className  = 'spiller-element'
      + (erAktiv ? ' valgt' : '')
      + (erVente ? ' ventende' : '')
      + (!erValgt && !erMix() ? ' ' + getNivaaKlasse(rating) : '');
    const hakeEl = el.querySelector('.spiller-hake');
    if (hakeEl) hakeEl.innerHTML = erValgt
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
      : '';
    const eksVL = el.querySelector('.vl-merke');
    if (erVente && !eksVL) {
      const m = document.createElement('span');
      m.className = 'vl-merke'; m.textContent = 'VL';
      el.insertBefore(m, hakeEl);
    } else if (!erVente && eksVL) { eksVL.remove(); }
  });
  _oppdaterSpillerTellere(min, er6Format);
  oppdaterSisteDeltakereInPlace();
}

// Debounce på søkefeltet — kun ved faktisk bruker-input (ikke programmatisk tømming)
let _sokTimer = null;
let _sokBrukerInput = false;
document.getElementById('sok-inndata')?.addEventListener('keydown', () => { _sokBrukerInput = true; });
document.getElementById('sok-inndata')?.addEventListener('input', () => {
  if (!_sokBrukerInput) return;
  _sokBrukerInput = false;
  clearTimeout(_sokTimer);
  _sokTimer = setTimeout(() => {
    const q = document.getElementById('sok-inndata')?.value ?? '';
    if (q.trim()) {
      // Vis søkeresultater i siste-deltakere-panelet
      const panel = document.getElementById('siste-deltakere-panel');
      const pil   = document.getElementById('siste-deltakere-pil');
      if (panel && panel.style.display === 'none') {
        panel.style.display = 'block';
        if (pil) pil.style.transform = 'rotate(180deg)';
        _sisteDeltakereApen = true;
      }
      visSokIPanel(q);
    } else {
      // Søk tømt — gå tilbake til siste deltakere
      oppdaterSisteDeltakereInPlace();
    }
  }, 150);
});

function veksleSpiller(id) {
  if (!id) return;
  if (app.valgtIds.has(id)) {
    app.valgtIds.delete(id);
  } else {
    app.valgtIds.add(id);
  }
  // Tøm søkefeltet alltid og oppdater listen
  clearTimeout(_sokTimer);
  const sok = document.getElementById('sok-inndata');
  if (sok) sok.value = '';
  const spillerListe = document.getElementById('spiller-liste');
  if (spillerListe) spillerListe.style.display = 'none';
  _oppdaterSpillerListeInPlace();
  oppdaterSisteDeltakereInPlace();
  const _st = _beregnSpillerStatus(); _oppdaterSpillerTellere(_st.min, _st.er6Format);
}
window.veksleSpiller = veksleSpiller;

async function leggTilSpiller() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }
  const inp  = document.getElementById('ny-spiller-inndata');
  const navn = (inp.value ?? '').trim();
  if (!navn) { visMelding('Skriv inn et navn først.', 'advarsel'); return; }
  if (navn.length > 50) { visMelding('Navnet er for langt (maks 50 tegn).', 'advarsel'); return; }
  if (app.spillere.some(s => (s.navn ?? '').toLowerCase() === navn.toLowerCase())) {
    visMelding('En deltaker med det navnet finnes allerede!', 'feil');
    return;
  }
  try {
    const ref = await addDoc(collection(db, SAM.SPILLERE), {
      navn, rating: STARTRATING, klubbId: _aktivKlubbId, opprettetDato: serverTimestamp(),
    });
    // Legg til lokalt med ein gong sa lista vises riktig for onSnapshot returnerer
    app.spillere.push({ id: ref.id, navn, rating: STARTRATING });
    app.valgtIds.add(ref.id);
    inp.value = '';
    const sok = document.getElementById('sok-inndata');
    if (sok) { sok.value = ''; }
    // Legg til i cache og oppdater siste-deltakere-listen
    if (_sisteDeltakereCache) {
      if (!_sisteDeltakereCache.spillerIds.includes(ref.id)) {
        _sisteDeltakereCache.spillerIds.unshift(ref.id);
      }
      _sisteDeltakereCache.hentetMs = Date.now();
    } else {
      // Cache er tom — bygg fra alle valgte spillere
      _sisteDeltakereCache = { spillerIds: [...app.valgtIds], hentetMs: Date.now() };
    }
    // Sørg for at panelet er åpent og oppdater listen
    if (!_sisteDeltakereApen) {
      _sisteDeltakereApen = true;
      const panel = document.getElementById('siste-deltakere-panel');
      const pil   = document.getElementById('siste-deltakere-pil');
      if (panel) panel.style.display = 'block';
      if (pil)   pil.style.transform = 'rotate(180deg)';
    }
    oppdaterSisteDeltakereInPlace();
    visMelding(navn + ' lagt til!');
  } catch (e) {
    visFBFeil('Kunne ikke legge til spiller: ' + (e?.message ?? e));
  }
}
window.leggTilSpiller = leggTilSpiller;

// ════════════════════════════════════════════════════════
// SLETT ALLE SPILLERE (admin)
// ════════════════════════════════════════════════════════
async function visSlettAlleSpillereModal() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }
  _krevAdmin(
    'Slett alle spillere',
    'Kun administrator kan slette alle spillere.',
    async () => {
      try {
        const snap   = await getDocs(collection(db, SAM.SPILLERE));
        const antall = snap.size;
        document.getElementById('slett-alle-spillere-teller').textContent =
          antall === 0
            ? 'Ingen spillere funnet.'
            : `${antall} spiller${antall === 1 ? '' : 'e'} vil bli slettet.`;
        document.getElementById('modal-slett-alle-spillere').style.display = 'flex';
      } catch (e) {
        visFBFeil('Kunne ikke telle spillere: ' + (e?.message ?? e));
      }
    }
  );
}
window.visSlettAlleSpillereModal = visSlettAlleSpillereModal;

async function utforSlettAlleSpillere() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }
  document.getElementById('modal-slett-alle-spillere').style.display = 'none';
  visMelding('Sletter alle spillere… vennligst vent.', 'advarsel');

  try {
    const bh = lagBatchHjelper(db);

    // Hent alle spiller-IDer
    const spillerSnap = await getDocs(collection(db, SAM.SPILLERE));
    const spillerIds  = spillerSnap.docs.map(d => d.id);

    if (spillerIds.length === 0) {
      visMelding('Ingen spillere å slette.', 'advarsel');
      return;
    }

    // Slett alle spillerdokumenter
    for (const d of spillerSnap.docs) await bh.slett(d.ref);

    // Slett tilknyttet data i grupper på 10 (Firestore where-in grense)
    const samlingerMedSpillerId = [SAM.HISTORIKK, SAM.RESULTATER, SAM.TS];
    for (const sam of samlingerMedSpillerId) {
      for (let i = 0; i < spillerIds.length; i += 10) {
        const gruppe = spillerIds.slice(i, i + 10);
        const snap = await getDocs(
          query(collection(db, sam), where('spillerId', 'in', gruppe))
        );
        for (const d of snap.docs) await bh.slett(d.ref);
      }
    }

    await bh.kommit();

    // Nullstill lokal tilstand
    app.spillere = [];
    app.valgtIds.clear();

    visMelding(`${spillerIds.length} spiller${spillerIds.length === 1 ? '' : 'e'} slettet.`);
    oppdaterGlobalLedertavle();
  } catch (e) {
    console.error('[slettAlleSpillere]', e);
    visFBFeil('Feil ved sletting av spillere: ' + (e?.message ?? e));
  }
}
window.utforSlettAlleSpillere = utforSlettAlleSpillere;

// ════════════════════════════════════════════════════════
// SLETT SPILLER (admin)
// ════════════════════════════════════════════════════════
let aktivSlettSpillerId = null;
export function setAktivSlettSpillerId(id) { aktivSlettSpillerId = id; }

export function visSlettSpillerModal() {
  const navn = document.getElementById('global-profil-navn').textContent;
  const id   = aktivSlettSpillerId;
  if (!id) return;
  _krevAdmin(
    'Slett spiller',
    `Bekreft at du vil slette ${navn} permanent.`,
    () => {
      document.getElementById('slett-spiller-navn').textContent = navn;
      document.getElementById('modal-slett-spiller').style.display = 'flex';
    }
  );
}
window.visSlettSpillerModal = visSlettSpillerModal;

export async function utforSlettSpiller() {
  if (!db || !aktivSlettSpillerId) return;
  document.getElementById('modal-slett-spiller').style.display = 'none';
  const spillerId = aktivSlettSpillerId;
  visMelding('Sletter spiller…', 'advarsel');

  try {
    const bh = lagBatchHjelper(db);

    // Slett spillerdokument
    await bh.slett(doc(db, SAM.SPILLERE, spillerId));

    // Slett ratinghistorikk
    const histSnap = await getDocs(
      query(collection(db, SAM.HISTORIKK), where('spillerId', '==', spillerId))
    );
    for (const d of histSnap.docs) await bh.slett(d.ref);

    // Slett resultater
    const resSnap = await getDocs(
      query(collection(db, SAM.RESULTATER), where('spillerId', '==', spillerId))
    );
    for (const d of resSnap.docs) await bh.slett(d.ref);

    // Slett treningSpillere-oppføringer
    const tsSnap = await getDocs(
      query(collection(db, SAM.TS), where('spillerId', '==', spillerId))
    );
    for (const d of tsSnap.docs) await bh.slett(d.ref);

    await bh.kommit();

    // Oppdater lokal tilstand
    app.spillere = app.spillere.filter(s => s.id !== spillerId);
    aktivSlettSpillerId = null;

    visMelding('Spiller slettet.');
    naviger('spillere');
    oppdaterGlobalLedertavle();
  } catch (e) {
    console.error('[slettSpiller]', e);
    visFBFeil('Feil ved sletting: ' + (e?.message ?? e));
  }
}
window.utforSlettSpiller = utforSlettSpiller;