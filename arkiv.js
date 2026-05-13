// ════════════════════════════════════════════════════════
// arkiv.js — historikk og sletting av økter
// ════════════════════════════════════════════════════════
import {
  db, SAM,
  collection, doc, getDoc, getDocs,
  query, where, orderBy, limit,
  writeBatch, serverTimestamp,
} from './firebase.js';
import { lagBatchHjelper } from './batch-helpers.js';
import { app } from './state.js';
import { visMelding, visFBFeil, escHtml } from './ui.js';
import { renderKampRad, renderKampRadDetalj, renderMetaChips, renderTomTilstand, lagInitialer } from './render-helpers.js';
import {
  hentAlleTurneringer, beregnPuljetabell,
} from './turnering.js';
import { nullstillSesongCache, oppdaterGlobalLedertavle } from './ledertavle.js';

// ── Avhengigheter injisert fra app.js via arkivInit() ────────────────────────
let _naviger   = () => {};
let _krevAdmin = () => {};
let _getAktivKlubbId = () => null;

export function arkivInit(deps) {
  _naviger         = deps.naviger;
  _krevAdmin       = deps.krevAdmin;
  _getAktivKlubbId = deps.getAktivKlubbId;
}



// ════════════════════════════════════════════════════════
// HTML-BYGGERE — private hjelpefunksjoner for arkiv-kort
// ════════════════════════════════════════════════════════

/**
 * Bygger chevron-SVG som brukes i alle arkiv-kort.
 */
function _byggChevron() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" class="arkiv-chevron"><path d="M9 18l6-6-6-6"/></svg>`;
}

/**
 * Bygger ett økt-kort for arkiv-listen.
 */
function _byggOktKort(item) {
  const t      = item.data;
  const dato   = item.dato;
  const datoStr = dato
    ? dato.toLocaleDateString('nb-NO', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'Ukjent dato';
  const tidStr = dato
    ? dato.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' })
    : '';
  const erAktiv = t.status === 'aktiv';
  const runder  = t.gjeldendRunde ?? 1;
  const maks    = t.maksRunder    ?? '?';
  const baner   = t.antallBaner   ?? '?';

  return `<div class="kort bane-kort-klikk" style="margin-bottom:10px" data-treningid="${item.id}" onclick="apneTreningsdetaljFraDom(this)">
    <div class="kort-hode arkiv-kort-hode">
      <div class="arkiv-kort-venstre">
        <div class="arkiv-kort-tittel">Økt ${item.index}</div>
        <div class="arkiv-kort-dato">${datoStr}${tidStr ? ' • ' + tidStr : ''}</div>
      </div>
      <div class="arkiv-kort-høyre">
        <div class="${erAktiv ? 'arkiv-kort-status-aktiv' : 'arkiv-kort-status-avsl'}">${erAktiv ? '● Aktiv' : 'Avsluttet'}</div>
        <div class="arkiv-kort-meta">${baner} baner • ${runder}/${maks} runder</div>
      </div>
      ${_byggChevron()}
    </div>
  </div>`;
}

/**
 * Bygger ett turnerings-kort for arkiv-listen.
 */
function _byggTurneringKortArkiv(item) {
  const t       = item.data;
  const dato    = item.dato;
  const datoStr = dato
    ? dato.toLocaleDateString('nb-NO', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'Ukjent dato';
  const antallLag = (t.lag ?? []).length;
  const vinner    = t.rangering?.[0]?.navn ?? '?';

  return `<div class="kort bane-kort-klikk" style="margin-bottom:10px;border-color:rgba(234,179,8,.2)" data-turneringid="${item.id}" onclick="apneTurneringArkivDetalj('${item.id}')">
    <div class="kort-hode arkiv-kort-hode">
      <div class="arkiv-kort-venstre">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:18px">🏆</span>
          <div class="arkiv-turnering-tittel">${escHtml(t.navn ?? 'Turnering')}</div>
        </div>
        <div class="arkiv-kort-dato">${datoStr}</div>
      </div>
      <div class="arkiv-kort-høyre">
        <div class="arkiv-turnering-vinner">🥇 ${escHtml(vinner)}</div>
        <div class="arkiv-kort-meta">${antallLag} lag</div>
      </div>
      ${_byggChevron()}
    </div>
  </div>`;
}

export async function lastArkiv() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }
  const laster = document.getElementById('arkiv-laster');
  const liste  = document.getElementById('arkiv-liste');
  if (laster) laster.style.display = 'flex';
  if (liste)  liste.innerHTML = '';

  try {
    // Hent Americano-økter og avsluttede turneringer parallelt
    const [oktSnap, turneringer] = await Promise.all([
      getDocs(query(collection(db, SAM.TRENINGER), where('klubbId', '==', _getAktivKlubbId()), orderBy('opprettetDato', 'desc'))),
      hentAlleTurneringerAvsluttet(),
    ]);

    if (laster) laster.style.display = 'none';

    // Bygg felles liste med type-markering
    const okter = oktSnap.docs.map((d, i) => ({
      type:  'okt',
      id:    d.id,
      dato:  d.data().opprettetDato?.toDate?.() ?? new Date(0),
      index: oktSnap.docs.length - i,
      data:  d.data(),
    }));

    const tListe = turneringer.map(t => ({
      type: 'turnering',
      id:   t.id,
      dato: t.avsluttet?.toDate?.() ?? t.opprettet?.toDate?.() ?? new Date(0),
      data: t,
    }));

    // Flett og sorter etter dato, nyeste først
    const alle = [...okter, ...tListe].sort((a, b) => b.dato - a.dato);

    if (!alle.length) {
      if (liste) liste.innerHTML =
        '<div class="tom-tilstand">Ingen økter eller turneringer registrert ennå</div>';
      return;
    }

    if (liste) {
      liste.innerHTML = alle.map(item =>
        item.type === 'turnering'
          ? lagTurneringKortArkiv(item)
          : lagOktKortArkiv(item)
      ).join('');
    }
  } catch (e) {
    if (laster) laster.style.display = 'none';
    visFBFeil('Kunne ikke laste arkiv: ' + (e?.message ?? e));
  }
}
window.lastArkiv = lastArkiv;

