// ════════════════════════════════════════════════════════
// utfordrer.js — Utfordrermodusen
// Singel-ranking, utfordringer, game-registrering, Elo-oppdatering
// ════════════════════════════════════════════════════════
import {
  db, SAM, STARTRATING,
  collection, doc, addDoc, getDoc, getDocs, updateDoc,
  query, where, onSnapshot, writeBatch, serverTimestamp,
} from './firebase.js';
import { app } from './state.js';
import { getNivaaKlasse, getNivaaRatingHTML } from './rating.js';
import { visMelding, visFBFeil, escHtml } from './ui.js';
import { lagInitialer } from './render-helpers.js';

// ── Avhengigheter injisert fra app.js ────────────────────
let _getAktivKlubbId    = () => null;
let _getAktivSpillerId  = () => sessionStorage.getItem('aktivSpillerId');

export function utfordrerInit(deps) {
  _getAktivKlubbId   = deps.getAktivKlubbId   ?? (() => null);
  _getAktivSpillerId = deps.getAktivSpillerId  ?? (() => sessionStorage.getItem('aktivSpillerId'));
}

// ════════════════════════════════════════════════════════
// KONSTANTER
// ════════════════════════════════════════════════════════
const UTF_RATING_VINDU      = 100;
const UTF_MIN_SINGEL_KAMPER = 3;
const UTF_UTLOP_DAGER       = 14;
const UTF_COOLDOWN_DAGER    = 7;
const UTF_K_FAKTOR          = 32;
const UTF_OPPRYKK_BONUS     = 1.3;
const UTF_STATUS = {
  VENTER:    'venter',
  AKSEPTERT: 'akseptert',
  FERDIG:    'ferdig',
  AVVIST:    'avvist',
  UTLOPT:    'utlopt',
};

// ════════════════════════════════════════════════════════
// HJELPERE
// ════════════════════════════════════════════════════════
function _hentUtfordrerRating(spiller) {
  const singelRating = spiller.singelRating;
  const singelKamper = spiller.singelKamper ?? 0;
  if (singelRating != null && singelKamper >= UTF_MIN_SINGEL_KAMPER) return singelRating;
  return spiller.rating ?? STARTRATING;
}

function _msSiden(ts) {
  return Date.now() - (ts?.toMillis?.() ?? 0);
}

function _dagerSiden(ts) {
  return _msSiden(ts) / (1000 * 60 * 60 * 24);
}

function _beregnUtfordringRating(ratingA, ratingB, vantA) {
  const forventet = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const faktisk   = vantA ? 1 : 0;
  let K = UTF_K_FAKTOR;
  if (vantA && ratingB > ratingA) K = Math.round(K * UTF_OPPRYKK_BONUS);
  return Math.round(K * (faktisk - forventet));
}

async function _hentUtfordringerForSpiller(spillerId, klubbId) {
  if (!db || !spillerId || !klubbId) return [];
  try {
    const [somUtf, somMot] = await Promise.all([
      getDocs(query(collection(db, SAM.UTFORDRINGER), where('utfordrerIds', '==', spillerId), where('klubbId', '==', klubbId))),
      getDocs(query(collection(db, SAM.UTFORDRINGER), where('motstanderId', '==', spillerId), where('klubbId', '==', klubbId))),
    ]);
    const alle = [
      ...somUtf.docs.map(d => ({ id: d.id, ...d.data() })),
      ...somMot.docs.map(d => ({ id: d.id, ...d.data() })),
    ];
    return alle.map(u => {
      if (u.status === UTF_STATUS.VENTER && _dagerSiden(u.opprettet) > UTF_UTLOP_DAGER) {
        return { ...u, status: UTF_STATUS.UTLOPT };
      }
      return u;
    });
  } catch (e) {
    console.warn('[Utfordring] Hent feilet:', e?.message);
    return [];
  }
}

async function _kanUtfordre(utfordrerSpiller, motstanderSpiller, klubbId) {
  if (utfordrerSpiller.id === motstanderSpiller.id)
    return { ok: false, grunn: 'Du kan ikke utfordre deg selv.' };

  const utfRating = _hentUtfordrerRating(utfordrerSpiller);
  const motRating = _hentUtfordrerRating(motstanderSpiller);
  const diff      = Math.abs(utfRating - motRating);

  const alleSpillere = [...(window._app?.spillere ?? [])].sort((a, b) => _hentUtfordrerRating(b) - _hentUtfordrerRating(a));
  const utfIdx = alleSpillere.findIndex(s => s.id === utfordrerSpiller.id);
  const spillerenOverIdx = utfIdx > 0 ? utfIdx - 1 : -1;
  const erSpillerenOverMeg = spillerenOverIdx >= 0 && alleSpillere[spillerenOverIdx]?.id === motstanderSpiller.id;

  if (diff > UTF_RATING_VINDU && !erSpillerenOverMeg) {
    return { ok: false, grunn: `Ratingforskjellen er ${diff} poeng — maks er ${UTF_RATING_VINDU}. Du kan alltid utfordre spilleren rett over deg.` };
  }

  const utfordringer = await _hentUtfordringerForSpiller(utfordrerSpiller.id, klubbId);

  const harAktiv = utfordringer.some(u =>
    (u.utfordrerIds === utfordrerSpiller.id || u.motstanderId === utfordrerSpiller.id) &&
    (u.status === UTF_STATUS.VENTER || u.status === UTF_STATUS.AKSEPTERT)
  );
  if (harAktiv)
    return { ok: false, grunn: 'Du har allerede én aktiv utfordring. Fullfør eller trekk den tilbake først.' };

  const sisteMotSammePerson = utfordringer
    .filter(u =>
      (u.status === UTF_STATUS.FERDIG || u.status === UTF_STATUS.AVVIST) &&
      ((u.utfordrerIds === utfordrerSpiller.id && u.motstanderId === motstanderSpiller.id) ||
       (u.motstanderId === utfordrerSpiller.id && u.utfordrerIds === motstanderSpiller.id))
    )
    .sort((a, b) => (b.avsluttet?.toMillis?.() ?? 0) - (a.avsluttet?.toMillis?.() ?? 0))[0];

  if (sisteMotSammePerson && _dagerSiden(sisteMotSammePerson.avsluttet) < UTF_COOLDOWN_DAGER) {
    const gjenstår = Math.ceil(UTF_COOLDOWN_DAGER - _dagerSiden(sisteMotSammePerson.avsluttet));
    return { ok: false, grunn: `Cooldown — du kan utfordre ${motstanderSpiller.navn} igjen om ${gjenstår} dag${gjenstår === 1 ? '' : 'er'}.` };
  }

  return { ok: true, grunn: null };
}

