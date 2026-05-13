// ════════════════════════════════════════════════════════
// turnering-ui.js — Turneringsmodul UI
// Navigasjon, oversikt, oppsett og innstillinger.
// Live-spill (pulje, bracket, resultat) bor i turnering-spill-ui.js.
// ════════════════════════════════════════════════════════

import { escHtml, visMelding, visFBFeil } from './ui.js';
import { app } from './state.js';
import {
  T_STATUS, SEEDING_MODUS, STANDARD_KAMPFORMAT,
  lagKampformat, hentFormatForRunde,
  hentAktiveTurneringer, hentAlleTurneringer, hentTurnering,
  opprettTurnering, oppdaterTurneringKonfig,
  leggTilLag, fjernLag, oppdaterLagNavn, flyttLag, hentKjenteSpillere,
  genererPuljer, lagrePuljer, startPuljespill,
  beregnPuljetabell, kvalifiserTilSluttspill,
  startSluttspill,
  beregnEndeligRangering, beregnFremgang,
  avsluttTurnering, slettTurnering,
  validerResultat, startnivaa,
} from './turnering.js';
import {
  visPulje,
  visBracket,
  visResultat,
} from './turnering-spill-ui.js';

// ── Avhengigheter injisert fra app.js ────────────────────
let _naviger         = () => {};
let _krevAdmin       = () => {};
let _getAktivKlubbId = () => null;

export function turneringUIInit(deps) {
  _naviger         = deps.naviger;
  _krevAdmin       = deps.krevAdmin;
  _getAktivKlubbId = deps.getAktivKlubbId ?? (() => null);
}

// ── Eksporterte hjelpere for turnering-spill-ui.js ───────
/** Navigerer mellom turneringsskjermer. */
export function navigerTurnering(fra, til) { _navigerFremover(fra, til); }

/** Krever admin-PIN — videreformidler til _krevAdmin. */
export function krevAdminTurnering(tittel, tekst, cb) { _krevAdmin(tittel, tekst, cb); }

// ════════════════════════════════════════════════════════
// NAVIGASJONSSTACK
// ════════════════════════════════════════════════════════
const _navStack  = []; // tilbake-historikk
const _fremStack = []; // fremover-historikk
let   _gjeldende = null; // nåværende skjerm

function _oppdaterNavKnapper() {
  const harFrem = _fremStack.length > 0;
  document.querySelectorAll('[id^="t-nav-frem"]').forEach(btn => {
    btn.style.display = harFrem ? 'flex' : 'none';
  });
}

// Naviger fremover — rydder frem-stacken (ny retning)
function _navigerFremover(fraSkjerm, tilSkjerm) {
  if (fraSkjerm) _navStack.push(fraSkjerm);
  _fremStack.length = 0; // ny navigasjon tømmer fremover-historikk
  _gjeldende = tilSkjerm;
  _naviger(tilSkjerm);
  _oppdaterNavKnapper();
}

async function _gjenoppbyggSkjerm(skjerm) {
  const t = app.aktivTurnering;
  if (skjerm === 'turnering')          await visTurneringOversikt();
  else if (skjerm === 'turnering-oppsett'  && t) visOppsett(t);
  else if (skjerm === 'turnering-pulje'    && t) visPulje(t);
  else if (skjerm === 'turnering-bracket'  && t) visBracket(t);
  else if (skjerm === 'turnering-resultat' && t) visResultat(t);
}

// Tilbake-knapp
window.apneLiveViewer = function() {
  const id = _aktivTurneringId;
  if (!id) { visMelding('Ingen aktiv turnering.', 'advarsel'); return; }
  const url = `viewer.html?vis=${encodeURIComponent(id)}`;
  window.open(url, '_blank');
};

