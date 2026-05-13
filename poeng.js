// ════════════════════════════════════════════════════════
// poeng.js — input, validering, autolagring
// ════════════════════════════════════════════════════════
import {
  db, SAM,
  collection, doc,
  query, where, getDocs, writeBatch,
} from './firebase.js';
import { app, erMix } from './state.js';
import { getParter } from './rotasjon.js';
import { PARTER_6_SINGEL, PARTER_6_DOBBEL } from './firebase.js';
import { visFBFeil } from './ui.js';
import { getKampStatusCache } from './baner.js';

// ── Avhengighet injisert fra app.js via poengInit() ──────────────────────────
let _oppdaterPoengNav = () => {};

export function poengInit(deps) {
  _oppdaterPoengNav = deps.oppdaterPoengNav;
}

// Debounce-timere per kamp-indeks — autosave venter 800ms etter siste tastetrykk
const autosaveTimere = {};

export function validerInndata(i, endretFelt) {
  ['l1','l2'].forEach(lag => {
    const el = document.getElementById(`s${i}_${lag}`);
    el.value = el.value.replace(/[^0-9]/g, '');
  });

  const el1  = document.getElementById(`s${i}_l1`);
  const el2  = document.getElementById(`s${i}_l2`);
  const l1   = parseInt(el1.value, 10);
  const l2   = parseInt(el2.value, 10);
  const bane = (app.baneOversikt ?? []).find(b => b.baneNr === app.aktivBane);
  const erSingelValider = bane?.erSingel === true || (bane?.spillere?.length === 2);
  const maks = bane?.maksPoeng ?? (app.poengPerKamp ?? 17);

  // Autofyll motstanderens poeng
  let autofylte = false;
  if (endretFelt === 'l1' && !isNaN(l1) && l1 >= 0 && l1 <= maks && el2.value === '') {
    el2.value = String(maks - l1);
    autofylte = true;
  } else if (endretFelt === 'l2' && !isNaN(l2) && l2 >= 0 && l2 <= maks && el1.value === '') {
    el1.value = String(maks - l2);
    autofylte = true;
  }

  // Auto-hopp til neste tomme kamp etter autofyll
  if (autofylte) {
    const erSingelHopp = bane?.erSingel === true || (bane?.spillere?.length === 2);
    const erDobbelHopp6 = app.er6SpillerFormat && (bane?.erDobbel === true);
    const antallKamper = erSingelHopp
      ? PARTER_6_SINGEL.length
      : (erDobbelHopp6 ? PARTER_6_DOBBEL.length : getParter(bane?.spillere?.length ?? 4).length);
    setTimeout(() => {
      for (let neste = i + 1; neste < antallKamper; neste++) {
        const nesteEl = document.getElementById(`s${neste}_l1`);
        if (nesteEl && nesteEl.value === '') { nesteEl.focus(); return; }
      }
      document.activeElement?.blur();
    }, 80);
  }

  const v1  = parseInt(el1.value, 10);
  const v2  = parseInt(el2.value, 10);
  const ok  = !isNaN(v1) && !isNaN(v2) && v1 >= 0 && v2 >= 0 && v1 + v2 === maks;
  const kort = document.getElementById(`kk-${i}`);

  if (!isNaN(v1) && !isNaN(v2)) {
    kort.classList.toggle('ugyldig', !ok);
    el1.classList.toggle('ugyldig', !ok);
    el2.classList.toggle('ugyldig', !ok);
  } else {
    kort.classList.remove('ugyldig');
    el1.classList.remove('ugyldig');
    el2.classList.remove('ugyldig');
  }

  // Autosave: kanseller forrige timer og start ny 800ms-nedtelling
  clearTimeout(autosaveTimere[i]);
  if (ok) {
    settKampStatus(i, 'lagrer', '…');
    autosaveTimere[i] = setTimeout(() => autolagreKamp(i, v1, v2), 800);
  } else {
    settKampStatus(i, '', '');
  }
}
window.validerInndata = validerInndata;

/** Oppdaterer statuslinjen i kamp-kortets header. */
function settKampStatus(i, type, tekst) {
  const el = document.getElementById(`kamp-status-${i}`);
  if (!el) return;
  el.className = 'kamp-status' + (type ? ' ' + type : '');
  el.textContent = tekst;
}

/** Henter kamp-dokument-ID fra cache eller Firestore for én bestemt kamp. */
async function hentKampDokId(baneNr, kampNr) {
  const cachenøkkel = `${baneNr}_${kampNr}`;
  const _ksc = getKampStatusCache();
  if (_ksc[cachenøkkel]?.id) return _ksc[cachenøkkel].id;
  const snap = await getDocs(query(
    collection(db, SAM.KAMPER),
    where('treningId', '==', app.treningId),
    where('rundeNr',   '==', app.runde),
    where('baneNr',    '==', baneNr),
    where('kampNr',    '==', kampNr)
  ));
  return snap.docs[0]?.id ?? null;
}