async function hentAlleTurneringerAvsluttet() {
  const klubbId = _getAktivKlubbId();
  if (!klubbId || !db) return [];
  try {
    const snap = await getDocs(
      query(collection(db, 'turneringer'),
        where('klubbId', '==', klubbId),
        where('status', '==', 'finished'),
        orderBy('avsluttet', 'desc')
      )
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('[Arkiv] hentAlleTurneringerAvsluttet:', e?.message);
    return [];
  }
}

function lagOktKortArkiv(item) { return _byggOktKort(item); }

function lagTurneringKortArkiv(item) { return _byggTurneringKortArkiv(item); }

// ════════════════════════════════════════════════════════
// TURNERINGSDETALJ — åpne fra arkiv
// ════════════════════════════════════════════════════════
let _aktivTurneringArkivId = null;

window.apneTurneringArkivDetalj = async function(turneringId) {
  _aktivTurneringArkivId = turneringId;
  _naviger('turnering-arkiv-detalj');

  const lasterEl = document.getElementById('t-arkiv-laster');
  if (lasterEl) lasterEl.style.display = 'flex';

  try {
    const snap = await getDoc(doc(db, 'turneringer', turneringId));
    if (!snap.exists()) { visMelding('Turnering ikke funnet.', 'feil'); _naviger('arkiv'); return; }
    const t = { id: snap.id, ...snap.data() };

    if (lasterEl) lasterEl.style.display = 'none';

    document.getElementById('t-arkiv-tittel').textContent = t.navn ?? 'Turnering';
    const dato = t.avsluttet?.toDate?.() ?? t.opprettet?.toDate?.();
    document.getElementById('t-arkiv-dato').textContent = dato
      ? dato.toLocaleDateString('nb-NO', { weekday:'short', day:'numeric', month:'long', year:'numeric' })
      : '';

    // Meta-chips
    const antallPuljer = t.konfig?.antallPuljer ?? '?';
    const antallLag    = (t.lag ?? []).length;
    document.getElementById('t-arkiv-meta').innerHTML = renderMetaChips([
      { ikon: '🏐', tekst: antallLag + ' lag' },
      { ikon: '🔢', tekst: antallPuljer + ' puljer' },
    ]);

    // Rangering
    visTurneringRangering(t);

    // Puljestabeller
    visPuljeTabeller(t);

    // Sluttspillresultater
    visSluttspillResultater(t);

  } catch (e) {
    console.error('[apneTurneringArkivDetalj]', e);
    visFBFeil('Kunne ikke laste turnering: ' + (e?.message ?? e));
  }
};

function visTurneringRangering(t) {
  const el = document.getElementById('t-arkiv-rangering');
  if (!el) return;
  const rangering = t.rangering ?? [];
  if (!rangering.length) { el.innerHTML = '<div class="tom-tilstand-liten">Ingen rangering.</div>'; return; }

  const plassMedal = p => p === 1 ? '🥇' : p === 2 ? '🥈' : p === 3 ? '🥉' : '';
  const plassFarge = p => p === 1 ? 'var(--yellow)' : p <= 3 ? 'var(--accent2)' : 'var(--muted2)';

  el.innerHTML = rangering.map(r => `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="font-family:'Bebas Neue',cursive;font-size:24px;color:${plassFarge(r.plass)};width:36px;text-align:center">
        ${plassMedal(r.plass) || r.plass + '.'}
      </div>
      <div style="flex:1;font-size:17px;font-weight:${r.plass <= 3 ? 600 : 400}">${escHtml(r.navn ?? '?')}</div>
    </div>`).join('');
}

function visPuljeTabeller(t) {
  const el = document.getElementById('t-arkiv-puljer');
  if (!el) return;
  const puljer = t.puljer ?? [];
  if (!puljer.length) { el.innerHTML = '<div class="tom-tilstand-liten">Ingen puljekamper.</div>'; return; }

  const lagMap = Object.fromEntries((t.lag ?? []).map(l => [l.id, l]));
  let html = '';

  for (const p of puljer) {
    const tabell = beregnPuljetabell(p, t.lag ?? []);

    // Tabell
    html += `<div class="seksjon-etikett" style="margin-top:16px">${escHtml(p.navn)}</div>
    <div class="kort" style="margin-bottom:12px"><div class="kort-innhold" style="padding:0">
      <table style="width:100%;border-collapse:collapse;font-size:15px">
        <thead><tr style="border-bottom:1px solid var(--border)">
          <th class="th-venstre">#</th>
          <th class="th-venstre">Lag</th>
          <th class="th-center">S</th>
          <th class="th-center">T</th>
          <th class="th-center">PD</th>
          <th class="th-hoyre">PF</th>
        </tr></thead>
        <tbody>
          ${tabell.map((s, i) => {
            const lag = lagMap[s.lagId];
            const pdFarge = s.pd > 0 ? 'var(--green2)' : s.pd < 0 ? 'var(--red2)' : 'var(--muted2)';
            return `<tr class="pulje-td-rad">
              <td class="pulje-td-plass ${i < 2 ? 'topp' : 'annen'}">${i+1}</td>
              <td class="pulje-td-navn">${escHtml(lag?.navn ?? s.lagId)}</td>
              <td class="pulje-td-seire td-center">${s.seire}</td>
              <td style="padding:10px 4px;text-align:center;color:var(--muted2)">${s.tap}</td>
              <td style="padding:10px 4px;text-align:center;color:${pdFarge};font-family:'DM Mono',monospace">${s.pd > 0 ? '+' : ''}${s.pd}</td>
              <td style="padding:10px 12px 10px 4px;text-align:center;font-family:'DM Mono',monospace;color:var(--muted2)">${s.pf}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div></div>`;

    // Kamper gruppert per runde
    const runder = {};
    for (const k of (p.kamper ?? [])) {
      if (!k.ferdig) continue;
      const r = k.runde ?? 1;
      if (!runder[r]) runder[r] = [];
      runder[r].push(k);
    }

    for (const rNr of Object.keys(runder).sort((a,b) => a-b)) {
      html += `<div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted2);font-weight:600;margin:10px 0 6px">Runde ${rNr}</div>`;
      for (const k of runder[rNr]) {
        const l1 = lagMap[k.lag1Id]?.navn ?? '?';
        const l2 = lagMap[k.lag2Id]?.navn ?? '?';
        html += renderKampRad(l1, l2, k.lag1Poeng, k.lag2Poeng);
      }
    }
  }

  el.innerHTML = html;
}

