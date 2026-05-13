// ════════════════════════════════════════════════════════
// global-profil.js — Global spillerprofil
// Kampstatistikk, trend, singelhistorikk, profilskjerm
// ════════════════════════════════════════════════════════
import {
  db, SAM, STARTRATING,
  collection, doc, getDoc, getDocs,
  query, where,
} from './firebase.js';
import { app } from './state.js';
import { getNivaaLabel, getNivaaRatingHTML, beregnTrend } from './rating.js';
import { visMelding, visFBFeil, escHtml } from './ui.js';
import { lagInitialer } from './render-helpers.js';
import { setAktivSlettSpillerId } from './spillere.js';
import { visUtfordrerSeksjon } from './utfordrer.js';

// ── Avhengigheter injisert ───────────────────────────────
let _naviger = () => {};

export function globalProfilInit(deps) {
  _naviger = deps.naviger;
}

// ════════════════════════════════════════════════════════
// DIAGRAM-HJELPER (delt med profil.js)
// ════════════════════════════════════════════════════════
export function lagRatingDiagram(canvas, data, etiketter, gammeltDiagram = null) {
  if (gammeltDiagram) { try { gammeltDiagram.destroy(); } catch (_) {} }
  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: etiketter,
      datasets: [{
        data,
        borderColor:          '#eab308',
        backgroundColor:      'rgba(234,179,8,0.08)',
        borderWidth:          2.5,
        pointRadius:          5,
        pointBackgroundColor: '#eab308',
        pointBorderColor:     '#050f1f',
        pointBorderWidth:     2,
        tension:              0.35,
        fill:                 true,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 11 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 11 } } },
      },
    },
  });
}

// ════════════════════════════════════════════════════════
// KAMPSTATISTIKK
// ════════════════════════════════════════════════════════
const kampStatCache = new Map();
const KAMPSTAT_TTL_MS = 5 * 60 * 1000;

export function beregnKampStatistikk(spillerId, kamper) {
  if (!kamper?.length) return { winRate: null, avgPoints: null, bestPartner: null, form: [], totalKamper: 0 };

  let seire = 0, totaltPoeng = 0, antallKamper = 0;
  const partnerMap = {};
  const alleResultater = [];

  for (const k of kamper) {
    if (!k.ferdig || k.lag1Poeng == null || k.lag2Poeng == null) continue;
    const erLag1 = k.lag1_s1 === spillerId || k.lag1_s2 === spillerId;
    const erLag2 = k.lag2_s1 === spillerId || k.lag2_s2 === spillerId;
    if (!erLag1 && !erLag2) continue;

    const egnePoeng       = erLag1 ? k.lag1Poeng : k.lag2Poeng;
    const motstanderPoeng = erLag1 ? k.lag2Poeng : k.lag1Poeng;
    const vant            = egnePoeng > motstanderPoeng;

    totaltPoeng += egnePoeng;
    antallKamper++;
    if (vant) seire++;
    alleResultater.push({ vant, dato: k.dato ?? null });

    const partnerId = erLag1
      ? (k.lag1_s1 === spillerId ? k.lag1_s2 : k.lag1_s1)
      : (k.lag2_s1 === spillerId ? k.lag2_s2 : k.lag2_s1);
    const partnerNavn = erLag1
      ? (k.lag1_s1 === spillerId ? k.lag1_s2_navn : k.lag1_s1_navn)
      : (k.lag2_s1 === spillerId ? k.lag2_s2_navn : k.lag2_s1_navn);

    if (partnerId) {
      if (!partnerMap[partnerId]) partnerMap[partnerId] = { navn: partnerNavn ?? 'Ukjent', seire: 0, kamper: 0 };
      partnerMap[partnerId].kamper++;
      if (vant) partnerMap[partnerId].seire++;
    }
  }

  if (antallKamper === 0) return { winRate: null, avgPoints: null, bestPartner: null, form: [], totalKamper: 0 };

  const winRate   = Math.round((seire / antallKamper) * 100);
  const avgPoints = Math.round((totaltPoeng / antallKamper) * 10) / 10;
  const form      = alleResultater.slice(-5).reverse().map(r => r.vant ? 'W' : 'L');

  let bestPartner = null, bestWR = -1;
  for (const [id, p] of Object.entries(partnerMap)) {
    if (p.kamper < 2) continue;
    const wr = p.seire / p.kamper;
    if (wr > bestWR) { bestWR = wr; bestPartner = { id, navn: p.navn, winRate: Math.round(wr * 100), kamper: p.kamper }; }
  }
  if (!bestPartner && Object.keys(partnerMap).length > 0) {
    const [id, p] = Object.entries(partnerMap).sort((a, b) => b[1].kamper - a[1].kamper)[0];
    bestPartner = { id, navn: p.navn, winRate: Math.round((p.seire / p.kamper) * 100), kamper: p.kamper };
  }

  return { winRate, avgPoints, bestPartner, form, totalKamper: antallKamper };
}