/** Lagrer én kamp til Firestore automatisk — kalles av debounce-timer. */
export async function autolagreKamp(i, l1, l2) {
  if (!db || !app.treningId) return;

  const baneNr = app.aktivBane;
  const bane   = (app.baneOversikt ?? []).find(b => b.baneNr === baneNr);
  const erSingelLagre  = bane?.erSingel === true || (bane?.spillere?.length === 2);
  const erDobbelLagre6 = app.er6SpillerFormat && (bane?.erDobbel === true);
  const parter = erMix()
    ? (erSingelLagre
        ? PARTER_6_SINGEL
        : [{ nr: 1, lag1: [0, 1], lag2: [2, 3] }])
    : (erSingelLagre ? PARTER_6_SINGEL : (erDobbelLagre6 ? PARTER_6_DOBBEL : getParter(bane?.spillere?.length ?? 4)));

  // Bruk data-kampnr fra kamp-kortet hvis det finnes (enkelt-kamp-visning)
  // Ellers bruk parter[i].nr som tidligere (alle-kamper-visning)
  const kortEl  = document.getElementById(`kk-${i}`);
  const kampNrFraAttr = kortEl?.dataset?.kampnr ? parseInt(kortEl.dataset.kampnr) : null;
  const par = kampNrFraAttr != null
    ? parter.find(p => p.nr === kampNrFraAttr) ?? parter[i]
    : parter[i];
  if (!par) return;

  try {
    const kampId = await hentKampDokId(`bane${baneNr}`, par.nr);
    if (!kampId) { settKampStatus(i, 'feil-status', '✗ Fant ikke kamp'); return; }

    const oppdatering = { lag1Poeng: l1, lag2Poeng: l2, ferdig: true };
    if (!erSingelLagre && par.hviler != null && bane?.spillere?.[par.hviler]) {
      oppdatering.hvilerPoeng = Math.ceil((l1 + l2) / 2);
    }

    const batch = writeBatch(db);
    batch.update(doc(db, SAM.KAMPER, kampId), oppdatering);
    await batch.commit();

    settKampStatus(i, 'lagret', '✓ Lagret');
    document.getElementById(`kk-${i}`)?.classList.remove('ugyldig');
    _oppdaterPoengNav();

    // Naviger automatisk tilbake etter kort pause slik at brukeren ser "✓ Lagret".
    // Admin → baner-skjermen, tilskuer → tilskuerskjermen.
    // Unngå navigering (og scroll til topp) om vi allerede er på baner-skjermen.
    setTimeout(() => {
      if (typeof window.naviger !== 'function') return;
      const erPaaBaner = document.getElementById('skjerm-baner')?.classList.contains('active');
      if (!erPaaBaner) {
        window.naviger(window.getErAdmin?.() ? 'baner' : 'tilskuer');
      }
    }, 600);
  } catch (e) {
    console.error('[autolagreKamp]', e);
    settKampStatus(i, 'feil-status', '✗ Lagring feilet');
  }
}
window.autolagreKamp = autolagreKamp;

export function lukkTastaturOgScrollTilLagre() {
  // Fjern fokus fra alle input → lukker tastaturet på iOS
  document.activeElement?.blur();
  const lagreKnapp = document.getElementById('lagre-poeng-knapp');
  if (lagreKnapp) lagreKnapp.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
window.lukkTastaturOgScrollTilLagre = lukkTastaturOgScrollTilLagre;
export function lesOgValiderPoeng() {
  const bane   = (app.baneOversikt ?? []).find(b => b.baneNr === app.aktivBane);
  const erSingelLOV = bane?.erSingel === true || (bane?.spillere?.length === 2);
  const erDobbelLOV6 = app.er6SpillerFormat && (bane?.erDobbel === true);
  const parter = erMix()
    ? (erSingelLOV ? PARTER_6_SINGEL : [{ nr: 1, lag1: [0,1], lag2: [2,3] }])
    : (erSingelLOV ? PARTER_6_SINGEL : (erDobbelLOV6 ? PARTER_6_DOBBEL : getParter(bane?.spillere?.length ?? 4)));
  const maks   = bane?.maksPoeng ?? (app.poengPerKamp ?? 17);
  const feil = [];
  const poeng = [];
  for (let i = 0; i < parter.length; i++) {
    const l1 = parseInt(document.getElementById(`s${i}_l1`).value, 10);
    const l2 = parseInt(document.getElementById(`s${i}_l2`).value, 10);
    if (isNaN(l1) || isNaN(l2)) {
      feil.push(`Kamp ${i+1}: Poeng mangler.`); poeng.push(null); continue;
    }
    if (l1 < 0 || l2 < 0)         feil.push(`Kamp ${i+1}: Negative tall er ikke tillatt.`);
    if (l1 > maks || l2 > maks)   feil.push(`Kamp ${i+1}: Maks ${maks} poeng per lag.`);
    if (l1 + l2 !== maks)         feil.push(`Kamp ${i+1}: ${l1} + ${l2} = ${l1+l2}, skal være ${maks}.`);
    poeng.push({ l1, l2 });
  }
  return { feil, poeng };
}