function visSluttspillResultater(t) {
  const el = document.getElementById('t-arkiv-sluttspill');
  if (!el) return;
  const lagMap = Object.fromEntries((t.lag ?? []).map(l => [l.id, l]));
  const { A, B, C } = t.sluttspill ?? {};

  let html = '';

  const renderBracket = (nivaa, kamper, farge) => {
    if (!kamper?.length) return '';
    const ferdig = kamper.filter(k => k.ferdig);
    if (!ferdig.length) return '';

    let bHtml = `<div class="seksjon-etikett" style="color:${farge};margin-top:16px">${nivaa}-SLUTTSPILL</div>`;

    const runder = {};
    for (const k of ferdig) {
      const r = k.runde ?? 'Ukjent';
      if (!runder[r]) runder[r] = [];
      runder[r].push(k);
    }

    const rekkefølge = ['Åttedelsfinale','Kvartfinale','Plass 5–8','Semifinale','3. plass','7. plass','5. plass','1. plass','9. plass','17. plass'];
    const sorterte = Object.entries(runder).sort(([a],[b]) => {
      const ia = rekkefølge.indexOf(a), ib = rekkefølge.indexOf(b);
      return (ia===-1?99:ia)-(ib===-1?99:ib);
    });

    for (const [rundeNavn, kampListe] of sorterte) {
      bHtml += `<div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:${farge};font-weight:600;margin:10px 0 6px">${rundeNavn}</div>`;
      for (const k of kampListe) {
        const l1 = lagMap[k.lag1Id]?.navn ?? k.lag1Id ?? '?';
        const l2 = lagMap[k.lag2Id]?.navn ?? k.lag2Id ?? '?';
        bHtml += renderKampRad(l1, l2, k.lag1Poeng, k.lag2Poeng);
      }
    }
    return bHtml;
  };

  html += renderBracket('A', A?.kamper, 'var(--yellow)');
  html += renderBracket('B', B?.kamper, 'var(--accent2)');
  html += renderBracket('C', C?.kamper, 'var(--muted2)');

  el.innerHTML = html || '<div style="padding:16px;color:var(--muted2)">Ingen sluttspillresultater.</div>';
}

