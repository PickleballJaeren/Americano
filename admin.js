// ════════════════════════════════════════════════════════
// admin.js — PIN-beskyttelse og Firestore-låsesystem
// ════════════════════════════════════════════════════════

import { ADMIN_PIN, db, SAM, doc, getDoc, updateDoc, runTransaction } from './firebase.js';
import { app } from './state.js';
import { visMelding } from './ui.js';

// ════════════════════════════════════════════════════════
// PIN-SYSTEM
// ════════════════════════════════════════════════════════
let pinCallback  = null;
let pinForsok    = 0;
export let erAdmin = false;

const PIN_MAKS_FORSOK = 5;

export function krevAdmin(tittel, tekst, callback) {
  if (erAdmin) {
    if (typeof callback === 'function') callback();
    return;
  }
  pinCallback = callback;
  pinForsok   = 0;
  document.getElementById('pin-tittel').textContent = tittel;
  document.getElementById('pin-tekst').textContent  = tekst;
  document.getElementById('pin-feil').textContent   = '';
  [0,1,2,3].forEach(i => { document.getElementById('pin'+i).value = ''; });
  document.getElementById('modal-pin').style.display = 'flex';
  setTimeout(() => document.getElementById('pin0')?.focus(), 260);
}
window.krevAdmin = krevAdmin;

export function pinInput(indeks) {
  const inp   = document.getElementById('pin' + indeks);
  const verdi = inp.value.replace(/[^0-9]/g, '').slice(-1);
  inp.value   = verdi;
  if (verdi && indeks < 3) {
    document.getElementById('pin' + (indeks + 1))?.focus();
  } else if (verdi && indeks === 3) {
    bekreftPin();
  }
}
window.pinInput = pinInput;

export function bekreftPin() {
  const pin = [0,1,2,3].map(i => document.getElementById('pin'+i).value).join('');
  if (pin === ADMIN_PIN) {
    erAdmin = true;
    const cb = pinCallback;
    lukkPinModal();
    if (typeof cb === 'function') cb();
  } else {
    pinForsok++;
    const igjen = PIN_MAKS_FORSOK - pinForsok;
    if (pinForsok >= PIN_MAKS_FORSOK) {
      document.getElementById('pin-feil').textContent = 'For mange feil forsøk. Lukk og prøv igjen.';
      document.querySelectorAll('.pin-siffer').forEach(el => el.disabled = true);
    } else {
      document.getElementById('pin-feil').textContent = `Feil PIN. ${igjen} forsøk igjen.`;
    }
    [0,1,2,3].forEach(i => { document.getElementById('pin'+i).value = ''; });
    document.getElementById('pin0')?.focus();
  }
}
window.bekreftPin = bekreftPin;

export function lukkPinModal() {
  document.getElementById('modal-pin').style.display = 'none';
  document.querySelectorAll('.pin-siffer').forEach(el => {
    el.disabled = false;
    el.value    = '';
  });
  const btn = document.querySelector('#modal-pin .knapp-primaer');
  if (btn) btn.disabled = false;
  document.getElementById('pin-feil').textContent = '';
  pinCallback = null;
  pinForsok   = 0;
}
window.lukkPinModal = lukkPinModal;

export function nullstillAdmin() {
  erAdmin = false;
}

// ════════════════════════════════════════════════════════
// FIRESTORE-LÅSESYSTEM
// ════════════════════════════════════════════════════════

/**
 * Henter gjeldende treningsdokument fra Firestore.
 */
export async function hentTrening() {
  if (!app.treningId) throw new Error('Ingen aktiv økt.');
  const snap = await getDoc(doc(db, SAM.TRENINGER, app.treningId));
  if (!snap.exists()) throw new Error('Øktdokument ikke funnet.');
  return { id: snap.id, data: snap.data() };
}

/**
 * Setter lås på treningsdokumentet via transaksjon.
 * Stopper hvis allerede låst, avsluttet, eller runden ikke stemmer.
 */
export async function lassTrening(forventetRunde = null) {
  let treningsData = null;

  await runTransaction(db, async (tx) => {
    const ref  = doc(db, SAM.TRENINGER, app.treningId);
    const snap = await tx.get(ref);

    if (!snap.exists())          throw new Error('Økt ikke funnet.');
    const data = snap.data();

    if (data.status !== 'aktiv') throw new Error('Økten er allerede avsluttet.');
    if (data.laast === true)     throw new Error('En annen bruker jobber akkurat nå. Vent litt og prøv igjen.');

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
export async function lossTrening() {
  if (!app.treningId || !db) return;
  try {
    await updateDoc(doc(db, SAM.TRENINGER, app.treningId), { laast: false });
  } catch (e) {
    console.warn('[Lås] Kunne ikke løse lås:', e?.message ?? e);
  }
}