window.visDelModal = function() {
  const id = _aktivTurneringId;
  if (!id) { visMelding('Ingen aktiv turnering.', 'advarsel'); return; }

  const base = location.href.replace(/[?#].*$/, '').replace(/index\.html$/, '');
  const url  = `${base}viewer.html?vis=${encodeURIComponent(id)}`;

  document.getElementById('del-url-tekst').textContent = url;
  document.getElementById('del-kopiert-melding').textContent = '';
  document.getElementById('modal-del-live').style.display = 'flex';

  // Generer QR-kode etter at modalen er synlig
  setTimeout(() => _genererQR(url), 50);
};

window.lukkDelModal = function() {
  document.getElementById('modal-del-live').style.display = 'none';
};

window.kopierLiveUrl = async function() {
  const url = document.getElementById('del-url-tekst').textContent;
  try {
    await navigator.clipboard.writeText(url);
    const el = document.getElementById('del-kopiert-melding');
    el.textContent = '✓ Lenke kopiert!';
    setTimeout(() => { el.textContent = ''; }, 2500);
  } catch (e) {
    visMelding('Kunne ikke kopiere — kopier manuelt fra feltet.', 'advarsel');
  }
};

function _genererQR(tekst) {
  const canvas = document.getElementById('del-qr-canvas');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  const size = 132;

  // Enkel QR-matrise via qrcodejs
  if (typeof QRCode !== 'undefined') {
    const boks = document.getElementById('del-qr-boks');
    boks.innerHTML = '';
    new QRCode(boks, {
      text:          tekst,
      width:         132,
      height:        132,
      colorDark:     '#000000',
      colorLight:    '#ffffff',
      correctLevel:  QRCode.CorrectLevel.M,
    });
    return;
  }

  // Fallback: vis URL som tekst om biblioteket ikke er lastet
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  ctx.font = '10px monospace';
  ctx.fillText('Skan URL:', 8, 20);
  const ord = tekst.split('/');
  ord.forEach((del, i) => ctx.fillText(del, 8, 36 + i * 14));
}

window.turneringTilbake = async function() {
  const forrige = _navStack.pop();
  if (!forrige) { _naviger('oppsett'); return; }
  if (_gjeldende) _fremStack.push(_gjeldende);
  _gjeldende = forrige;
  _naviger(forrige);
  await _gjenoppbyggSkjerm(forrige);
  _oppdaterNavKnapper();
};

// Fremover-knapp
window.turneringFremover = async function() {
  const neste = _fremStack.pop();
  if (!neste) return;
  if (_gjeldende) _navStack.push(_gjeldende);
  _gjeldende = neste;
  _naviger(neste);
  await _gjenoppbyggSkjerm(neste);
  _oppdaterNavKnapper();
};

// Aktiv turnering-ID i denne økten
let _aktivTurneringId = null;
export function getAktivTurneringId() { return _aktivTurneringId; }
export function setAktivTurneringId(id) { _aktivTurneringId = id; }


// ════════════════════════════════════════════════════════
// OVERSIKTSKJERM — liste over turneringer
// ════════════════════════════════════════════════════════
export async function visTurneringOversikt() {
  const container = document.getElementById('turnering-liste');
  const laster    = document.getElementById('turnering-laster');
  if (!container) return;

  if (laster) laster.style.display = 'flex';
  container.innerHTML = '';

  try {
    const turneringer = await hentAlleTurneringer();

    if (laster) laster.style.display = 'none';

    if (!turneringer.length) {
      container.innerHTML = `
        <div style="text-align:center;padding:40px 0;color:var(--muted2)">
          <div style="font-size:48px;margin-bottom:12px">🏆</div>
          <div style="font-size:18px">Ingen turneringer ennå</div>
          <div style="font-size:15px;margin-top:6px;color:var(--muted)">Opprett en ny for å komme i gang</div>
        </div>`;
      return;
    }

    container.innerHTML = turneringer.map(t => lagTurneringKort(t)).join('');
  } catch (e) {
    if (laster) laster.style.display = 'none';
    visFBFeil('Kunne ikke laste turneringer: ' + (e?.message ?? e));
  }
}

function lagTurneringKort(t) {
  const statusInfo = _statusInfo(t.status);
  const dato       = t.opprettet?.toDate
    ? t.opprettet.toDate().toLocaleDateString('no-NO', { day:'numeric', month:'short', year:'numeric' })
    : '';
  const antallLag  = (t.lag ?? []).length;

  return `
    <div class="kort" style="margin-bottom:12px">
      <div class="kort-innhold">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="font-family:'Bebas Neue',cursive;font-size:22px;letter-spacing:1px;cursor:pointer;flex:1"
            onclick="apneTurnering('${escHtml(t.id)}')">${escHtml(t.navn)}</div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="t-status-merke ${statusInfo.kl}">${statusInfo.tekst}</span>
            <button class="t-slett-knapp" title="Slett turnering"
              onclick="event.stopPropagation();slettTurneringUI('${escHtml(t.id)}','${escHtml(t.navn)}')">🗑</button>
          </div>
        </div>
        <div style="display:flex;gap:16px;font-size:15px;color:var(--muted2);cursor:pointer"
          onclick="apneTurnering('${escHtml(t.id)}')">
          <span>🏐 ${antallLag} lag</span>
          <span>📅 ${dato}</span>
          ${t.konfig?.antallPuljer ? `<span>🔢 ${t.konfig.antallPuljer} puljer</span>` : ''}
        </div>
      </div>
    </div>`;
}

window.slettTurneringUI = function(id, navn) {
  _krevAdmin(
    'Slett turnering',
    `«${navn}» slettes permanent og kan ikke gjenopprettes.`,
    async () => {
      try {
        await slettTurnering(id);
        visMelding('Turnering slettet.');
        await visTurneringOversikt();
      } catch (e) {
        visMelding(e?.message ?? 'Kunne ikke slette turnering.', 'feil');
      }
    }
  );
};

window.visSlettAlleTurneringerModal = function() {
  _krevAdmin(
    'Slett alle turneringer',
    'Alle turneringer slettes permanent. Kan ikke angres.',
    () => {
      document.getElementById('modal-slett-alle-turneringer').style.display = 'flex';
    }
  );
};
window.lukkSlettAlleTurneringerModal = function() {
  document.getElementById('modal-slett-alle-turneringer').style.display = 'none';
};

window.utforSlettAlleTurneringer = async function() {
  const knapp = document.querySelector('#modal-slett-alle-turneringer .knapp-fare');
  if (knapp) { knapp.disabled = true; knapp.textContent = 'Sletter…'; }
  try {
    const alle = await hentAlleTurneringer();
    await Promise.all(alle.map(t => slettTurnering(t.id)));
    lukkSlettAlleTurneringerModal();
    visMelding(`${alle.length} turnering${alle.length === 1 ? '' : 'er'} slettet.`);
    await visTurneringOversikt();
  } catch (e) {
    visMelding(e?.message ?? 'Noe gikk galt.', 'feil');
  } finally {
    if (knapp) { knapp.disabled = false; knapp.textContent = 'SLETT ALLE'; }
  }
};

function _statusInfo(status) {
  const map = {
    [T_STATUS.SETUP]:           { kl: 'ts-setup',      tekst: 'Oppsett'     },
    [T_STATUS.GROUP_PLAY]:      { kl: 'ts-aktiv',      tekst: 'Puljespill'  },
    [T_STATUS.PLAYOFF_SEEDING]: { kl: 'ts-seeding',    tekst: 'Seeding'     },
    [T_STATUS.PLAYOFFS]:        { kl: 'ts-aktiv',      tekst: 'Sluttspill'  },
    [T_STATUS.FINISHED]:        { kl: 'ts-ferdig',     tekst: 'Ferdig'      },
  };
  return map[status] ?? { kl: '', tekst: status };
}

async function _apneTurneringKjerne(id, settUrl = true) {
  _aktivTurneringId = id;
  if (settUrl) {
    const klubbId = _getAktivKlubbId();
    if (klubbId) {
      try {
        history.replaceState(null, '', '?klubb=' + encodeURIComponent(klubbId) + '&turnering=' + encodeURIComponent(id));
      } catch (_) {}
    }
  }
  try {
    const t = await hentTurnering(id);
    app.aktivTurnering = t;
    switch (t.status) {
      case T_STATUS.SETUP:           _navigerFremover('turnering', 'turnering-oppsett'); visOppsett(t);   break;
      case T_STATUS.GROUP_PLAY:      _navigerFremover('turnering', 'turnering-pulje');   visPulje(t);     break;
      case T_STATUS.PLAYOFF_SEEDING: _navigerFremover('turnering', 'turnering-pulje');   visPulje(t);     break;
      case T_STATUS.PLAYOFFS:        _navigerFremover('turnering', 'turnering-bracket'); visBracket(t);   break;
      case T_STATUS.FINISHED:        _navigerFremover('turnering', 'turnering-resultat'); visResultat(t); break;
      default:                       _navigerFremover('turnering', 'turnering-oppsett'); visOppsett(t);
    }
  } catch (e) {
    visFBFeil('Kunne ikke åpne turnering: ' + (e?.message ?? e));
  }
}

window.apneTurnering = (id) => _apneTurneringKjerne(id, true);

export async function apneTurneringFraLenke(id) {
  await _apneTurneringKjerne(id, false);
}

/**
 * Deler invitasjonslenke til gjeldende turnering.
 * Lenken inneholder ?klubb= og ?turnering= slik at mottaker
 * kobles direkte til turneringen uten å måtte velge klubb manuelt.
 */
window.delTurneringLenke = function() {
  const id      = _aktivTurneringId;
  const klubbId = _getAktivKlubbId();
  if (!id || !klubbId) { return; }

  const base = location.href.replace(/[?#].*$/, '');
  const url  = base + '?klubb=' + encodeURIComponent(klubbId) + '&turnering=' + encodeURIComponent(id);

  if (navigator.share) {
    navigator.share({ title: 'Bli med i turneringen', url }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(url)
      .then(() => visMelding('Lenke kopiert!'))
      .catch(() => visMelding('Kunne ikke kopiere — kopier manuelt fra adresselinjen.', 'advarsel'));
  } else {
    prompt('Kopier lenken:', url);
  }
};

// ════════════════════════════════════════════════════════
// NY TURNERING — modal
// ════════════════════════════════════════════════════════
window.visNyTurneringModal = function() {
  _fylltInnstillingerModal(null); // null = ny turnering, bruk defaults
  document.getElementById('modal-innstillinger-tittel').textContent = 'Ny turnering';
  document.getElementById('modal-innstillinger-knapp').textContent  = 'OPPRETT →';
  document.getElementById('modal-innstillinger-knapp').onclick      = bekreftNyTurnering;
  document.getElementById('modal-ny-turnering').style.display = 'flex';
  setTimeout(() => document.getElementById('ny-turnering-navn')?.focus(), 200);
};
window.lukkNyTurneringModal = function() {
  document.getElementById('modal-ny-turnering').style.display = 'none';
  // Nullstill readonly-tilstand så neste åpning starter rent
  document.querySelectorAll('#modal-ny-turnering .t-velger-knapp').forEach(b => {
    b.style.pointerEvents = '';
    b.style.opacity       = '';
  });
  document.querySelectorAll('#modal-ny-turnering input[type=checkbox]').forEach(cb => {
    cb.disabled = false;
  });
  const navnInp = document.getElementById('ny-turnering-navn');
  if (navnInp) navnInp.readOnly = false;
  const knapp = document.getElementById('modal-innstillinger-knapp');
  if (knapp) knapp.style.display = 'flex';
};

// Åpner samme modal men forhåndsutfylt med eksisterende konfig — for redigering
window.visInnstillingerModal = async function() {
  let t = app.aktivTurnering;
  if (!t && _aktivTurneringId) {
    try { t = await hentTurnering(_aktivTurneringId); app.aktivTurnering = t; }
    catch (e) { visMelding('Kunne ikke laste innstillinger.', 'feil'); return; }
  }
  if (!t) { visMelding('Ingen aktiv turnering.', 'advarsel'); return; }

  _fylltInnstillingerModal(t);
  document.getElementById('modal-innstillinger-tittel').textContent = 'Innstillinger';

  const erSetup = t.status === T_STATUS.SETUP;

  // Skjul/vis lagre-knapp og sett velgere som readonly om ikke i setup
  const knapp = document.getElementById('modal-innstillinger-knapp');
  if (knapp) {
    knapp.style.display = erSetup ? 'flex' : 'none';
  }

  // Deaktiver alle velger-knapper om ikke i setup
  document.querySelectorAll('#modal-ny-turnering .t-velger-knapp').forEach(b => {
    b.style.pointerEvents = erSetup ? '' : 'none';
    b.style.opacity       = erSetup ? '' : '0.6';
  });
  document.querySelectorAll('#modal-ny-turnering input[type=checkbox]').forEach(cb => {
    cb.disabled = !erSetup;
  });
  const navnInp = document.getElementById('ny-turnering-navn');
  if (navnInp) navnInp.readOnly = !erSetup;

  if (erSetup) {
    document.getElementById('modal-innstillinger-knapp').textContent = 'LAGRE →';
    document.getElementById('modal-innstillinger-knapp').onclick     = lagreInnstillinger;
  }

  document.getElementById('modal-ny-turnering').style.display = 'flex';
};

// Fyller modal med verdier — null gir defaults, turnering-objekt gir eksisterende verdier
function _fylltInnstillingerModal(t) {
  const k  = t?.konfig ?? {};
  const pf = k.kampformatPulje      ?? lagKampformat('single', 11);
  const kf = k.kampformatKvartfinale ?? lagKampformat('single', 11);
  const sf = k.kampformatSemifinale  ?? lagKampformat('single', 11);
  const ff = k.kampformatFinale      ?? lagKampformat('single', 15);

  // Navn
  const inp = document.getElementById('ny-turnering-navn');
  if (inp) inp.value = t?.navn ?? '';

  // Puljer
  velgAlternativ('t-puljer-velger', String(k.antallPuljer ?? 2));
  velgAlternativ('t-baner-velger',  String(k.antallBaner  ?? 6));

  // Seeding
  velgAlternativ('t-seeding-velger', k.seedingModus ?? SEEDING_MODUS.STANDARD);

  // Plasseringskamper
  const togA  = document.getElementById('toggle-plasseringskamper-a');
  const togBC = document.getElementById('toggle-plasseringskamper-bc');
  if (togA)  togA.checked  = k.plasseringskamperA  !== false;
  if (togBC) togBC.checked = k.plasseringskamperBC === true;

  // Kampformat pulje
  velgAlternativ('t-pulje-type-velger',  pf.type);
  velgAlternativ('t-pulje-poeng-velger', String(pf.points_to_win));

  // Kampformat sluttspill
  velgAlternativ('t-kvart-type-velger',  kf.type);
  velgAlternativ('t-kvart-poeng-velger', String(kf.points_to_win));
  velgAlternativ('t-semi-type-velger',   sf.type);
  velgAlternativ('t-semi-poeng-velger',  String(sf.points_to_win));
  velgAlternativ('t-finale-type-velger', ff.type);
  velgAlternativ('t-finale-poeng-velger',String(ff.points_to_win));
}

window.lagreInnstillinger = async function() {
  const t = app.aktivTurnering;
  if (!t) return;

  const navn         = document.getElementById('ny-turnering-navn')?.value?.trim();
  const antallPuljer = parseInt(document.querySelector('.t-puljer-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? '2');
  const antallBaner  = parseInt(document.querySelector('.t-baner-velger .t-velger-knapp.aktiv')?.dataset?.verdi  ?? '6');
  const seedingModus = document.querySelector('.t-seeding-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? SEEDING_MODUS.STANDARD;
  const plasseringA  = document.getElementById('toggle-plasseringskamper-a')?.checked !== false;
  const plasseringBC = document.getElementById('toggle-plasseringskamper-bc')?.checked === true;
  const puljeType    = document.querySelector('.t-pulje-type-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? 'single';
  const puljePoeng   = parseInt(document.querySelector('.t-pulje-poeng-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? '11');
  const kvartType    = document.querySelector('.t-kvart-type-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? 'single';
  const kvartPoeng   = parseInt(document.querySelector('.t-kvart-poeng-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? '11');
  const semiType     = document.querySelector('.t-semi-type-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? 'single';
  const semiPoeng    = parseInt(document.querySelector('.t-semi-poeng-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? '11');
  const finaleType   = document.querySelector('.t-finale-type-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? 'single';
  const finalePoeng  = parseInt(document.querySelector('.t-finale-poeng-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? '15');

  if (!navn) { visMelding('Skriv inn turneringsnavn.', 'advarsel'); return; }

  const knapp = document.getElementById('modal-innstillinger-knapp');
  if (knapp) { knapp.disabled = true; knapp.textContent = 'Lagrer…'; }

  try {
    await oppdaterTurneringKonfig(_aktivTurneringId, {
      navn,
      antallPuljer,
      antallBaner,
      seedingModus,
      plasseringskamperA:    plasseringA,
      plasseringskamperBC:   plasseringBC,
      kampformatPulje:       lagKampformat(puljeType,  puljePoeng),
      kampformatKvartfinale: lagKampformat(kvartType,  kvartPoeng),
      kampformatSemifinale:  lagKampformat(semiType,   semiPoeng),
      kampformatFinale:      lagKampformat(finaleType, finalePoeng),
    });
    lukkNyTurneringModal();
    const oppdatert = await hentTurnering(_aktivTurneringId);
    app.aktivTurnering = oppdatert;
    visOppsett(oppdatert);
    visMelding('Innstillinger lagret!');
  } catch (e) {
    visMelding(e?.message ?? 'Feil ved lagring.', 'feil');
  } finally {
    if (knapp) { knapp.disabled = false; }
  }
};

window.bekreftNyTurnering = async function() {
  const navn         = document.getElementById('ny-turnering-navn')?.value?.trim();
  const antallPuljer = parseInt(document.querySelector('.t-puljer-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? '2');
  const antallBaner  = parseInt(document.querySelector('.t-baner-velger .t-velger-knapp.aktiv')?.dataset?.verdi  ?? '6');
  const seedingModus = document.querySelector('.t-seeding-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? SEEDING_MODUS.STANDARD;
  const plasseringA  = document.getElementById('toggle-plasseringskamper-a')?.checked !== false;
  const plasseringBC = document.getElementById('toggle-plasseringskamper-bc')?.checked === true;
  const puljeType    = document.querySelector('.t-pulje-type-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? 'single';
  const puljePoeng   = parseInt(document.querySelector('.t-pulje-poeng-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? '11');
  const kvartType    = document.querySelector('.t-kvart-type-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? 'single';
  const kvartPoeng   = parseInt(document.querySelector('.t-kvart-poeng-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? '11');
  const semiType     = document.querySelector('.t-semi-type-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? 'single';
  const semiPoeng    = parseInt(document.querySelector('.t-semi-poeng-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? '11');
  const finaleType   = document.querySelector('.t-finale-type-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? 'single';
  const finalePoeng  = parseInt(document.querySelector('.t-finale-poeng-velger .t-velger-knapp.aktiv')?.dataset?.verdi ?? '15');

  if (!navn) { visMelding('Skriv inn turneringsnavn.', 'advarsel'); return; }

  try {
    const id = await opprettTurnering({
      navn, antallPuljer, antallBaner, seedingModus,
      plasseringskamperA:   plasseringA,
      plasseringskamperBC:  plasseringBC,
      kampformatPulje:       lagKampformat(puljeType,  puljePoeng),
      kampformatKvartfinale: lagKampformat(kvartType,  kvartPoeng),
      kampformatSemifinale:  lagKampformat(semiType,   semiPoeng),
      kampformatFinale:      lagKampformat(finaleType, finalePoeng),
    });
    lukkNyTurneringModal();
    visMelding('Turnering opprettet!');
    await apneTurnering(id);
  } catch (e) {
    visMelding(e?.message ?? 'Kunne ikke opprette turnering.', 'feil');
  }
};

// ════════════════════════════════════════════════════════
// OPPSETT-SKJERM — lag og puljer
// ════════════════════════════════════════════════════════
// A/B SPILLER-VELGER — tilstand
// ════════════════════════════════════════════════════════
let _velgerSpillerA = null; // navn på spiller A som er valgt

// Henter og viser spillerlisten i oppsett-skjermen
async function lastSpillerListe() {
  const container = document.getElementById('kjente-spillere-liste');
  if (!container) return;

  // Bevar scrollposisjonen — container er sin egen scrollbeholder (overflow-y:auto)
  const scrollPos = container.scrollTop;

  container.innerHTML = '<div style="padding:12px;color:var(--muted2);font-size:14px">Laster spillere…</div>';
  try {
    const spillere = await hentKjenteSpillere();
    // Finn allerede valgte spillere i turneringen
    const t = app.aktivTurnering;
    const valgteNavn = new Set();
    (t?.lag ?? []).forEach(l => {
      if (l.spiller1) valgteNavn.add(l.spiller1.toLowerCase());
      if (l.spiller2) valgteNavn.add(l.spiller2.toLowerCase());
    });

    if (!spillere.length) {
      container.innerHTML = '<div style="padding:12px;color:var(--muted2);font-size:14px">Ingen kjente spillere ennå. Legg til manuelt nedenfor.</div>';
      return;
    }

    container.innerHTML = spillere.map(navn => {
      const valgt  = valgteNavn.has(navn.toLowerCase());
      const erA    = _velgerSpillerA === navn;
      const ini    = navn.split(' ').map(d => d[0]).join('').slice(0,2).toUpperCase();
      const sub    = erA ? `<div class="ks-spiller-rad-sub">Valgt som A</div>` : '';
      return `<div class="ks-spiller-rad${valgt ? ' valgt' : ''}" data-navn="${escHtml(navn)}">
        <div class="ks-avatar">${escHtml(ini)}</div>
        <div class="ks-spiller-rad-navn-wrap">
          <div class="ks-spiller-rad-navn">${escHtml(navn)}</div>
          ${valgt ? '<div style="font-size:12px;margin-top:1px;color:var(--muted2)">Lagt til i lag</div>' : sub}
        </div>
        <div class="ks-spiller-rad-knapper">
          <button class="ks-ab-knapp knapp-a${erA ? ' aktiv-a' : ''}${valgt ? ' dim' : ''}" onclick="velgSpillerA('${escHtml(navn)}')" title="Velg som Spiller A">A</button>
          <button class="ks-ab-knapp knapp-b${valgt ? ' dim' : ''}" onclick="velgSpillerB('${escHtml(navn)}')" title="Velg som Spiller B">B</button>
        </div>
      </div>`;
    }).join('');

    // Gjenopprett scrollposisjon etter re-render
    container.scrollTop = scrollPos;
  } catch (e) {
    container.innerHTML = `<div style="padding:12px;color:var(--muted2);font-size:14px">Kunne ikke laste spillere.</div>`;
  }
}

window.velgSpillerA = function(navn) {
  if (_velgerSpillerA === navn) {
    // Klikk på A igjen = avmarker
    _velgerSpillerA = null;
    oppdaterABStatus();
    return;
  }
  _velgerSpillerA = navn;
  oppdaterABStatus();
};

window.velgSpillerB = async function(navn) {
  if (!_velgerSpillerA) {
    visMelding('Velg Spiller A først.', 'advarsel');
    return;
  }
  if (_velgerSpillerA === navn) {
    visMelding('Spiller A og B kan ikke være samme person.', 'advarsel');
    return;
  }
  const s1 = _velgerSpillerA;
  const s2 = navn;
  _velgerSpillerA = null;
  try {
    await leggTilLag(_aktivTurneringId, s1, s2);
    const t = await hentTurnering(_aktivTurneringId);
    app.aktivTurnering = t;
    oppdaterLagListe(t);
    oppdaterPuljePreview(t);
    oppdaterOppsettKnapper(t);
    await lastSpillerListe();
  } catch (e) {
    visMelding(e?.message ?? 'Feil ved opprettelse av lag.', 'feil');
  }
};

function oppdaterABStatus() {
  document.querySelectorAll('.ks-ab-knapp.knapp-a').forEach(btn => {
    const rad  = btn.closest('.ks-spiller-rad');
    const navn = rad?.dataset?.navn;
    btn.classList.toggle('aktiv-a', navn === _velgerSpillerA);
    // Oppdater sub-tekst
    const sub = rad?.querySelector('.ks-spiller-rad-sub');
    if (sub) sub.style.display = navn === _velgerSpillerA ? '' : 'none';
  });
  const status = document.getElementById('ab-status');
  if (status) {
    status.textContent = _velgerSpillerA
      ? `${_velgerSpillerA} er valgt som A — trykk B på makker`
      : 'Trykk A på en spiller for å starte et lag';
    status.style.color = _velgerSpillerA ? 'var(--green2)' : 'var(--muted2)';
  }
}

// Søk i spillerlisten
window.sokSpillere = function(verdi) {
  const q = verdi.trim().toLowerCase();
  document.querySelectorAll('.ks-spiller-rad').forEach(rad => {
    const navn = rad.dataset.navn?.toLowerCase() ?? '';
    rad.style.display = navn.includes(q) ? '' : 'none';
  });
};

// ════════════════════════════════════════════════════════
export async function visOppsett(turnering) {
  const t = turnering ?? await hentTurnering(_aktivTurneringId);
  app.aktivTurnering = t;
  _velgerSpillerA = null;

  document.getElementById('oppsett-turnering-navn').textContent = t.navn;
  oppdaterLagListe(t);
  oppdaterPuljePreview(t);
  oppdaterOppsettKnapper(t);
  lastSpillerListe();
}

function oppdaterLagListe(t) {
  const liste = document.getElementById('turnering-lag-liste');
  if (!liste) return;

  if (!t.lag?.length) {
    liste.innerHTML = `<div style="text-align:center;padding:20px;color:var(--muted2);font-size:15px">Ingen lag lagt til ennå</div>`;
    return;
  }

  liste.innerHTML = t.lag.map((l, i) => {
    const s1 = escHtml(l.spiller1 ?? l.navn ?? '');
    const s2 = escHtml(l.spiller2 ?? '');
    return `<div class="t-lag-element" data-id="${escHtml(l.id)}">
      <div class="t-lag-seed">${i + 1}</div>
      <div style="flex:1;display:flex;flex-direction:column;gap:2px;cursor:pointer" onclick="redigerLagNavn('${escHtml(l.id)}')" title="Klikk for å redigere">
        <div class="t-lag-navn" style="font-size:15px">${s1}</div>
        ${s2 ? `<div style="font-size:13px;color:var(--muted2)">${s2}</div>` : ''}
      </div>
      <button class="t-lag-fjern" onclick="fjernLagUI('${escHtml(l.id)}')" title="Fjern lag">✕</button>
    </div>`;
  }).join('');

  document.getElementById('turnering-lag-teller').textContent = `${t.lag.length} lag`;
}

function oppdaterPuljePreview(t) {
  const container = document.getElementById('pulje-preview');
  if (!container || !t.lag?.length) return;

  const antall = t.konfig?.antallPuljer ?? 2;
  if (t.lag.length < antall * 2) {
    container.innerHTML = `<div style="color:var(--muted2);font-size:15px">Legg til minst ${antall * 2} lag for ${antall} puljer</div>`;
    return;
  }

  try {
    const puljer = genererPuljer(t.lag, antall);
    const lagMap = Object.fromEntries(t.lag.map(l => [l.id, l]));
    container.innerHTML = puljer.map(p => `
      <div style="margin-bottom:14px">
        <div class="seksjon-etikett" style="margin-bottom:8px">${escHtml(p.navn)}</div>
        <div style="display:flex;flex-direction:column;gap:4px">
          ${p.lagIds.map((id, i) => {
            const lag = lagMap[id];
            const s1  = escHtml(lag?.spiller1 ?? lag?.navn ?? id);
            const s2  = escHtml(lag?.spiller2 ?? '');
            return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--navy3);border:1px solid var(--border);border-radius:8px;">
              <span style="font-family:'DM Mono',monospace;font-size:13px;color:var(--muted);width:18px">${i + 1}</span>
              <div style="display:flex;flex-direction:column;gap:1px">
                <span style="font-size:15px">${s1}</span>
                ${s2 ? `<span style="font-size:13px;color:var(--muted2)">${s2}</span>` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>`).join('');
  } catch (e) {
    container.innerHTML = `<div style="color:var(--muted2);font-size:15px">${escHtml(e.message)}</div>`;
  }
}

function oppdaterOppsettKnapper(t) {
  const startBtn = document.getElementById('start-puljespill-knapp');
  if (!startBtn) return;
  const antall = t.konfig?.antallPuljer ?? 2;
  const nok    = (t.lag?.length ?? 0) >= antall * 2;
  startBtn.disabled = !nok;
  startBtn.title    = nok ? '' : `Trenger minst ${antall * 2} lag`;
}

window.leggTilLagUI = async function() {
  const inp1 = document.getElementById('nytt-lag-spiller1');
  const inp2 = document.getElementById('nytt-lag-spiller2');
  const s1   = inp1?.value?.trim();
  const s2   = inp2?.value?.trim();
  if (!s1) { inp1?.focus(); return; }
  if (!s2) { inp2?.focus(); return; }
  try {
    await leggTilLag(_aktivTurneringId, s1, s2);
    inp1.value = '';
    inp2.value = '';
    inp1.focus();
    const t = await hentTurnering(_aktivTurneringId);
    app.aktivTurnering = t;
    oppdaterLagListe(t);
    oppdaterPuljePreview(t);
    oppdaterOppsettKnapper(t);
    await lastSpillerListe();
  } catch (e) {
    visMelding(e?.message ?? 'Feil ved legg til lag.', 'feil');
    inp1?.focus();
  }
};

window.fjernLagUI = async function(lagId) {
  try {
    await fjernLag(_aktivTurneringId, lagId);
    const t = await hentTurnering(_aktivTurneringId);
    app.aktivTurnering = t;
    oppdaterLagListe(t);
    oppdaterPuljePreview(t);
    oppdaterOppsettKnapper(t);
    await lastSpillerListe();
  } catch (e) {
    visMelding(e?.message ?? 'Feil ved fjerning.', 'feil');
  }
};

window.redigerLagNavn = function(lagId) {
  const el = document.querySelector(`.t-lag-element[data-id="${lagId}"]`);
  if (!el) return;
  const lag = app.aktivTurnering?.lag?.find(l => l.id === lagId);
  if (!lag) return;

  const gammelS1 = lag.spiller1 ?? lag.navn ?? '';
  const gammelS2 = lag.spiller2 ?? '';
  const midtKol  = el.querySelector('[style*="flex-direction:column"]');
  if (!midtKol) return;

  midtKol.innerHTML = `
    <input class="t-lag-rediger-s1" value="${escHtml(gammelS1)}" placeholder="Spiller 1"
      style="font-size:15px;background:var(--navy3);border:1px solid var(--accent);border-radius:6px;padding:3px 7px;color:var(--white);width:100%;margin-bottom:3px"/>
    <input class="t-lag-rediger-s2" value="${escHtml(gammelS2)}" placeholder="Spiller 2"
      style="font-size:13px;background:var(--navy3);border:1px solid var(--accent);border-radius:6px;padding:3px 7px;color:var(--white);width:100%"/>`;

  const s1El = midtKol.querySelector('.t-lag-rediger-s1');
  const s2El = midtKol.querySelector('.t-lag-rediger-s2');
  s1El.focus(); s1El.select();

  const lagre = async () => {
    const nyS1 = s1El.value.trim();
    const nyS2 = s2El.value.trim();
    if (!nyS1 || !nyS2) {
      const t = await hentTurnering(_aktivTurneringId);
      app.aktivTurnering = t; oppdaterLagListe(t); return;
    }
    if (nyS1 === gammelS1 && nyS2 === gammelS2) {
      const t = await hentTurnering(_aktivTurneringId);
      app.aktivTurnering = t; oppdaterLagListe(t); return;
    }
    try {
      await oppdaterLagNavn(_aktivTurneringId, lagId, nyS1, nyS2);
      const t = await hentTurnering(_aktivTurneringId);
      app.aktivTurnering = t;
      oppdaterLagListe(t);
      oppdaterPuljePreview(t);
      await lastSpillerListe();
    } catch (e) {
      visMelding(e?.message ?? 'Feil.', 'feil');
      const t = await hentTurnering(_aktivTurneringId);
      app.aktivTurnering = t; oppdaterLagListe(t);
    }
  };

  s1El.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); s2El.focus(); s2El.select(); } if (e.key === 'Escape') lagre(); };
  s2El.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); lagre(); } if (e.key === 'Escape') lagre(); };
  s2El.onblur    = () => setTimeout(lagre, 150);
};

window.startPuljespillUI = function() {
  _krevAdmin('Start puljespill', 'Bekreft for å generere og starte puljespillet.', async () => {
    const knapp = document.getElementById('start-puljespill-knapp');
    if (knapp) { knapp.disabled = true; knapp.textContent = 'Starter…'; }
    try {
      const t      = await hentTurnering(_aktivTurneringId);
      const antall = t.konfig?.antallPuljer ?? 2;
      const puljer = genererPuljer(t.lag, antall);
      await lagrePuljer(_aktivTurneringId, puljer);
      await startPuljespill(_aktivTurneringId);
      const oppdatert = await hentTurnering(_aktivTurneringId);
      app.aktivTurnering = oppdatert;
      _navigerFremover('turnering-oppsett', 'turnering-pulje');
      visPulje(oppdatert);
    } catch (e) {
      visMelding(e?.message ?? 'Feil ved oppstart.', 'feil');
      if (knapp) { knapp.disabled = false; knapp.textContent = 'START PULJESPILL'; }
    }
  });
};

// ════════════════════════════════════════════════════════
window.velgAlternativ = function(gruppe, verdi) {
  document.querySelectorAll(`.${gruppe} .t-velger-knapp`).forEach(b => {
    b.classList.toggle('aktiv', b.dataset.verdi === String(verdi));
  });
};