async function _sendUtfordring(utfordrerSpiller, motstanderSpiller, klubbId) {
  await addDoc(collection(db, SAM.UTFORDRINGER), {
    klubbId,
    utfordrerIds:      utfordrerSpiller.id,
    utfordrerNavn:     utfordrerSpiller.navn ?? 'Ukjent',
    utfordrerRating:   _hentUtfordrerRating(utfordrerSpiller),
    motstanderId:      motstanderSpiller.id,
    motstanderNavn:    motstanderSpiller.navn ?? 'Ukjent',
    motstanderRating:  _hentUtfordrerRating(motstanderSpiller),
    status:            UTF_STATUS.VENTER,
    opprettet:         serverTimestamp(),
    avsluttet:         null,
    games:             [],
    erRevansje:        false,
    originalUtfordringId: null,
  });
}

// ════════════════════════════════════════════════════════
// BADGE OG TOAST
// ════════════════════════════════════════════════════════
export async function sjekkVentendeUtfordringer() {
  const spillerId = sessionStorage.getItem('aktivSpillerId');
  const klubbId   = _getAktivKlubbId();
  const badge     = document.getElementById('utf-badge');
  if (!spillerId || !klubbId || !db || !badge) return;

  try {
    const snap = await getDocs(query(
      collection(db, SAM.UTFORDRINGER),
      where('motstanderId', '==', spillerId),
      where('klubbId',      '==', klubbId),
      where('status',       '==', UTF_STATUS.VENTER),
    ));

    const ventende = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(u => _dagerSiden(u.opprettet) <= UTF_UTLOP_DAGER);

    const antall = ventende.length;
    if (antall > 0) {
      badge.textContent   = antall > 9 ? '9+' : String(antall);
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }

    if (antall > 0 && !sessionStorage.getItem('utf-toast-vist')) {
      sessionStorage.setItem('utf-toast-vist', '1');
      const navn  = ventende[0]?.utfordrerNavn ?? 'Noen';
      const tekst = antall === 1 ? `⚔️ ${navn} har utfordret deg!` : `⚔️ Du har ${antall} nye utfordringer!`;
      setTimeout(() => visMelding(tekst, 'ok', 5600), 1200);
    }

    if (!sessionStorage.getItem('utf-avvist-toast-vist')) {
      const avvistSnap = await getDocs(query(
        collection(db, SAM.UTFORDRINGER),
        where('utfordrerIds', '==', spillerId),
        where('klubbId',      '==', klubbId),
        where('status',       '==', UTF_STATUS.AVVIST),
      ));
      const nyligAvvist = avvistSnap.docs
        .map(d => d.data())
        .filter(u => _dagerSiden(u.avsluttet) < 1);
      if (nyligAvvist.length > 0) {
        sessionStorage.setItem('utf-avvist-toast-vist', '1');
        const motNavn     = nyligAvvist[0]?.motstanderNavn  ?? 'motstanderen';
        const utfNavn     = nyligAvvist[0]?.utfordrerNavn   ?? 'deg';
        setTimeout(() => visMelding(`${motNavn} er redd for ${utfNavn}! 🐥`, 'advarsel', 5600), 1500);
      }
    }
  } catch (e) {
    console.warn('[Utfordring] Badge-sjekk feilet:', e?.message);
  }
}

export function nullstillUtfordringBadge() {
  const badge = document.getElementById('utf-badge');
  if (badge) badge.style.display = 'none';
  sessionStorage.removeItem('utf-toast-vist');
}
window.nullstillUtfordringBadge = nullstillUtfordringBadge;

// ════════════════════════════════════════════════════════
// SANNTIDSLYTTER
// ════════════════════════════════════════════════════════
let _utfordringLytterAvmeld = null;

export function startUtfordrerLytter() {
  const klubbId = _getAktivKlubbId();
  if (!db || !klubbId) return;
  if (_utfordringLytterAvmeld) { try { _utfordringLytterAvmeld(); } catch (_) {} }

  _utfordringLytterAvmeld = onSnapshot(
    query(collection(db, SAM.UTFORDRINGER), where('klubbId', '==', klubbId)),
    async () => {
      const spillere = [...(window._app?.spillere ?? [])];
      await Promise.all([
        _lastAktiveUtfordringer(klubbId, spillere),
        _lastSisteResultater(klubbId, spillere),
      ]);
    },
    feil => console.warn('[UtfordrerLytter]', feil?.message ?? feil)
  );
}

export function stoppUtfordrerLytter() {
  if (_utfordringLytterAvmeld) {
    try { _utfordringLytterAvmeld(); } catch (_) {}
    _utfordringLytterAvmeld = null;
  }
}

// ════════════════════════════════════════════════════════
// UTFORDRER-SKJERM
// ════════════════════════════════════════════════════════
window.toggleSingelRanking = function() {
  const wrapper = document.getElementById('utf-singel-wrapper');
  const chevron = document.getElementById('utf-singel-chevron');
  if (!wrapper) return;
  const erApen = wrapper.style.display !== 'none';
  wrapper.style.display = erApen ? 'none' : 'block';
  if (chevron) chevron.style.transform = erApen ? '' : 'rotate(90deg)';
  if (!erApen) visUtfordrerSkjerm();
};

export async function visUtfordrerSkjerm() {
  const klubbId = _getAktivKlubbId();

  let spillere = [...(window._app?.spillere ?? [])];
  if (db && klubbId) {
    try {
      const snap = await getDocs(query(collection(db, SAM.SPILLERE), where('klubbId', '==', klubbId)));
      if (!snap.empty) spillere = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) {}
  }
  spillere = spillere.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));

  const lagretId  = sessionStorage.getItem('aktivSpillerId');
  const megVelger = document.getElementById('utf-meg-velger');

  if (megVelger) {
    megVelger.innerHTML = '<option value="">— Velg deg selv —</option>' +
      spillere.map(s =>
        `<option value="${s.id}" ${s.id === lagretId ? 'selected' : ''}>${escHtml(s.navn ?? 'Ukjent')}</option>`
      ).join('');
    if (megVelger.value) sessionStorage.setItem('aktivSpillerId', megVelger.value);
  }

  _oppdaterMotstanderVelger(spillere, sessionStorage.getItem('aktivSpillerId'));
  _visSingelRanking(spillere);
  await Promise.all([
    _lastAktiveUtfordringer(klubbId, spillere),
    _lastSisteResultater(klubbId, spillere),
  ]);
}
window.visUtfordrerSkjerm = visUtfordrerSkjerm;

window.oppdaterUtfordrerVelger = function() {
  const spillere = [...(window._app?.spillere ?? [])].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  _oppdaterMotstanderVelger(spillere, sessionStorage.getItem('aktivSpillerId'));
  visUtfordrerSkjerm();
};