async function hentKampStatistikk(spillerId) {
  const cached = kampStatCache.get(spillerId);
  if (cached && (Date.now() - cached.hentetMs) < KAMPSTAT_TTL_MS) return cached.stat;

  let kamper = [];
  try {
    const [s1, s2, s3, s4] = await Promise.all([
      getDocs(query(collection(db, SAM.KAMPER), where('lag1_s1', '==', spillerId), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag1_s2', '==', spillerId), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag2_s1', '==', spillerId), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag2_s2', '==', spillerId), where('ferdig', '==', true))),
    ]);
    const sett = new Map();
    for (const snap of [s1, s2, s3, s4]) snap.docs.forEach(d => sett.set(d.id, { id: d.id, ...d.data() }));
    kamper = [...sett.values()];
  } catch (e) {
    console.warn('[KampStat] Henting feilet:', e?.message ?? e);
    return { winRate: null, avgPoints: null, bestPartner: null };
  }

  const stat = beregnKampStatistikk(spillerId, kamper);
  kampStatCache.set(spillerId, { stat, hentetMs: Date.now() });
  return stat;
}

function visKampStatistikk(stat, trendData = null) {
  const el = document.getElementById('global-kampstat-innhold');
  if (!el) return;

  if (stat.winRate === null) {
    el.innerHTML = `<div class="kampstat-laster">Ingen kampdata tilgjengelig ennå</div>`;
    return;
  }

  const wrFarge = stat.winRate >= 60 ? 'var(--green2)' : stat.winRate >= 40 ? 'var(--yellow)' : 'var(--red2)';

  let trendHTML = '';
  if (trendData) {
    const { trend, change } = trendData;
    const pil   = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→';
    const farge = trend === 'up' ? 'var(--green2)' : trend === 'down' ? 'var(--red2)' : 'var(--muted2)';
    const tekst = trend === 'up' ? 'Stigende form' : trend === 'down' ? 'Fallende form' : 'Stabil form';
    trendHTML = `
      <div class="seksjon-etikett">Trend (siste 5 økter)</div>
      <div class="trend-boks">
        <div class="trend-pil" style="color:${farge}">${pil}</div>
        <div class="trend-info">
          <div class="trend-tittel" style="color:${farge}">${tekst}</div>
          <div class="trend-sub">Basert på siste 5 økt-resultater</div>
        </div>
        <div class="trend-endring" style="color:${farge}">${change > 0 ? '+' : ''}${change}</div>
      </div>`;
  }

  let formHTML = '';
  if (stat.form?.length) {
    const badges = [...stat.form];
    while (badges.length < 5) badges.push(null);
    formHTML = `
      <div class="seksjon-etikett">Form (siste kamper)</div>
      <div class="form-rekke">
        ${badges.map(r => r === null
          ? `<div class="form-badge form-badge-tom">·</div>`
          : `<div class="form-badge form-badge-${r}">${r}</div>`
        ).join('')}
        <div style="flex:1;display:flex;align-items:center;padding-left:8px;font-size:14px;color:var(--muted2)">
          ${stat.totalKamper} kamp${stat.totalKamper === 1 ? '' : 'er'} totalt
        </div>
      </div>`;
  }

  let partnerHTML = '';
  if (stat.bestPartner) {
    const ini  = lagInitialer(stat.bestPartner.navn);
    const wrF  = stat.bestPartner.winRate >= 60 ? 'var(--green2)' : stat.bestPartner.winRate >= 40 ? 'var(--yellow)' : 'var(--red2)';
    const barB = Math.round(stat.bestPartner.winRate);
    partnerHTML = `
      <div class="seksjon-etikett">Beste kjemi</div>
      <div class="beste-partner-boks" style="flex-direction:column;align-items:stretch;gap:10px">
        <div style="display:flex;align-items:center;gap:12px">
          <div class="beste-partner-avatar">${ini}</div>
          <div class="beste-partner-info">
            <div class="beste-partner-navn">${stat.bestPartner.navn}</div>
            <div class="beste-partner-stat">${stat.bestPartner.kamper} kamper sammen</div>
          </div>
          <div style="text-align:right">
            <div style="font-family:'DM Mono',monospace;font-size:22px;font-weight:700;color:${wrF}">${stat.bestPartner.winRate}%</div>
            <div style="font-size:14px;color:var(--muted2)">winrate</div>
          </div>
        </div>
        <div style="background:var(--border);border-radius:4px;height:6px;overflow:hidden">
          <div style="width:${barB}%;height:100%;background:${wrF};border-radius:4px;transition:width .5s"></div>
        </div>
      </div>`;
  }

  el.innerHTML = `
    <div class="kampstat-rutenett">
      <div class="kampstat-boks">
        <div class="kampstat-verdi" style="color:${wrFarge}">${stat.winRate}%</div>
        <div class="kampstat-etikett">Winrate</div>
      </div>
      <div class="kampstat-boks">
        <div class="kampstat-verdi" style="color:var(--white)">${stat.avgPoints}</div>
        <div class="kampstat-etikett">Snitt poeng</div>
      </div>
      <div class="kampstat-boks">
        <div class="kampstat-verdi" style="font-size:22px;color:var(--accent2)">${stat.totalKamper}</div>
        <div class="kampstat-etikett">Kamper</div>
      </div>
    </div>
    ${trendHTML}
    ${formHTML}
    ${partnerHTML}`;
}

// ════════════════════════════════════════════════════════
// SINGELHISTORIKK (delt mellom profil og global-profil)
// ════════════════════════════════════════════════════════
export async function lastProfilSingelHistorikk(spillerId, erGlobal, diagramRefs) {
  const prefix      = erGlobal ? 'global-profil-' : 'profil-';
  const ratingEl    = document.getElementById(`${prefix}singel-rating`);
  const historikkEl = document.getElementById(`${prefix}singel-historikk`);
  const diagramEl   = document.getElementById(`${prefix}singel-diagram`);

  if (!db || !spillerId) return;

  try {
    const snap = await getDocs(query(
      collection(db, SAM.SINGEL_HISTORIKK),
      where('spillerId', '==', spillerId)
    ));
    const historikk = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.dato?.toMillis?.() ?? 0) - (b.dato?.toMillis?.() ?? 0));

    const spillerSnap = await getDoc(doc(db, SAM.SPILLERE, spillerId));
    const spiller     = spillerSnap.exists() ? spillerSnap.data() : {};
    const singelRating = spiller.singelRating ?? null;

    if (ratingEl) ratingEl.textContent = singelRating != null ? singelRating : '—';

    if (diagramEl && historikk.length) {
      const ratingData = [historikk[0].ratingFoer, ...historikk.map(h => h.ratingEtter)];
      const etiketter  = ['Start', ...historikk.map((_, i) => 'S' + (i + 1))];
      if (erGlobal) {
        diagramRefs.global = lagRatingDiagram(diagramEl, ratingData, etiketter, diagramRefs.global);
      } else {
        diagramRefs.profil = lagRatingDiagram(diagramEl, ratingData, etiketter, diagramRefs.profil);
      }
    } else if (diagramEl) {
      const ctx = diagramEl.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, diagramEl.width, diagramEl.height);
    }

    if (historikkEl) {
      if (!historikk.length) {
        historikkEl.innerHTML = '<div style="padding:16px;text-align:center;font-size:16px;color:var(--muted2)">Ingen singelkamper spilt ennå</div>';
      } else {
        historikkEl.innerHTML = [...historikk].reverse().map(h => {
          const endring = h.endring ?? 0;
          const farge   = endring >= 0 ? 'var(--green2)' : 'var(--red2)';
          const dato    = h.dato?.toDate?.()?.toLocaleDateString('no-NO', { day:'numeric', month:'short' }) ?? '';
          const ikon    = h.resultat === 'seier' ? '🏆' : '🐥';
          return `<div class="historikk-rad">
            <div style="flex:1">
              <div style="font-size:15px;font-weight:500">${ikon} vs ${escHtml(h.motstanderNavn ?? '?')}</div>
              <div style="font-size:12px;color:var(--muted2)">${dato}</div>
            </div>
            <div style="text-align:right">
              <div style="font-family:'DM Mono',monospace;font-size:16px;font-weight:600;color:${farge}">${endring >= 0 ? '+' : ''}${endring}</div>
              <div style="font-size:12px;color:var(--muted2)">${h.ratingEtter}</div>
            </div>
          </div>`;
        }).join('');
      }
    }
  } catch (e) {
    console.warn('[singelHistorikk]', e?.message ?? e);
    if (historikkEl) historikkEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted2)">Kunne ikke laste singelhistorikk</div>';
  }
}

