// ════════════════════════════════════════════════════════
// admin.js — PIN-beskyttelse
// Ingen avhengighet til state.js eller firebase.js-konstanter.
// app.js registrerer PIN-getter ved oppstart via registrerPinGetter().
// ════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════
// PIN-GETTER — settes av app.js ved oppstart
// ════════════════════════════════════════════════════════
let _pinGetter    = () => '';
let _klubbIdGetter = () => '';

/**
 * Registrerer en funksjon som returnerer gjeldende admin-PIN.
 */
export function registrerPinGetter(fn) {
  _pinGetter = fn;
}

/**
 * Registrerer en funksjon som returnerer gjeldende klubbId.
 * Brukes for å lagre admin-status per klubb i localStorage.
 */
export function registrerKlubbIdGetter(fn) {
  _klubbIdGetter = fn;
}

function _adminNøkkel() {
  const klubbId = _klubbIdGetter();
  return klubbId ? `pb_admin_${klubbId}` : 'pb_admin';
}

// ════════════════════════════════════════════════════════
// PIN-SYSTEM
// ════════════════════════════════════════════════════════
let pinCallback   = null;
let pinForsok     = 0;
let _erAdmin      = false; // initialiseres av gjenopprettAdminStatus() etter klubbvalg

const PIN_MAKS_FORSOK = 5;

export function getErAdmin() { return _erAdmin; }
export function setErAdmin(v) {
  _erAdmin = v;
  if (v) localStorage.setItem(_adminNøkkel(), '1');
  else   localStorage.removeItem(_adminNøkkel());
}
export function nullstillAdmin() {
  _erAdmin = false;
  localStorage.removeItem(_adminNøkkel());
}

/** Kalles av app.js etter at klubbId er satt — gjenoppretter admin-status fra localStorage. */
export function gjenopprettAdminStatus() {
  _erAdmin = localStorage.getItem(_adminNøkkel()) === '1';
  return _erAdmin;
}

export function krevAdmin(tittel, tekst, callback, erDemoModus = false) {
  if (_erAdmin || erDemoModus) {
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
  if (pin === _pinGetter()) {
    setErAdmin(true);
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