function _oppdaterMotstanderVelger(spillere, lagretId) {
  const motVelger = document.getElementById('utf-mot-velger');
  if (!motVelger) return;
  motVelger.innerHTML = '<option value="">— Velg motstander —</option>' +
    spillere
      .filter(s => s.id !== lagretId)
      .map(s => `<option value="${s.id}">${escHtml(s.navn ?? 'Ukjent')} — ${s.rating ?? STARTRATING} ⭐</option>`)
      .join('');
}

window.sendUtfordringFraSkjerm = async function() {
  const megId = document.getElementById('utf-meg-velger')?.value;
  const motId = document.getElementById('utf-mot-velger')?.value;
  if (!megId) { visMelding('Velg deg selv først.', 'advarsel'); return; }
  if (!motId) { visMelding('Velg en motstander.', 'advarsel'); return; }

  sessionStorage.setItem('aktivSpillerId', megId);
  const klubbId = _getAktivKlubbId();
  if (!klubbId || !db) return;

  try {
    const [utfSnap, motSnap] = await Promise.all([
      getDoc(doc(db, SAM.SPILLERE, megId)),
      getDoc(doc(db, SAM.SPILLERE, motId)),
    ]);
    if (!utfSnap.exists() || !motSnap.exists()) { visMelding('Fant ikke spillerdata.', 'feil'); return; }
    const utfSpiller = { id: utfSnap.id, ...utfSnap.data() };
    const motSpiller = { id: motSnap.id, ...motSnap.data() };

    const { ok, grunn } = await _kanUtfordre(utfSpiller, motSpiller, klubbId);
    if (!ok) { visMelding(grunn, 'advarsel'); return; }

    await _sendUtfordring(utfSpiller, motSpiller, klubbId);
    visMelding(`Utfordring sendt til ${escHtml(motSpiller.navn ?? 'motstanderen')}!`);
    await visUtfordrerSkjerm();
  } catch (e) {
    visFBFeil('Kunne ikke sende utfordring: ' + (e?.message ?? e));
  }
};

async function _lastAktiveUtfordringer(klubbId, spillere) {
  const el    = document.getElementById('utf-aktive-liste');
  const megId = sessionStorage.getItem('aktivSpillerId');
  if (!db || !klubbId) return;

  try {
    const [ventSnap, aksSnap] = await Promise.all([
      getDocs(query(collection(db, SAM.UTFORDRINGER), where('klubbId', '==', klubbId), where('status', '==', UTF_STATUS.VENTER))),
      getDocs(query(collection(db, SAM.UTFORDRINGER), where('klubbId', '==', klubbId), where('status', '==', UTF_STATUS.AKSEPTERT))),
    ]);

    const alle = [
      ...ventSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      ...aksSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    ].filter(u => _dagerSiden(u.opprettet) <= UTF_UTLOP_DAGER)
     .sort((a, b) => (b.opprettet?.toMillis?.() ?? 0) - (a.opprettet?.toMillis?.() ?? 0));

    if (!el) return;
    if (!alle.length) {
      el.innerHTML = '<div class="tom-tilstand-liten" style="text-align:center">Ingen aktive utfordringer</div>';
      return;
    }

    el.innerHTML = alle.map(u => {
      const erPagar      = u.status === UTF_STATUS.AKSEPTERT;
      const erUtfordrer  = u.utfordrerIds === megId;
      const erMotstander = u.motstanderId === megId;
      const utfSeire     = (u.games ?? []).filter(g => g.utfPoeng > g.motPoeng).length;
      const motSeire     = (u.games ?? []).filter(g => g.motPoeng > g.utfPoeng).length;
      const dagerIgjen   = UTF_UTLOP_DAGER - Math.floor(_dagerSiden(u.opprettet));
      const gamesSpilt   = u.games ?? [];

      const gamesHTML = gamesSpilt.length
        ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">` +
          gamesSpilt.map((g, i) => {
            const megPoeng = erUtfordrer ? g.utfPoeng : g.motPoeng;
            const demPoeng = erUtfordrer ? g.motPoeng : g.utfPoeng;
            const vant     = megPoeng > demPoeng;
            const farge    = vant ? 'var(--green2)' : 'var(--red2)';
            return `<span style="font-size:12px;background:rgba(255,255,255,.06);border-radius:6px;padding:2px 8px;font-family:'DM Mono',monospace;color:${farge}">G${i+1}: ${megPoeng}–${demPoeng}</span>`;
          }).join('') +
          (gamesSpilt.length < 3 && (utfSeire < 2 && motSeire < 2)
            ? `<span style="font-size:12px;background:rgba(234,179,8,.1);border-radius:6px;padding:2px 8px;color:var(--yellow)">G${gamesSpilt.length+1}: pågår</span>`
            : '') +
          `</div>`
        : '';

      let stillingHTML;
      if (erPagar && gamesSpilt.length) {
        const megSeire = gamesSpilt.filter(g => (erUtfordrer ? g.utfPoeng : g.motPoeng) > (erUtfordrer ? g.motPoeng : g.utfPoeng)).length;
        const demSeire = gamesSpilt.filter(g => (erUtfordrer ? g.motPoeng : g.utfPoeng) > (erUtfordrer ? g.utfPoeng : g.motPoeng)).length;
        stillingHTML = `Pågår · <span style="color:var(--green2);font-weight:600">${megSeire}</span>–<span style="color:var(--red2);font-weight:600">${demSeire}</span>${gamesHTML}`;
      } else if (erPagar) {
        stillingHTML = 'Akseptert — avtal tidspunkt med motstanderen';
      } else if (erMotstander) {
        stillingHTML = `⚡ ${escHtml(u.utfordrerNavn)} har utfordret deg!`;
      } else if (erUtfordrer) {
        stillingHTML = `Venter på svar · utløper om ${dagerIgjen} dag${dagerIgjen === 1 ? '' : 'er'}`;
      } else {
        const gamesAndreHTML = gamesSpilt.length
          ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">` +
            gamesSpilt.map((g, i) => {
              const farge = g.utfPoeng > g.motPoeng ? 'var(--green2)' : 'var(--red2)';
              return `<span style="font-size:12px;background:rgba(255,255,255,.06);border-radius:6px;padding:2px 8px;font-family:'DM Mono',monospace;color:${farge}">G${i+1}: ${g.utfPoeng}–${g.motPoeng}</span>`;
            }).join('') + `</div>`
          : '';
        stillingHTML = `${escHtml(u.utfordrerNavn)} utfordret ${escHtml(u.motstanderNavn)} · ${dagerIgjen}d igjen${gamesAndreHTML}`;
      }

      let knapperHTML = '';
      if (!erPagar && erMotstander) {
        knapperHTML = `<div style="display:flex;gap:8px;margin-top:10px">
          <button class="knapp knapp-gronn knapp-liten" style="flex:1;font-family:'DM Sans',sans-serif;font-size:15px"
            onclick="aksepterUtfordringOgOppdater('${u.id}')">✓ Aksepter</button>
          <button class="knapp knapp-fare knapp-liten" style="font-family:'DM Sans',sans-serif;font-size:15px"
            onclick="avvisUtfordringOgOppdater('${u.id}')"><span style="font-size:1.5em">🐥</span> Avslå</button>
        </div>`;
      } else if (erPagar && (erUtfordrer || erMotstander) && utfSeire < 2 && motSeire < 2) {
        knapperHTML = `<div style="margin-top:10px">
          <button class="knapp knapp-primaer knapp-liten" style="width:100%;font-family:'DM Sans',sans-serif;font-size:15px"
            onclick="registrerUtfordringGame('${u.id}','${erUtfordrer}')">+ Registrer game</button>
        </div>`;
      } else if (!erPagar && erUtfordrer) {
        knapperHTML = `<div style="margin-top:10px">
          <button class="knapp knapp-omriss knapp-liten" style="font-family:'DM Sans',sans-serif;font-size:14px"
            onclick="trekkTilbakeOgOppdater('${u.id}')">Trekk tilbake</button>
        </div>`;
      }

      const erInvolvert = erUtfordrer || erMotstander;
      const kortStil    = erMotstander && !erPagar
        ? 'border-color:rgba(234,179,8,.4);'
        : erInvolvert ? '' : 'opacity:0.75;';

      return `<div class="${erPagar ? 'utf-aktiv-kort' : 'utf-venter-kort'}" style="${kortStil}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">
          <div class="utf-kort-tittel">${escHtml(u.utfordrerNavn)} vs ${escHtml(u.motstanderNavn)}</div>
          <div class="${erPagar ? 'utf-status-pagar' : 'utf-status-venter'}">${erPagar ? 'Pågår' : 'Venter'}</div>
        </div>
        <div class="utf-kort-sub">${stillingHTML}</div>
        ${knapperHTML}
      </div>`;
    }).join('');
  } catch (e) {
    if (el) el.innerHTML = '<div class="tom-tilstand-liten">Kunne ikke laste utfordringer.</div>';
  }
}