// ════════════════════════════════════════════════════════
// GLOBAL PROFIL-SKJERM
// ════════════════════════════════════════════════════════
let globalDiagram      = null;
let _globalSingelDiagram = null;
let _globalProfilSpillerId = null;
let _globalProfilAktivFane = 'americano';

// Diagram-referanser sendt til lastProfilSingelHistorikk
const _globalDiagramRefs = {
  get global() { return _globalSingelDiagram; },
  set global(v) { _globalSingelDiagram = v; },
};

export async function apneGlobalProfil(spillerId) {
  if (!db || !spillerId) return;

  let spiller;
  try {
    const snap = await getDoc(doc(db, SAM.SPILLERE, spillerId));
    if (!snap.exists()) { visMelding('Spiller ikke funnet.', 'feil'); return; }
    spiller = { id: snap.id, ...snap.data() };
  } catch (e) {
    visFBFeil('Kunne ikke hente spiller: ' + (e?.message ?? e));
    return;
  }

  _globalProfilSpillerId = spillerId;
  _globalProfilAktivFane = 'americano';
  document.getElementById('global-profil-fane-americano')?.classList.add('modus-aktiv');
  document.getElementById('global-profil-fane-singel')?.classList.remove('modus-aktiv');
  document.getElementById('global-profil-innhold-americano').style.display = 'block';
  document.getElementById('global-profil-innhold-singel').style.display    = 'none';

  document.getElementById('global-profil-navn').textContent = spiller.navn ?? 'Ukjent';
  const ratingEl = document.getElementById('global-profil-rating');
  if (ratingEl) ratingEl.textContent = spiller.rating ?? STARTRATING;

  const nLabel   = getNivaaLabel(spiller.rating ?? STARTRATING);
  const nLabelEl = document.getElementById('global-profil-nivaa-label');
  if (nLabelEl) {
    nLabelEl.className   = `nivaa-label ${nLabel.kl}`;
    nLabelEl.textContent = `${nLabel.ikon} ${nLabel.tekst}`;
    nLabelEl.style.display = 'inline-flex';
  }

  let historikk = [];
  try {
    const snap = await getDocs(query(collection(db, SAM.HISTORIKK), where('spillerId', '==', spillerId)));
    historikk = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.dato?.toMillis?.() ?? 0) - (b.dato?.toMillis?.() ?? 0));
  } catch (e) {
    console.warn('Historikk ikke tilgjengelig:', e?.message ?? e);
  }

  const antallTreninger = historikk.length;
  const bestePlass      = historikk.length ? Math.min(...historikk.map(h => h.plassering ?? 999)) : '—';
  const totalEndring    = historikk.reduce((sum, h) => sum + (h.endring ?? 0), 0);

  document.getElementById('global-profil-statistikk').innerHTML = [
    { val: antallTreninger,                                          lbl: 'Økter',         farge: 'var(--white)' },
    { val: bestePlass === 999 ? '—' : '#' + bestePlass,             lbl: 'Beste plass',   farge: 'var(--yellow)' },
    { val: (totalEndring >= 0 ? '+' : '') + totalEndring,           lbl: 'Total Δ rating', farge: totalEndring >= 0 ? 'var(--green2)' : 'var(--red2)' },
  ].map(b => `<div class="stat-boks">
    <div class="stat-verdi" style="color:${b.farge}">${b.val}</div>
    <div class="stat-etikett">${b.lbl}</div>
  </div>`).join('');

  const ratingData = historikk.length
    ? [STARTRATING, ...historikk.map(h => h.ratingEtter ?? STARTRATING)]
    : [spiller.rating ?? STARTRATING];
  const etiketter = historikk.length
    ? ['Start', ...historikk.map((_, i) => 'T' + (i+1))]
    : ['Nå'];

  const canvas = document.getElementById('global-rating-diagram');
  if (canvas) globalDiagram = lagRatingDiagram(canvas, ratingData, etiketter, globalDiagram);

  document.getElementById('global-trening-historikk').innerHTML = historikk.length
    ? [...historikk].reverse().map((h, i) => `
        <div class="historikk-rad">
          <div style="flex:1">Økt ${historikk.length - i}</div>
          <div style="font-family:'DM Mono',monospace;font-size:14px;color:var(--muted2);margin-right:8px">Plass #${h.plassering ?? '—'}</div>
          <div style="font-family:'DM Mono',monospace;font-size:16px;font-weight:600;color:${(h.endring ?? 0) >= 0 ? 'var(--green2)' : 'var(--red2)'}">
            ${(h.endring ?? 0) >= 0 ? '+' : ''}${h.endring ?? 0}
          </div>
        </div>`).join('')
    : '<div style="padding:16px;text-align:center;font-size:16px;color:var(--muted2)">Ingen historikk ennå</div>';

  setAktivSlettSpillerId(spillerId);

  const kampStatEl = document.getElementById('global-kampstat-innhold');
  if (kampStatEl) kampStatEl.innerHTML = '<div class="kampstat-laster">Beregner statistikk…</div>';

  // Sett motstanderId for refresh-kall fra utfordrer-seksjonen
  const utf = document.getElementById('utf-seksjon');
  if (utf) utf.dataset.motstanderId = spillerId;

  _naviger('global-profil');

  // Last kampstat og utfordrer-seksjon parallelt — blokkerer ikke navigeringen
  hentKampStatistikk(spillerId).then(stat => {
    const trendData = beregnTrend(historikk);
    visKampStatistikk(stat, trendData);
  });

  if (db && spillerId) {
    try {
      const snap = await getDoc(doc(db, SAM.SPILLERE, spillerId));
      if (snap.exists()) await visUtfordrerSeksjon({ id: snap.id, ...snap.data() });
    } catch (_) {}
  }
}
window.apneGlobalProfil = apneGlobalProfil;

window.byttGlobalProfilFane = function(fane) {
  _globalProfilAktivFane = fane;
  document.getElementById('global-profil-fane-americano')?.classList.toggle('modus-aktiv', fane === 'americano');
  document.getElementById('global-profil-fane-singel')?.classList.toggle('modus-aktiv',   fane === 'singel');
  document.getElementById('global-profil-innhold-americano').style.display = fane === 'americano' ? 'block' : 'none';
  document.getElementById('global-profil-innhold-singel').style.display    = fane === 'singel'    ? 'block' : 'none';
  if (fane === 'singel' && _globalProfilSpillerId) {
    lastProfilSingelHistorikk(_globalProfilSpillerId, true, _globalDiagramRefs);
  }
};