// Lagrer ID globalt — trygt mot anførselstegn-problemer i onclick
let aktivTreningDetaljId = null;
export function apneTreningsdetaljFraDom(el) {
  aktivTreningDetaljId = el.dataset.treningid;
  apneTreningsdetalj(aktivTreningDetaljId);
}
window.apneTreningsdetaljFraDom = apneTreningsdetaljFraDom;

export async function apneTreningsdetalj(treningId) {
  if (!db || !treningId) return;

  // Naviger og vis lastingsindikator
  document.getElementById('detalj-rangering').innerHTML =
    '<div class="laster"><div class="laster-snurr"></div>Laster resultater…</div>';
  document.getElementById('detalj-rating').innerHTML = '';
  document.getElementById('detalj-kamper').innerHTML =
    '<div class="laster"><div class="laster-snurr"></div>Laster kamper…</div>';
  _naviger('treningsdetalj');

  try {
    const snap = await getDoc(doc(db, SAM.TRENINGER, treningId));
    if (!snap.exists()) { visMelding('Økt ikke funnet.', 'feil'); _naviger('arkiv'); return; }
    const t       = snap.data();
    const dato    = t.opprettetDato?.toDate?.() ?? null;
    const erAktiv = t.status === 'aktiv';
    const erAuto  = t.autoAvsluttet === true;

    document.getElementById('detalj-tittel').textContent =
      erAktiv ? 'Pågående økt' : 'Avsluttet økt';
    document.getElementById('detalj-dato').textContent = dato
      ? dato.toLocaleDateString('nb-NO', { weekday:'short', day:'numeric', month:'long', year:'numeric' })
        + ' • ' + dato.toLocaleTimeString('nb-NO', { hour:'2-digit', minute:'2-digit' })
      : '';

    // Meta-chips
    const antallBaner    = t.antallBaner   ?? '?';
    const gjeldendRunde  = t.gjeldendRunde ?? 1;
    const maksRunder     = t.maksRunder    ?? '?';
    const poengPerKamp   = t.poengPerKamp  ?? '?';
    const antallSpillere = (t.baneOversikt ?? []).reduce((sum, b) => sum + (b.spillere?.length ?? 0), 0)
                         + (t.venteliste ?? []).length;
    document.getElementById('detalj-meta').innerHTML = renderMetaChips([
      { ikon: '⛳', tekst: antallBaner + ' baner' },
      { ikon: '🔄', tekst: gjeldendRunde + '/' + maksRunder + ' runder' },
      { ikon: '👥', tekst: antallSpillere + ' deltakere' },
      { ikon: '🎯', tekst: poengPerKamp + ' poeng/kamp' },
    ]);

    // Hent sluttresultater og alle kamper parallelt
    const [resSnap, kampSnap] = await Promise.all([
      getDocs(query(collection(db, SAM.RESULTATER), where('treningId', '==', treningId))),
      getDocs(query(collection(db, SAM.KAMPER),     where('treningId', '==', treningId))),
    ]);

    const resultater = resSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.sluttPlassering ?? 999) - (b.sluttPlassering ?? 999));

    const alleKamper = kampSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.rundeNr - b.rundeNr) || (a.baneNr ?? '').localeCompare(b.baneNr ?? '') || (a.kampNr - b.kampNr));

    // ── Sluttrangering og ratingendringer ────────────────
    if (resultater.length > 0) {
      document.getElementById('detalj-rangering').innerHTML = resultater.map(r => {
        const ini = lagInitialer(r.spillerNavn);
        return `<div class="lb-rad" style="cursor:default">
          <div class="lb-plass${r.sluttPlassering <= 3 ? ' topp3' : ''}">${r.sluttPlassering}</div>
          <div class="lb-avatar">${ini}</div>
          <div class="lb-navn">${escHtml(r.spillerNavn ?? 'Ukjent')}</div>
          <div style="text-align:right">
            <div style="font-family:'DM Mono',monospace;font-size:15px;color:var(--muted2)">${r.ratingEtter ?? '—'}</div>
            <div class="lb-endring ${(r.ratingEndring ?? 0) >= 0 ? 'pos' : 'neg'}">
              ${(r.ratingEndring ?? 0) >= 0 ? '+' : ''}${r.ratingEndring ?? 0}
            </div>
          </div>
        </div>`;
      }).join('');

      document.getElementById('detalj-rating').innerHTML = resultater.map(r => `
        <div class="lb-rad" style="cursor:default">
          <div style="flex:1;font-size:17px">${escHtml(r.spillerNavn ?? 'Ukjent')}</div>
          <div style="font-family:'DM Mono',monospace;font-size:15px;color:var(--muted2);margin-right:10px">
            ${r.ratingFor ?? STARTRATING} → ${r.ratingEtter ?? STARTRATING}
          </div>
          <div class="lb-endring ${(r.ratingEndring ?? 0) >= 0 ? 'pos' : 'neg'}">
            ${(r.ratingEndring ?? 0) >= 0 ? '+' : ''}${r.ratingEndring ?? 0}
          </div>
        </div>`).join('');

    } else if (erAktiv) {
      // Pågående økt — vis deltakere
      const baner = t.baneOversikt ?? [];
      const vl    = t.venteliste   ?? [];
      const runde = t.gjeldendRunde ?? 1;
      const maks  = t.maksRunder   ?? '?';
      let html = `<div style="padding:8px 0 12px;font-size:16px;color:var(--accent2);font-weight:600;display:flex;align-items:center;gap:8px">
        <div class="runde-prikk-live"></div>Runde ${runde} av ${maks} pågår
      </div>`;
      baner.forEach(bane => {
        html += `<div style="margin-bottom:14px">
          <div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted2);margin-bottom:4px">Bane ${bane.baneNr}</div>`;
        (bane.spillere ?? []).forEach(s => {
          const ini = lagInitialer(s.navn);
          html += `<div class="lb-rad" style="cursor:default;padding:8px 0">
            <div class="lb-avatar" style="width:32px;height:32px;font-size:16px">${ini}</div>
            <div style="flex:1;font-size:17px">${escHtml(s.navn ?? 'Ukjent')}</div>
            <div style="font-family:'DM Mono',monospace;font-size:15px;color:var(--yellow)">⭐ ${s.rating ?? STARTRATING}</div>
          </div>`;
        });
        html += '</div>';
      });
      if (vl.length > 0) {
        html += `<div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--orange);margin:8px 0 4px">Venteliste</div>`;
        vl.forEach(s => {
          const ini = lagInitialer(s.navn);
          html += `<div class="lb-rad" style="cursor:default;padding:8px 0">
            <div class="lb-avatar" style="width:32px;height:32px;font-size:16px;background:var(--orange)">${ini}</div>
            <div style="flex:1;font-size:17px">${escHtml(s.navn ?? 'Ukjent')}</div>
            <div style="font-family:'DM Mono',monospace;font-size:15px;color:var(--yellow)">⭐ ${s.rating ?? STARTRATING}</div>
          </div>`;
        });
      }
      document.getElementById('detalj-rangering').innerHTML = html;
      document.getElementById('detalj-rating').innerHTML =
        '<div style="padding:12px 0;text-align:center;font-size:16px;color:var(--muted2)">Ratingendringer beregnes når økten avsluttes av admin.</div>';
    } else {
      const melding = erAuto
        ? 'Økten ble avsluttet automatisk etter 5 timer. Ingen ratingendringer ble beregnet.'
        : 'Ingen resultater registrert for denne økten.';
      document.getElementById('detalj-rangering').innerHTML =
        `<div style="padding:20px;text-align:center;font-size:16px;color:var(--muted2)">${melding}</div>`;
      document.getElementById('detalj-rating').innerHTML = '';
    }

    // ── Kampresultater per runde og bane ─────────────────
    const ferdigeKamper = alleKamper.filter(k => k.ferdig && k.lag1Poeng != null && k.lag2Poeng != null);

    if (ferdigeKamper.length === 0) {
      document.getElementById('detalj-kamper').innerHTML =
        '<div style="padding:12px 0 0;text-align:center;font-size:15px;color:var(--muted2)">Ingen kampresultater registrert.</div>';
    } else {
      // Grupper: runde → bane
      const runder = {};
      ferdigeKamper.forEach(k => {
        const rNr = k.rundeNr ?? 1;
        const bNr = k.baneNr ?? 'bane?';
        if (!runder[rNr]) runder[rNr] = {};
        if (!runder[rNr][bNr]) runder[rNr][bNr] = [];
        runder[rNr][bNr].push(k);
      });

      let html = '';
      Object.keys(runder).sort((a,b) => Number(a)-Number(b)).forEach(rNr => {
        html += `<div style="font-size:13px;text-transform:uppercase;letter-spacing:2px;color:var(--accent2);font-weight:600;margin:14px 0 8px;display:flex;align-items:center;gap:8px">
          Runde ${rNr}<span style="flex:1;height:1px;background:var(--border);display:block"></span>
        </div>`;

        Object.keys(runder[rNr]).sort().forEach(bNr => {
          const baneNummer = bNr.replace('bane','');
          const kamper     = runder[rNr][bNr];
          html += `<div class="kort" style="margin-bottom:10px">
            <div class="kort-hode">
              <span style="font-family:'Bebas Neue',cursive;font-size:22px;color:var(--accent);letter-spacing:2px">${baneNummer}</span>
              <span style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted2)">Bane</span>
            </div>
            <div class="kort-innhold" style="padding:0">`;

          kamper.forEach(k => {
            html += renderKampRadDetalj(k);
          });

          html += '</div></div>';
        });
      });

      document.getElementById('detalj-kamper').innerHTML = html;
    }

  } catch (e) {
    console.error('[apneTreningsdetalj]', e);
    document.getElementById('detalj-rangering').innerHTML =
      '<div style="padding:16px;text-align:center;font-size:16px;color:var(--red2)">Feil ved lasting. Prøv igjen.</div>';
    document.getElementById('detalj-kamper').innerHTML = '';
    visFBFeil('Kunne ikke laste øktdetaljer: ' + (e?.message ?? e));
  }
}
window.apneTreningsdetalj = apneTreningsdetalj;

// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
// SLETT ØKT (admin)
// ════════════════════════════════════════════════════════
export function visSlettOktModal() {
  if (!aktivTreningDetaljId) { visMelding('Ingen økt valgt.', 'feil'); return; }
  _krevAdmin(
    'Slett økt',
    'Kun administrator kan slette lagrede økter.',
    () => {
      document.getElementById('modal-slett-okt').style.display = 'flex';
    }
  );
}
window.visSlettOktModal = visSlettOktModal;

export async function utforSlettOkt() {
  const treningId = aktivTreningDetaljId;
  if (!db || !treningId) { visMelding('Ingen økt valgt.', 'feil'); return; }
  document.getElementById('modal-slett-okt').style.display = 'none';
  visMelding('Sletter økt…', 'advarsel');

  try {
    const bh = lagBatchHjelper(db);

    // 1. Slett treningsdokumentet
    await bh.slett(doc(db, SAM.TRENINGER, treningId));

    // 2. Slett alle kamper
    const kamperSnap = await getDocs(
      query(collection(db, SAM.KAMPER), where('treningId', '==', treningId))
    );
    for (const d of kamperSnap.docs) await bh.slett(d.ref);

    // 3. Slett treningSpillere
    const tsSnap = await getDocs(
      query(collection(db, SAM.TS), where('treningId', '==', treningId))
    );
    for (const d of tsSnap.docs) await bh.slett(d.ref);

    // 4. Slett resultater
    const resSnap = await getDocs(
      query(collection(db, SAM.RESULTATER), where('treningId', '==', treningId))
    );
    for (const d of resSnap.docs) await bh.slett(d.ref);

    // 5. Slett ratinghistorikk for denne økten
    const histSnap = await getDocs(
      query(collection(db, SAM.HISTORIKK), where('treningId', '==', treningId))
    );
    for (const d of histSnap.docs) await bh.slett(d.ref);

    await bh.kommit();

    // Rydd opp sessionStorage om dette var aktiv økt
    if (sessionStorage.getItem('aktivTreningId') === treningId) {
      sessionStorage.removeItem('aktivTreningId');
      app.treningId = null;
    }
    aktivTreningDetaljId = null;

    nullstillSesongCache();
    oppdaterGlobalLedertavle();
    visMelding('Økt slettet.');
    _naviger('arkiv');
    lastArkiv();
  } catch (e) {
    console.error('[slettOkt]', e);
    visFBFeil('Feil ved sletting av økt: ' + (e?.message ?? e));
  }
}
window.utforSlettOkt = utforSlettOkt;