function _visSingelRanking(spillere) {
  const el = document.getElementById('utf-singel-ranking');
  if (!el) return;

  const medSingel = spillere.slice().sort((a, b) => _hentUtfordrerRating(b) - _hentUtfordrerRating(a));

  if (!medSingel.length) {
    el.innerHTML = '<div class="tom-tilstand-liten" style="text-align:center">Ingen spillere registrert</div>';
    return;
  }

  el.innerHTML = medSingel.map((s, i) => {
    const plass     = i + 1;
    const ini       = lagInitialer(s.navn);
    const rating    = _hentUtfordrerRating(s);
    const kamper    = s.singelKamper ?? 0;
    const harSingel = kamper >= UTF_MIN_SINGEL_KAMPER;
    const nivaaKl   = getNivaaKlasse(rating);
    const kildeHTML = harSingel
      ? `<span style="font-size:11px;color:var(--muted2)">${kamper} singelkamper</span>`
      : `<span style="font-size:11px;color:var(--muted2)">🏸 Americano-rating (${kamper}/${UTF_MIN_SINGEL_KAMPER} kamper)</span>`;
    return `<div class="lb-rad ${nivaaKl}" style="cursor:pointer">
      <div class="lb-plass${plass <= 3 ? ' topp3' : ''}" onclick="apneGlobalProfil('${s.id}')">${plass}</div>
      <div class="lb-avatar" onclick="apneGlobalProfil('${s.id}')" style="cursor:pointer">${escHtml(ini)}</div>
      <div style="flex:1;cursor:pointer" onclick="apneGlobalProfil('${s.id}')">
        <div class="lb-navn">${escHtml(s.navn ?? 'Ukjent')}</div>
        ${kildeHTML}
      </div>
      <div style="text-align:right;flex-shrink:0">${getNivaaRatingHTML(rating)}</div>
    </div>`;
  }).join('');
}

