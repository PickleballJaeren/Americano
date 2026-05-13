// ════════════════════════════════════════════════════════
// profil.js — Økt-spillerprofil (sluttresultat-skjermen)
// Rating-diagram, øktstatistikk, historikk for aktiv økt
// ════════════════════════════════════════════════════════
import {
  db, SAM, STARTRATING,
  collection, getDocs,
  query, where,
} from './firebase.js';
import { app } from './state.js';
import { visMelding } from './ui.js';
import { lagRatingDiagram, lastProfilSingelHistorikk } from './global-profil.js';

// ── Avhengigheter injisert fra app.js ────────────────────
let _naviger = () => {};

export function profilInit(deps) {
  _naviger = deps.naviger;
  // krevAdmin og getAktivKlubbId er ikke lenger nødvendig i profil.js —
  // de brukes av ledertavle.js og utfordrer.js via egne init-funksjoner.
}

// ════════════════════════════════════════════════════════
// FANE-TILSTAND
// ════════════════════════════════════════════════════════
let _profilSpillerId    = null;
let _profilAktivFane    = 'americano';
let _profilSingelDiagram = null;

// Diagram-referanser sendt til lastProfilSingelHistorikk
const _profilDiagramRefs = {
  get profil() { return _profilSingelDiagram; },
  set profil(v) { _profilSingelDiagram = v; },
};

window.byttProfilFane = function(fane) {
  _profilAktivFane = fane;
  document.getElementById('profil-fane-americano')?.classList.toggle('modus-aktiv', fane === 'americano');
  document.getElementById('profil-fane-singel')?.classList.toggle('modus-aktiv',   fane === 'singel');
  document.getElementById('profil-innhold-americano').style.display = fane === 'americano' ? 'block' : 'none';
  document.getElementById('profil-innhold-singel').style.display    = fane === 'singel'    ? 'block' : 'none';
  if (fane === 'singel' && _profilSpillerId) {
    lastProfilSingelHistorikk(_profilSpillerId, false, _profilDiagramRefs);
  }
};

// ════════════════════════════════════════════════════════
// ÅPNE SPILLERPROFIL (fra sluttresultat-skjermen)
// ════════════════════════════════════════════════════════
let diagram = null;

export async function apneProfil(spillerId) {
  if (!spillerId) return;
  const s = (app.ratingEndringer ?? []).find(x => x.spillerId === spillerId);
  if (!s) return;

  _profilSpillerId = spillerId;
  _profilAktivFane = 'americano';
  document.getElementById('profil-fane-americano')?.classList.add('modus-aktiv');
  document.getElementById('profil-fane-singel')?.classList.remove('modus-aktiv');
  document.getElementById('profil-innhold-americano').style.display = 'block';
  document.getElementById('profil-innhold-singel').style.display    = 'none';

  document.getElementById('profil-navn').textContent   = s.navn ?? 'Ukjent';
  document.getElementById('profil-rating').textContent = s.nyRating;
  document.getElementById('profil-statistikk').innerHTML = [
    { val: '#' + s.sluttPlassering,                              lbl: 'Sluttplassering', farge: 'var(--white)' },
    { val: (s.endring >= 0 ? '+' : '') + s.endring,             lbl: 'Ratingendring',   farge: s.endring >= 0 ? 'var(--green2)' : 'var(--red2)' },
    { val: s.ratingVedStart ?? STARTRATING,                      lbl: 'Rating før',      farge: 'var(--white)' },
  ].map(b => `<div class="stat-boks">
    <div class="stat-verdi" style="color:${b.farge}">${b.val}</div>
    <div class="stat-etikett">${b.lbl}</div>
  </div>`).join('');

  // Hent ratinghistorikk
  let historikk = [];
  try {
    if (db) {
      const snap = await getDocs(
        query(collection(db, SAM.HISTORIKK), where('spillerId', '==', spillerId))
      );
      historikk = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.dato?.toMillis?.() ?? 0) - (b.dato?.toMillis?.() ?? 0));
    }
  } catch (e) {
    console.warn('Kunne ikke hente historikk:', e?.message ?? e);
  }

  const ratingData = historikk.length
    ? historikk.map(h => h.ratingEtter ?? STARTRATING)
    : [s.ratingVedStart ?? STARTRATING, s.nyRating];
  const etiketter = historikk.length
    ? historikk.map((_, i) => 'T' + (i+1))
    : ['Start', 'Nå'];

  const canvas = document.getElementById('rating-diagram');
  if (canvas) diagram = lagRatingDiagram(canvas, ratingData, etiketter, diagram);

  document.getElementById('trening-historikk').innerHTML = historikk.length
    ? [...historikk].reverse().map((h, i) => `
        <div class="historikk-rad">
          <div style="flex:1">Økt ${historikk.length - i}</div>
          <div style="font-family:'DM Mono',monospace;font-size:14px;color:var(--muted2);margin-right:8px">Plass #${h.plassering ?? '—'}</div>
          <div style="font-family:'DM Mono',monospace;font-size:16px;font-weight:600;color:${(h.endring ?? 0) >= 0 ? 'var(--green2)' : 'var(--red2)'}">
            ${(h.endring ?? 0) >= 0 ? '+' : ''}${h.endring ?? 0}
          </div>
        </div>`).join('')
    : '<div style="padding:16px;text-align:center;font-size:16px;color:var(--muted2)">Ingen historikk ennå</div>';

  _naviger('profil');
}
window.apneProfil = apneProfil;