// ════════════════════════════════════════════════════════
// SLETT ALLE ØKTER (admin)
// ════════════════════════════════════════════════════════
export async function visSlettAlleOkterModal() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }

  _krevAdmin(
    'Slett alle økter',
    'Kun administrator kan slette alle lagrede økter.',
    async () => {
      // Tell opp antall økter før vi viser modalen
      try {
        const snap = await getDocs(collection(db, SAM.TRENINGER));
        const antall = snap.size;
        document.getElementById('slett-alle-teller').textContent =
          antall === 0
            ? 'Ingen lagrede økter funnet.'
            : `${antall} økt${antall === 1 ? '' : 'er'} vil bli slettet.`;
        document.getElementById('modal-slett-alle-okter').style.display = 'flex';
      } catch (e) {
        visFBFeil('Kunne ikke telle økter: ' + (e?.message ?? e));
      }
    }
  );
}
window.visSlettAlleOkterModal = visSlettAlleOkterModal;

export async function utforSlettAlleOkter() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }
  document.getElementById('modal-slett-alle-okter').style.display = 'none';
  visMelding('Sletter alle økter… vennligst vent.', 'advarsel');

  try {
    const bh = lagBatchHjelper(db);

    // Hent alle trenings-IDer først
    const treningSnap = await getDocs(collection(db, SAM.TRENINGER));
    const treningIds  = treningSnap.docs.map(d => d.id);

    if (treningIds.length === 0) {
      visMelding('Ingen økter å slette.', 'advarsel');
      return;
    }

    // Slett alle treningsdokumenter
    for (const d of treningSnap.docs) await bh.slett(d.ref);

    // Slett alle undersamlinger (Firestore tillater maks 10 IDer i where-in)
    const samlingerMedTreningId = [SAM.KAMPER, SAM.TS, SAM.RESULTATER, SAM.HISTORIKK];

    for (const sam of samlingerMedTreningId) {
      // Del opp i grupper på 10 (Firestore 'in'-grense)
      for (let i = 0; i < treningIds.length; i += 10) {
        const gruppe = treningIds.slice(i, i + 10);
        const snap = await getDocs(
          query(collection(db, sam), where('treningId', 'in', gruppe))
        );
        for (const d of snap.docs) await bh.slett(d.ref);
      }
    }

    await bh.kommit();

    // Rydd opp sessionStorage om aktiv økt var blant de slettede
    if (sessionStorage.getItem('aktivTreningId')) {
      sessionStorage.removeItem('aktivTreningId');
      app.treningId = null;
    }

    nullstillSesongCache();
    oppdaterGlobalLedertavle();
    visMelding(`${treningIds.length} økt${treningIds.length === 1 ? '' : 'er'} slettet.`);
    _naviger('arkiv');
    lastArkiv();
  } catch (e) {
    console.error('[slettAlleOkter]', e);
    visFBFeil('Feil ved sletting av alle økter: ' + (e?.message ?? e));
  }
}
window.utforSlettAlleOkter = utforSlettAlleOkter;