async function _lastSisteResultater(klubbId, spillere) {
  const el = document.getElementById('utf-siste-resultater');
  if (!el || !db || !klubbId) return;

  try {
    const [ferdigSnap, avvistSnap] = await Promise.all([
      getDocs(query(collection(db, SAM.UTFORDRINGER), where('klubbId', '==', klubbId), where('status', '==', UTF_STATUS.FERDIG))),
      getDocs(query(collection(db, SAM.UTFORDRINGER), where('klubbId', '==', klubbId), where('status', '==', UTF_STATUS.AVVIST))),
    ]);

    const ferdig = ferdigSnap.docs.map(d => ({ id: d.id, ...d.data(), _type: 'ferdig' }));
    const avvist = avvistSnap.docs.map(d => ({ id: d.id, ...d.data(), _type: 'avvist' }));

    const alle = [...ferdig, ...avvist]
      .sort((a, b) => (b.avsluttet?.toMillis?.() ?? 0) - (a.avsluttet?.toMillis?.() ?? 0))
      .slice(0, 5);

    if (!alle.length) {
      el.innerHTML = '<div class="tom-tilstand-liten" style="text-align:center">Ingen resultater ennå</div>';
      return;
    }

    el.innerHTML = alle.map(u => {
      const dato = u.avsluttet?.toDate?.()?.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short' }) ?? '';
      if (u._type === 'avvist') {
        return `<div class="utf-res-rad">
          <div style="flex:1">
            <div style="font-size:14px;color:var(--white)">${escHtml(u.motstanderNavn)} er redd for ${escHtml(u.utfordrerNavn)}! <span style="font-size:2em">🐥</span></div>
            <div style="font-size:12px;color:var(--muted2)">${dato}</div>
          </div>
          <div class="utf-res-delta-nil">—</div>
        </div>`;
      }
      const utfSeire = (u.games ?? []).filter(g => g.utfPoeng > g.motPoeng).length;
      const motSeire = (u.games ?? []).filter(g => g.motPoeng > g.utfPoeng).length;
      const utfVant  = utfSeire > motSeire;
      const vinner   = utfVant ? u.utfordrerNavn : u.motstanderNavn;
      const taper    = utfVant ? u.motstanderNavn : u.utfordrerNavn;
      const vSeire   = utfVant ? utfSeire : motSeire;
      const tSeire   = utfVant ? motSeire : utfSeire;

      const gamesHTML = (u.games ?? []).map((g, i) => {
        const vinnerPoeng = utfVant ? g.utfPoeng : g.motPoeng;
        const taperPoeng  = utfVant ? g.motPoeng : g.utfPoeng;
        const vantDette   = vinnerPoeng > taperPoeng;
        return `<span style="font-family:'DM Mono',monospace;font-size:12px;color:${vantDette ? 'var(--green2)' : 'var(--muted2)'};margin-right:8px">${vinnerPoeng}–${taperPoeng}</span>`;
      }).join('');

      return `<div class="utf-res-rad">
        <div style="flex:1">
          <div style="font-size:14px;color:var(--white)">
            ${escHtml(vinner)} <span style="color:var(--green2);font-weight:600">${vSeire}</span> – <span style="color:var(--red2);font-weight:600">${tSeire}</span> ${escHtml(taper)}
          </div>
          <div style="margin-top:3px">${gamesHTML}</div>
          <div style="font-size:12px;color:var(--muted2);margin-top:2px">${dato}</div>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = '<div class="tom-tilstand-liten">Kunne ikke laste resultater.</div>';
  }
}

// ════════════════════════════════════════════════════════
// NULLSTILL SISTE RESULTATER (admin)
// Sletter kun ferdig/avviste utfordringer — aktive (venter/akseptert) berøres ikke.
// ════════════════════════════════════════════════════════
export async function nullstillSisteResultater() {
  const klubbId = _getAktivKlubbId();
  if (!db || !klubbId) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }
  visMelding('Nullstiller resultater… vennligst vent.', 'advarsel');

  try {
    const BATCH_MAKS = 400;
    const statuserSomSlettes = [UTF_STATUS.FERDIG, UTF_STATUS.AVVIST];
    let batch = writeBatch(db);
    let teller = 0;

    for (const status of statuserSomSlettes) {
      const snap = await getDocs(
        query(collection(db, SAM.UTFORDRINGER),
          where('klubbId', '==', klubbId),
          where('status',  '==', status)
        )
      );
      for (const d of snap.docs) {
        batch.delete(d.ref);
        teller++;
        if (teller >= BATCH_MAKS) { await batch.commit(); batch = writeBatch(db); teller = 0; }
      }
    }
    if (teller > 0) await batch.commit();

    visMelding('Siste resultater er nullstilt!');
    // Oppdater visningen umiddelbart
    const el = document.getElementById('utf-siste-resultater');
    if (el) el.innerHTML = '<div class="tom-tilstand-liten" style="text-align:center">Ingen resultater ennå</div>';
  } catch (e) {
    visFBFeil('Feil ved nullstilling av resultater: ' + (e?.message ?? e));
  }
}
window.nullstillSisteResultater = nullstillSisteResultater;

// ════════════════════════════════════════════════════════
// UTFORDRER-SEKSJON I GLOBAL-PROFIL
// Kalles fra global-profil.js etter navigering
// ════════════════════════════════════════════════════════
export async function visUtfordrerSeksjon(motstanderSpiller) {
  const el = document.getElementById('utf-seksjon');
  if (!el) return;

  const klubbId        = _getAktivKlubbId();
  const aktivSpillerId = _getAktivSpillerId();

  if (!klubbId || !aktivSpillerId || aktivSpillerId === motstanderSpiller.id) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.innerHTML = '<div class="kampstat-laster">Sjekker utfordringer…</div>';

  let utfordrerSpiller;
  try {
    const snap = await getDoc(doc(db, SAM.SPILLERE, aktivSpillerId));
    if (!snap.exists()) { el.innerHTML = ''; return; }
    utfordrerSpiller = { id: snap.id, ...snap.data() };
  } catch (e) {
    el.innerHTML = '';
    return;
  }

  const utfordringer = await _hentUtfordringerForSpiller(aktivSpillerId, klubbId);
  const mellomDisse  = utfordringer.filter(u =>
    (u.utfordrerIds === aktivSpillerId && u.motstanderId === motstanderSpiller.id) ||
    (u.motstanderId === aktivSpillerId && u.utfordrerIds === motstanderSpiller.id)
  );
  const aktiv = mellomDisse.find(u =>
    u.status === UTF_STATUS.VENTER || u.status === UTF_STATUS.AKSEPTERT
  );

  const { ok: kanSende, grunn } = await _kanUtfordre(utfordrerSpiller, motstanderSpiller, klubbId);

  let html = `<div class="seksjon-etikett" style="margin-top:16px">⚔️ Utfordrermodusen</div>`;

  if (aktiv) {
    const erUtfordrer = aktiv.utfordrerIds === aktivSpillerId;
    const statusTekst = aktiv.status === UTF_STATUS.VENTER
      ? (erUtfordrer ? '⏳ Venter på svar…' : '⚡ Du er utfordret!')
      : '🎾 Pågår — Best av 3';

    const gamesHTML = (aktiv.games ?? []).map((g, i) =>
      `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:13px;color:var(--muted2);width:52px">Game ${i + 1}</div>
        <div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:700;flex:1;text-align:center">
          ${erUtfordrer ? g.utfPoeng : g.motPoeng} — ${erUtfordrer ? g.motPoeng : g.utfPoeng}
        </div>
      </div>`
    ).join('');

    const gamesVunnet = (aktiv.games ?? []).filter(g =>
      erUtfordrer ? g.utfPoeng > g.motPoeng : g.motPoeng > g.utfPoeng
    ).length;
    const gamesTapt = (aktiv.games ?? []).length - gamesVunnet;

    html += `<div class="kort"><div class="kort-innhold">
      <div style="font-size:16px;font-weight:600;margin-bottom:8px">${statusTekst}</div>
      ${aktiv.games?.length ? `
        <div style="font-size:13px;color:var(--muted2);margin-bottom:8px">Stilling: ${gamesVunnet}–${gamesTapt}</div>
        ${gamesHTML}
      ` : ''}
      <div style="display:flex;gap:8px;margin-top:12px">
        ${aktiv.status === UTF_STATUS.VENTER && !erUtfordrer ? `
          <button class="knapp knapp-gronn knapp-liten" style="flex:1;font-family:'DM Sans',sans-serif;font-size:16px"
            onclick="aksepterUtfordring('${aktiv.id}')">✓ Aksepter</button>
          <button class="knapp knapp-fare knapp-liten" style="font-family:'DM Sans',sans-serif;font-size:16px"
            onclick="avvisUtfordring('${aktiv.id}')">✗ Avvis</button>
        ` : ''}
        ${aktiv.status === UTF_STATUS.AKSEPTERT && (aktiv.games ?? []).length < 3 ? `
          <button class="knapp knapp-primaer knapp-liten" style="flex:1;font-family:'DM Sans',sans-serif;font-size:16px"
            onclick="registrerUtfordringGame('${aktiv.id}','${erUtfordrer}')">+ Registrer game</button>
        ` : ''}
        ${erUtfordrer && aktiv.status === UTF_STATUS.VENTER ? `
          <button class="knapp knapp-omriss knapp-liten" style="font-family:'DM Sans',sans-serif;font-size:15px"
            onclick="trekkTilbakeUtfordring('${aktiv.id}')">Trekk tilbake</button>
        ` : ''}
      </div>
    </div></div>`;
  } else if (kanSende) {
    html += `<div class="kort"><div class="kort-innhold">
      <div style="font-size:15px;color:var(--muted2);margin-bottom:12px">
        Best av 3 games til 11 poeng · K-faktor ${UTF_K_FAKTOR}
      </div>
      <button class="knapp knapp-primaer" style="font-family:'DM Sans',sans-serif;font-size:17px;letter-spacing:0"
        onclick="sendUtfordring('${motstanderSpiller.id}')">
        ⚔️ Utfordre ${escHtml(motstanderSpiller.navn ?? 'spiller')}
      </button>
    </div></div>`;
  } else {
    html += `<div class="kort"><div class="kort-innhold">
      <div style="font-size:15px;color:var(--muted2)">${escHtml(grunn ?? 'Kan ikke utfordre nå.')}</div>
    </div></div>`;
  }

  const ferdig = mellomDisse.filter(u => u.status === UTF_STATUS.FERDIG);
  if (ferdig.length > 0) {
    html += `<div class="seksjon-etikett" style="margin-top:12px">Historikk mot ${escHtml(motstanderSpiller.navn ?? 'spiller')}</div>
    <div class="kort"><div class="kort-innhold" style="padding:0 16px">`;
    ferdig.sort((a, b) => (b.avsluttet?.toMillis?.() ?? 0) - (a.avsluttet?.toMillis?.() ?? 0))
      .forEach(u => {
        const erUtfordrer = u.utfordrerIds === aktivSpillerId;
        const gamesVunnet = (u.games ?? []).filter(g =>
          erUtfordrer ? g.utfPoeng > g.motPoeng : g.motPoeng > g.utfPoeng
        ).length;
        const gamesTotal = (u.games ?? []).length;
        const vant       = gamesVunnet > gamesTotal / 2;
        const dato       = u.avsluttet?.toDate?.()?.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short' }) ?? '';
        html += `<div class="historikk-rad">
          <div style="flex:1">${vant ? '🏆 Seier' : '❌ Tap'} ${gamesVunnet}–${gamesTotal - gamesVunnet}</div>
          <div style="font-size:13px;color:var(--muted2)">${dato}</div>
        </div>`;
      });
    html += `</div></div>`;
  }

  el.innerHTML = html;
}

// ════════════════════════════════════════════════════════
// WINDOW-FUNKSJONER
// ════════════════════════════════════════════════════════
window.sendUtfordring = async function(motstanderId) {
  const klubbId        = _getAktivKlubbId();
  const aktivSpillerId = _getAktivSpillerId();
  if (!klubbId || !aktivSpillerId || !db) return;

  try {
    const [utfSnap, motSnap] = await Promise.all([
      getDoc(doc(db, SAM.SPILLERE, aktivSpillerId)),
      getDoc(doc(db, SAM.SPILLERE, motstanderId)),
    ]);
    if (!utfSnap.exists() || !motSnap.exists()) return;
    const utfSpiller = { id: utfSnap.id, ...utfSnap.data() };
    const motSpiller = { id: motSnap.id, ...motSnap.data() };

    const { ok, grunn } = await _kanUtfordre(utfSpiller, motSpiller, klubbId);
    if (!ok) { visMelding(grunn, 'advarsel'); return; }

    await _sendUtfordring(utfSpiller, motSpiller, klubbId);
    visMelding(`Utfordring sendt til ${motSpiller.navn}!`);
    await visUtfordrerSeksjon(motSpiller);
  } catch (e) {
    visFBFeil('Kunne ikke sende utfordring: ' + (e?.message ?? e));
  }
};

window.aksepterUtfordring = async function(utfordringId) {
  if (!db) return;
  try {
    await updateDoc(doc(db, SAM.UTFORDRINGER, utfordringId), { status: UTF_STATUS.AKSEPTERT });
    visMelding('Utfordring akseptert! Avtal tid med motstanderen.');
    const motstanderId = document.getElementById('utf-seksjon')?.dataset?.motstanderId;
    if (motstanderId) {
      const snap = await getDoc(doc(db, SAM.SPILLERE, motstanderId));
      if (snap.exists()) await visUtfordrerSeksjon({ id: snap.id, ...snap.data() });
    }
  } catch (e) {
    visFBFeil('Feil ved aksept: ' + (e?.message ?? e));
  }
};

window.avvisUtfordring = async function(utfordringId) {
  if (!db) return;
  try {
    await updateDoc(doc(db, SAM.UTFORDRINGER, utfordringId), { status: UTF_STATUS.AVVIST, avsluttet: serverTimestamp() });
    visMelding('Utfordring avvist. 🐥');
    const motstanderId = document.getElementById('utf-seksjon')?.dataset?.motstanderId;
    if (motstanderId) {
      const snap = await getDoc(doc(db, SAM.SPILLERE, motstanderId));
      if (snap.exists()) await visUtfordrerSeksjon({ id: snap.id, ...snap.data() });
    }
  } catch (e) {
    visFBFeil('Feil ved avvisning: ' + (e?.message ?? e));
  }
};

window.aksepterUtfordringOgOppdater = async function(utfordringId) {
  if (!db) return;
  try {
    await updateDoc(doc(db, SAM.UTFORDRINGER, utfordringId), { status: UTF_STATUS.AKSEPTERT });
    visMelding('Utfordring akseptert! Avtal tid med motstanderen.');
    await visUtfordrerSkjerm();
  } catch (e) { visFBFeil('Feil ved aksept: ' + (e?.message ?? e)); }
};

window.avvisUtfordringOgOppdater = async function(utfordringId) {
  if (!db) return;
  try {
    await updateDoc(doc(db, SAM.UTFORDRINGER, utfordringId), { status: UTF_STATUS.AVVIST, avsluttet: serverTimestamp() });
    visMelding('Utfordring avslått. 🐥');
    await visUtfordrerSkjerm();
  } catch (e) { visFBFeil('Feil ved avvisning: ' + (e?.message ?? e)); }
};

window.trekkTilbakeOgOppdater = async function(utfordringId) {
  if (!db) return;
  try {
    await updateDoc(doc(db, SAM.UTFORDRINGER, utfordringId), { status: UTF_STATUS.UTLOPT, avsluttet: serverTimestamp() });
    visMelding('Utfordring trukket tilbake.');
    await visUtfordrerSkjerm();
  } catch (e) { visFBFeil('Feil: ' + (e?.message ?? e)); }
};

window.trekkTilbakeUtfordring = async function(utfordringId) {
  if (!db) return;
  try {
    await updateDoc(doc(db, SAM.UTFORDRINGER, utfordringId), { status: UTF_STATUS.UTLOPT, avsluttet: serverTimestamp() });
    visMelding('Utfordring trukket tilbake.');
    const motstanderId = document.getElementById('utf-seksjon')?.dataset?.motstanderId;
    if (motstanderId) {
      const snap = await getDoc(doc(db, SAM.SPILLERE, motstanderId));
      if (snap.exists()) await visUtfordrerSeksjon({ id: snap.id, ...snap.data() });
    }
  } catch (e) { visFBFeil('Feil: ' + (e?.message ?? e)); }
};

// ════════════════════════════════════════════════════════
// POENG-PICKER FOR GAME-MODAL
// ════════════════════════════════════════════════════════
function _utfBuildPickerGrid(felt) {
  const picker = document.getElementById(`utf-pp-${felt}`);
  if (!picker) return;
  const gjeldende = parseInt(picker.dataset.valgt ?? '-1');
  picker.innerHTML = '';
  for (let n = 0; n <= 15; n++) {
    const el = document.createElement('div');
    el.className = 'poeng-picker-tall' + (n === gjeldende ? ' valgt' : '');
    el.textContent = n;
    el.onclick = (e) => { e.stopPropagation(); _utfVelgPoeng(felt, n); };
    picker.appendChild(el);
  }
}

window.utfApnePicker = function(felt) {
  if (!document.getElementById('poeng-picker-css')) {
    const s = document.createElement('style');
    s.id = 'poeng-picker-css';
    s.textContent = `
      .poeng-velger-boks{cursor:pointer;background:var(--card2);border:1.5px solid var(--border);border-radius:10px;padding:15px 12px;font-size:39px;font-weight:600;text-align:center;color:var(--white);min-height:78px;display:flex;align-items:center;justify-content:center;transition:border-color .15s;user-select:none}
      .poeng-velger-boks.aktiv{border-color:var(--blue,#378ADD)}
      .poeng-picker{margin-top:8px;display:grid;grid-template-columns:repeat(8,1fr);gap:8px}
      .poeng-picker-tall{cursor:pointer;border-radius:6px;padding:12px 3px;text-align:center;font-size:23px;font-weight:500;border:.5px solid var(--border);background:var(--card2);color:var(--white);transition:background .1s;user-select:none}
      .poeng-picker-tall.valgt{background:var(--blue,#378ADD);border-color:var(--blue,#378ADD);color:#fff}
    `;
    document.head.appendChild(s);
  }
  const annet  = felt === 'p1' ? 'p2' : 'p1';
  const annenP = document.getElementById(`utf-pp-${annet}`);
  if (annenP) annenP.style.display = 'none';
  document.getElementById(`utf-pvb-${annet}`)?.classList.remove('aktiv');

  const picker = document.getElementById(`utf-pp-${felt}`);
  const boks   = document.getElementById(`utf-pvb-${felt}`);
  if (!picker || !boks) return;
  const erApen = picker.style.display !== 'none';
  if (erApen) {
    picker.style.display = 'none';
    boks.classList.remove('aktiv');
  } else {
    _utfBuildPickerGrid(felt);
    picker.style.display = 'grid';
    boks.classList.add('aktiv');
  }
};

function _utfVelgPoeng(felt, verdi) {
  const boks   = document.getElementById(`utf-pvb-${felt}`);
  const picker = document.getElementById(`utf-pp-${felt}`);
  if (boks)   boks.textContent = verdi;
  if (picker) { picker.dataset.valgt = verdi; picker.style.display = 'none'; }
  if (boks)   boks.classList.remove('aktiv');
  document.getElementById('utf-game-feil').textContent = '';

  const annet       = felt === 'p1' ? 'p2' : 'p1';
  const annetPicker = document.getElementById(`utf-pp-${annet}`);
  if (annetPicker && annetPicker.dataset.valgt == null) {
    setTimeout(() => window.utfApnePicker(annet), 60);
  }
}

function _utfResetModal(gameNr, stilling) {
  ['p1','p2'].forEach(felt => {
    const boks   = document.getElementById(`utf-pvb-${felt}`);
    const picker = document.getElementById(`utf-pp-${felt}`);
    if (boks)   { boks.textContent = '–'; boks.classList.remove('aktiv'); }
    if (picker) { picker.style.display = 'none'; delete picker.dataset.valgt; }
  });
  document.getElementById('utf-game-feil').textContent = '';
  const tittel = document.getElementById('utf-game-tittel');
  if (tittel) tittel.textContent = `Registrer game ${gameNr}`;
  const stillingEl = document.getElementById('utf-game-stilling');
  if (stillingEl) stillingEl.textContent = stilling ?? '';
}

function _utfHentVerdi(felt) {
  const picker    = document.getElementById(`utf-pp-${felt}`);
  const boks      = document.getElementById(`utf-pvb-${felt}`);
  const fraPicker = picker?.dataset?.valgt;
  if (fraPicker != null) return parseInt(fraPicker);
  const fraBoks = parseInt(boks?.textContent);
  return isNaN(fraBoks) ? NaN : fraBoks;
}

window.registrerUtfordringGame = async function(utfordringId, erUtfordrer) {
  const modal = document.getElementById('modal-utf-game');
  if (!modal || !db) return;
  modal.dataset.utfordringId = utfordringId;
  modal.dataset.erUtfordrer  = String(erUtfordrer);

  try {
    const snap = await getDoc(doc(db, SAM.UTFORDRINGER, utfordringId));
    if (snap.exists()) {
      const u        = snap.data();
      const gNr      = (u.games ?? []).length + 1;
      const utfSeire = (u.games ?? []).filter(g => g.utfPoeng > g.motPoeng).length;
      const motSeire = (u.games ?? []).filter(g => g.motPoeng > g.utfPoeng).length;
      const erUtf    = erUtfordrer === true || erUtfordrer === 'true';
      const megSeire = erUtf ? utfSeire : motSeire;
      const demSeire = erUtf ? motSeire : utfSeire;
      const nav1 = document.getElementById('utf-game-navn1');
      const nav2 = document.getElementById('utf-game-navn2');
      if (nav1) nav1.textContent = erUtf ? (u.utfordrerNavn ?? 'Deg') : (u.motstanderNavn ?? 'Deg');
      if (nav2) nav2.textContent = erUtf ? (u.motstanderNavn ?? 'Motstander') : (u.utfordrerNavn ?? 'Motstander');
      _utfResetModal(gNr, gNr > 1 ? `Stilling: ${megSeire}–${demSeire}` : 'Best av 3 · til 11 poeng');
    }
  } catch (_) {
    _utfResetModal(1, 'Best av 3 · til 11 poeng');
  }

  modal.style.display = 'flex';
  setTimeout(() => window.utfApnePicker('p1'), 80);
};

window.lukkUtfordringGameModal = function() {
  const modal = document.getElementById('modal-utf-game');
  if (modal) modal.style.display = 'none';
  ['p1','p2'].forEach(felt => {
    const picker = document.getElementById(`utf-pp-${felt}`);
    if (picker) { picker.style.display = 'none'; delete picker.dataset.valgt; }
    document.getElementById(`utf-pvb-${felt}`)?.classList.remove('aktiv');
  });
};

window.bekreftUtfordringGame = async function() {
  const modal        = document.getElementById('modal-utf-game');
  const utfordringId = modal?.dataset?.utfordringId;
  const erUtfordrer  = modal?.dataset?.erUtfordrer === 'true';
  const feilEl       = document.getElementById('utf-game-feil');

  const p1 = _utfHentVerdi('p1');
  const p2 = _utfHentVerdi('p2');

  if (isNaN(p1) || isNaN(p2) || p1 < 0 || p2 < 0) {
    feilEl.textContent = 'Fyll inn poeng for begge spillere.'; return;
  }
  if (p1 === p2) {
    feilEl.textContent = 'Uavgjort er ikke mulig — én spiller må vinne.'; return;
  }
  const vinnende = Math.max(p1, p2);
  const tapende  = Math.min(p1, p2);
  if (vinnende < 11) { feilEl.textContent = 'Vinnerpoeng må være minst 11.'; return; }
  if (tapende === 14 && vinnende === 15) {
    // Gyldig golden point
  } else if (vinnende - tapende < 2) {
    feilEl.textContent = 'Vinneren må lede med minst 2 poeng.'; return;
  }

  feilEl.textContent = '';

  try {
    const snap = await getDoc(doc(db, SAM.UTFORDRINGER, utfordringId));
    if (!snap.exists()) { feilEl.textContent = 'Utfordring ikke funnet.'; return; }
    const u = snap.data();

    const utfPoeng = erUtfordrer ? p1 : p2;
    const motPoeng = erUtfordrer ? p2 : p1;
    const nyeGames = [...(u.games ?? []), { utfPoeng, motPoeng }];

    const utfSeire = nyeGames.filter(g => g.utfPoeng > g.motPoeng).length;
    const motSeire = nyeGames.filter(g => g.motPoeng > g.utfPoeng).length;
    const erFerdig = utfSeire === 2 || motSeire === 2;

    const oppdatering = { games: nyeGames };

    if (erFerdig) {
      oppdatering.status    = UTF_STATUS.FERDIG;
      oppdatering.avsluttet = serverTimestamp();

      const utfRating = u.utfordrerRating ?? STARTRATING;
      const motRating = u.motstanderRating ?? STARTRATING;
      const utfVant   = utfSeire > motSeire;

      const utfDelta = _beregnUtfordringRating(utfRating, motRating, utfVant);
      const motDelta = _beregnUtfordringRating(motRating, utfRating, !utfVant);

      const [utfSpillerSnap, motSpillerSnap] = await Promise.all([
        getDoc(doc(db, SAM.SPILLERE, u.utfordrerIds)),
        getDoc(doc(db, SAM.SPILLERE, u.motstanderId)),
      ]);

      const batch = writeBatch(db);
      batch.update(doc(db, SAM.UTFORDRINGER, utfordringId), oppdatering);

      if (utfSpillerSnap.exists()) {
        const d = utfSpillerSnap.data();
        const utfRatingFoer  = d.singelRating ?? STARTRATING;
        const utfRatingEtter = Math.max(1, utfRatingFoer + utfDelta);
        batch.update(doc(db, SAM.SPILLERE, u.utfordrerIds), {
          singelRating: utfRatingEtter,
          singelKamper: (d.singelKamper ?? 0) + 1,
        });
        batch.set(doc(collection(db, SAM.SINGEL_HISTORIKK)), {
          spillerId:      u.utfordrerIds,
          klubbId:        u.klubbId,
          motstanderNavn: u.motstanderNavn,
          resultat:       utfVant ? 'seier' : 'tap',
          ratingFoer:     utfRatingFoer,
          ratingEtter:    utfRatingEtter,
          endring:        utfDelta,
          dato:           serverTimestamp(),
        });
      }

      if (motSpillerSnap.exists()) {
        const d = motSpillerSnap.data();
        const motRatingFoer  = d.singelRating ?? STARTRATING;
        const motRatingEtter = Math.max(1, motRatingFoer + motDelta);
        batch.update(doc(db, SAM.SPILLERE, u.motstanderId), {
          singelRating: motRatingEtter,
          singelKamper: (d.singelKamper ?? 0) + 1,
        });
        batch.set(doc(collection(db, SAM.SINGEL_HISTORIKK)), {
          spillerId:      u.motstanderId,
          klubbId:        u.klubbId,
          motstanderNavn: u.utfordrerNavn,
          resultat:       !utfVant ? 'seier' : 'tap',
          ratingFoer:     motRatingFoer,
          ratingEtter:    motRatingEtter,
          endring:        motDelta,
          dato:           serverTimestamp(),
        });
      }

      await batch.commit();
      const vinnerNavn = utfVant ? u.utfordrerNavn : u.motstanderNavn;
      visMelding(`${vinnerNavn} vinner serien! 🏆`);
    } else {
      await updateDoc(doc(db, SAM.UTFORDRINGER, utfordringId), oppdatering);
      visMelding(`Game registrert. Stilling: ${utfSeire}–${motSeire}`);
    }

    if (erFerdig) {
      window.lukkUtfordringGameModal();
      if (document.getElementById('skjerm-utfordrer')?.classList.contains('active')) {
        await visUtfordrerSkjerm();
      } else {
        const motstanderId = document.getElementById('utf-seksjon')?.dataset?.motstanderId;
        if (motstanderId) {
          const motSnap = await getDoc(doc(db, SAM.SPILLERE, motstanderId));
          if (motSnap.exists()) await visUtfordrerSeksjon({ id: motSnap.id, ...motSnap.data() });
        }
      }
    } else {
      const utfSeireNy = nyeGames.filter(g => g.utfPoeng > g.motPoeng).length;
      const motSeireNy = nyeGames.filter(g => g.motPoeng > g.utfPoeng).length;
      const erUtf      = modal.dataset.erUtfordrer === 'true';
      const megSeireNy = erUtf ? utfSeireNy : motSeireNy;
      const demSeireNy = erUtf ? motSeireNy : utfSeireNy;
      _utfResetModal(nyeGames.length + 1, `Stilling: ${megSeireNy}–${demSeireNy}`);
      setTimeout(() => window.utfApnePicker('p1'), 80);
      const klubbId = _getAktivKlubbId();
      if (klubbId) await _lastAktiveUtfordringer(klubbId, window._app?.spillere ?? []);
    }
  } catch (e) {
    feilEl.textContent = 'Feil ved lagring: ' + (e?.message ?? e);
  }
};
