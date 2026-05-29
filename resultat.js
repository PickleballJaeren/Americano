// ════════════════════════════════════════════════════════
// resultat.js — runderesultat og sluttresultat
// ════════════════════════════════════════════════════════
import {
  db, SAM, STARTRATING, PARTER_6_SINGEL, PARTER_6_DOBBEL,
  collection, doc, updateDoc,
  query, where, getDocs,
} from './firebase.js';
import { app, erMix, erMixAB } from './state.js';
import { getParter } from './rotasjon.js';
import { getNivaaKlasse } from './rating.js';
import { escHtml } from './ui.js';
import { lagInitialer } from './render-helpers.js';
import { getKampStatusCache } from './baner.js';
import { getErAdmin } from './admin.js';

// ── Avhengigheter injisert fra app.js via resultatInit() ─────────────────────
let _naviger       = () => {};
let _krevAdmin     = () => {};
let _visAvsluttModal   = () => {};
let _bekreftNesteRunde = () => {};

export function resultatInit(deps) {
  _naviger           = deps.naviger;
  _krevAdmin         = deps.krevAdmin;
  _visAvsluttModal   = deps.visAvsluttModal;
  _bekreftNesteRunde = deps.bekreftNesteRunde;
}

function beregnSpillerstatistikk(spillere, kamper) {
  if (!spillere?.length || !kamper?.length) return [];
  const antall = spillere.length;
  const erSingelBaneStats = antall === 2;
  // Sjekk om kamp-dataene indikerer singel (erSingel-flagg i første kamp)
  const harSingelKamp = (kamper ?? []).some(k => k?.erSingel === true);
  const harDobbelKamp6 = app.er6SpillerFormat && !erSingelBaneStats && antall === 4;
  const parter = (erSingelBaneStats || harSingelKamp) ? PARTER_6_SINGEL : (harDobbelKamp6 ? PARTER_6_DOBBEL : getParter(antall));
  return spillere.map((spiller, si) => {
    let seire = 0, for_ = 0, imot = 0;
    parter.forEach(par => {
      const k = (kamper ?? []).find(k => k?.kampNr === par.nr);
      if (!k || k.lag1Poeng == null || k.lag2Poeng == null) return;

      // Singel: sammenlign med spillerId direkte
      if (erSingelBaneStats || k.erSingel) {
        const erL1 = k.lag1_s1 === spiller.id;
        const erL2 = k.lag2_s1 === spiller.id;
        if (!erL1 && !erL2) return;
        const mine  = erL1 ? k.lag1Poeng : k.lag2Poeng;
        const deres = erL1 ? k.lag2Poeng : k.lag1Poeng;
        if (mine > deres) seire++;
        for_ += mine; imot += deres;
        return;
      }

      // Hviler-sjekk: spiller er verken på lag1 eller lag2
      const paaL1  = par.lag1.includes(si);
      const paaL2  = par.lag2.includes(si);
      const hviler = par.hviler === si;

      if (hviler) {
        // Hvilende spiller får snittpoeng (Math.ceil av totalen)
        const hvilPoeng = k.hvilerPoeng ?? Math.ceil((k.lag1Poeng + k.lag2Poeng) / 2);
        for_ += hvilPoeng;
        // Ingen seir/tap for hvilende spiller
        return;
      }
      if (!paaL1 && !paaL2) return;

      const mine  = paaL1 ? k.lag1Poeng : k.lag2Poeng;
      const deres = paaL1 ? k.lag2Poeng : k.lag1Poeng;
      if (mine > deres) seire++;
      for_ += mine; imot += deres;
    });
    return {
      spillerId: spiller.id,
      navn:      spiller.navn ?? 'Ukjent',
      seire, for: for_, imot, diff: for_ - imot,
    };
  });
}

function sorterRangering(stats) {
  if (!stats?.length) return [];
  return [...stats]
    .sort((a, b) => b.seire - a.seire || b.diff - a.diff || b.for - a.for || (b.rating ?? STARTRATING) - (a.rating ?? STARTRATING))
    .map((s, i) => ({ ...s, baneRang: i + 1 }));
}

export async function visRundeResultat() {
  document.getElementById('modal-neste').style.display = 'none';
  const erSiste = false; // ingen fast maksimumsgrense — admin avslutter manuelt

  // Skriv adminSkjerm og hent kamper PARALLELT:
  // Tilskuernes onSnapshot trigges så snart updateDoc er ferdig —
  // ikke etter at getDocs også er ferdig (slik det var tidligere).
  // Deltakere kaller visRundeResultat() via onVisRundeResultat-callback
  // og skal IKKE skrive til Firestore (getErAdmin() === false for dem).
  let kamperFraDB = Object.values(getKampStatusCache());
  try {
    const kampSpørring = (db && app.treningId)
      ? getDocs(erMix()
          ? query(collection(db, SAM.KAMPER), where('treningId', '==', app.treningId))
          : query(collection(db, SAM.KAMPER), where('treningId', '==', app.treningId), where('rundeNr', '==', app.runde)))
      : Promise.resolve(null);

    const skjermOppdatering = (db && app.treningId && getErAdmin())
      ? updateDoc(doc(db, SAM.TRENINGER, app.treningId), { adminSkjerm: 'resultat' })
      : Promise.resolve();

    // Kjør begge parallelt — tilskuere varsles mens admin laster kampdata
    const [snap] = await Promise.all([kampSpørring, skjermOppdatering]);
    if (snap && !snap.empty) {
      kamperFraDB = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
  } catch (e) {
    console.warn('[visRundeResultat] Feil ved henting/oppdatering:', e?.message ?? e);
  }

  app.rangerteBaner = (app.baneOversikt ?? []).map(bane => {
    const kamper = kamperFraDB.filter(k => k?.baneNr === `bane${bane.baneNr}`);
    const stats  = beregnSpillerstatistikk(bane.spillere ?? [], kamper);
    return { baneNr: bane.baneNr, rangert: sorterRangering(stats), spillere: bane.spillere ?? [], erSingel: bane.erSingel ?? false };
  });

  // ── Forflytningsmerker ────────────────────────────────────────────────────
  // KONKURRANSE : opprykk/nedrykk beregnes og vises på ikke-siste runder
  // MIX         : ingen forflytning — alle stokkes om uansett
  const forflytninger = (!erSiste && !erMix()) ? beregnForflytninger(app.rangerteBaner) : {};
  const nestKnapp = document.getElementById('neste-runde-resultat-knapp');
  nestKnapp.textContent = erSiste ? 'AVSLUTT ØKT' : (erMix() ? 'NYE LAG →' : 'NESTE RUNDE →');
  nestKnapp.onclick     = erSiste ? _visAvsluttModal : () => _krevAdmin('Neste kamp', 'Kun administrator kan starte neste kamp. Skriv inn PIN-koden.', _bekreftNesteRunde);

  // Mix: Kamp X resultat / konkurranse: Runde X resultat
  document.getElementById('res-runde-nummer').textContent = app.runde;
  const resultatAppName = document.querySelector('#skjerm-resultat .app-name');
  if (resultatAppName) {
    resultatAppName.innerHTML = erMix()
      ? `Kamp <span id="res-runde-nummer">${app.runde}</span> resultat`
      : `Runde <span id="res-runde-nummer">${app.runde}</span> resultat`;
  }

  const resultatSub = document.getElementById('resultat-hdr-sub');
  if (resultatSub) {
    resultatSub.textContent = erMix()
      ? (erSiste ? 'Takk for spillet! 🎉' : 'Hvem scoret mest?')
      : 'Rangering og forflytning';
  }

  document.getElementById('res-runde-nummer').textContent = app.runde;

  if (erMix()) {
    // ── MIX: Akkumuler statistikk direkte fra alle kamper i økten ────────
    const totaler = {};
    kamperFraDB
      .filter(k => k.ferdig && k.lag1Poeng != null && k.lag2Poeng != null)
      .forEach(k => {
        const lag1Vant = k.lag1Poeng > k.lag2Poeng;
        const lag2Vant = k.lag2Poeng > k.lag1Poeng;
        const leggTil = (id, navn, mine, vant) => {
          if (!id) return;
          if (!totaler[id]) totaler[id] = { spillerId: id, navn: navn ?? 'Ukjent', seire: 0, poeng: 0, kamper: 0 };
          totaler[id].poeng  += mine;
          totaler[id].kamper += 1;
          if (vant) totaler[id].seire += 1;
        };
        leggTil(k.lag1_s1, k.lag1_s1_navn, k.lag1Poeng, lag1Vant);
        leggTil(k.lag1_s2, k.lag1_s2_navn, k.lag1Poeng, lag1Vant);
        leggTil(k.lag2_s1, k.lag2_s1_navn, k.lag2Poeng, lag2Vant);
        leggTil(k.lag2_s2, k.lag2_s2_navn, k.lag2Poeng, lag2Vant);
        if (k.hviler_id) {
          const hvp = k.hvilerPoeng ?? Math.ceil((k.lag1Poeng + k.lag2Poeng) / 2);
          if (!totaler[k.hviler_id]) totaler[k.hviler_id] = { spillerId: k.hviler_id, navn: k.hviler_navn ?? 'Ukjent', seire: 0, poeng: 0, kamper: 0 };
          totaler[k.hviler_id].poeng += hvp;
        }
      });

    // Legg til spillere på venteliste som ikke har kamp-poeng ennå
    // (hviler via rotasjon, ikke via hviler_id i kamp-dokument)
    const alleKjente = new Set(Object.keys(totaler));
    [
      ...(app.baneOversikt ?? []).flatMap(b => b.spillere ?? []),
      ...(app.venteliste   ?? []),
    ].forEach(s => {
      if (s?.id && !alleKjente.has(s.id)) {
        totaler[s.id] = { spillerId: s.id, navn: s.navn ?? 'Ukjent', seire: 0, poeng: 0, kamper: 0 };
        alleKjente.add(s.id);
      }
    });

    const sammenlagt = Object.values(totaler)
      .sort((a, b) => b.poeng - a.poeng || b.seire - a.seire);

    const kampLabel  = erSiste ? `Alle ${app.runde} kamper` : `Etter kamp ${app.runde}`;
    const banner     = _lagMixLiveBanner(sammenlagt, app.runde);
    const mixNesteInfo = !erSiste
      ? `<div class="mix-neste-info">🎲 Nye lag trekkes til neste kamp</div>`
      : '';

    const plasseringSymbol = p => p === 1 ? '🥇' : p === 2 ? '🥈' : p === 3 ? '🥉' : `${p}.`;

    const kolonneHode = `<div style="display:grid;grid-template-columns:32px 1fr 36px 28px 28px;gap:0;padding:8px 14px;border-bottom:1px solid var(--border2);font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);font-weight:600">
      <span>#</span><span>Navn</span>
      <span style="text-align:right">Poeng</span>
      <span style="text-align:right">S</span>
      <span style="text-align:right">K</span>
    </div>`;

    const lagRad = (s, i) => {
      const plass   = i + 1;
      const erLeder = plass === 1;
      const erHviler = s.kamper === 0;
      return `<div class="rang-rad${erLeder ? ' mix-rang-leder' : ''}${erHviler ? ' rang-rad-hviler' : ''}">
        <div style="font-family:'Bebas Neue',cursive;font-size:${plass <= 3 ? '22' : '18'}px;min-width:32px;line-height:1">${plasseringSymbol(plass)}</div>
        <div class="rang-navn" style="flex:1">
          ${escHtml(s.navn)}
          ${erHviler ? '<span style="font-size:11px;color:var(--orange);margin-left:6px">💤 hviler</span>' : ''}
        </div>
        <div style="font-family:'DM Mono',monospace;font-size:20px;font-weight:600;color:${erLeder ? 'var(--yellow)' : 'var(--white)'};min-width:36px;text-align:right">${s.poeng}</div>
        <div style="font-family:'DM Mono',monospace;font-size:14px;color:var(--green2);min-width:28px;text-align:right">${s.seire}S</div>
        <div style="font-family:'DM Mono',monospace;font-size:14px;color:var(--muted2);min-width:28px;text-align:right">${s.kamper}K</div>
      </div>`;
    };

    if (erKval()) {
      // Kval: to separate grupper
      const erSluttfase = app.kvalFase === 'sluttfase';
      const gruppeAIds  = new Set(erSluttfase ? (app.kvalToppgruppe ?? []) : (app.kvalGruppeA ?? []));
      const gruppeBIds  = new Set(erSluttfase ? (app.kvalBunngruppe ?? []) : (app.kvalGruppeB ?? []));
      const tittelA     = erSluttfase ? '🏅 Opprykksgruppe' : '🟢 Gruppe A';
      const tittelB     = erSluttfase ? '🤝 Nedrykkgruppe'  : '🔵 Gruppe B';
      const fargeA      = erSluttfase ? 'var(--green2)'     : 'var(--green2)';
      const fargeB      = erSluttfase ? 'var(--accent2)'    : 'var(--accent2)';
      sammenlagt.forEach(s => {
        if (!gruppeAIds.has(s.spillerId) && !gruppeBIds.has(s.spillerId)) {
          if (gruppeAIds.size <= gruppeBIds.size) gruppeAIds.add(s.spillerId);
          else gruppeBIds.add(s.spillerId);
        }
      });
      const listeA = sammenlagt.filter(s => gruppeAIds.has(s.spillerId));
      const listeB = sammenlagt.filter(s => gruppeBIds.has(s.spillerId));
      document.getElementById('resultat-innhold').innerHTML = `
        <div class="kort" style="margin-bottom:10px">
          <div class="kort-innhold" style="padding:12px 14px">
            <div style="font-size:15px;font-weight:500;color:var(--accent2)">${banner}</div>
          </div>
        </div>
        <div class="kort" style="margin-bottom:10px">
          <div class="kort-hode">
            <div style="font-family:'Bebas Neue',cursive;font-size:20px;letter-spacing:1px;color:${fargeA}">${tittelA}</div>
            <div style="font-size:13px;color:var(--muted2)">${kampLabel}</div>
          </div>
          <div class="kort-innhold" style="padding:0">
            ${kolonneHode}${listeA.map(lagRad).join('')}${mixNesteInfo}
          </div>
        </div>
        <div class="kort">
          <div class="kort-hode">
            <div style="font-family:'Bebas Neue',cursive;font-size:20px;letter-spacing:1px;color:${fargeB}">${tittelB}</div>
            <div style="font-size:13px;color:var(--muted2)">${kampLabel}</div>
          </div>
          <div class="kort-innhold" style="padding:0">
            ${kolonneHode}${listeB.map(lagRad).join('')}${mixNesteInfo}
          </div>
        </div>`;
    } else {
      // Mix: én samlet tabell
      document.getElementById('resultat-innhold').innerHTML = `
        <div class="kort" style="margin-bottom:10px">
          <div class="kort-innhold" style="padding:12px 14px">
            <div style="font-size:15px;font-weight:500;color:var(--accent2)">${banner}</div>
          </div>
        </div>
        <div class="kort">
          <div class="kort-hode">
            <div style="font-family:'Bebas Neue',cursive;font-size:20px;letter-spacing:1px;color:var(--green2)">
              🎲 ${kampLabel}
            </div>
          </div>
          <div class="kort-innhold" style="padding:0">
            ${kolonneHode}${sammenlagt.map(lagRad).join('')}${mixNesteInfo}
          </div>
        </div>`;
    }

  } else {
    // ── KONKURRANSE: Rangering per bane med opprykk/nedrykk ─────────────
    document.getElementById('resultat-innhold').innerHTML = (app.rangerteBaner ?? []).map(bane => {
      if (!bane?.rangert?.length) return '';
      const erForst = bane.baneNr === 1;
      const erSistB = bane.baneNr === app.antallBaner;
      const er5bane = (bane.spillere?.length ?? 0) === 5;

      const rader = bane.rangert.map((s, ri) => {
        const fm  = forflytninger[s.spillerId] ?? 'blir';
        let merke = '<span class="forflytning-merke fm-blir">→ Blir</span>';
        if (fm === 'opp')     merke = '<span class="forflytning-merke fm-opp">↑ Opp</span>';
        if (fm === 'ned')     merke = '<span class="forflytning-merke fm-ned">↓ Ned</span>';
        if (fm === 'ut')      merke = '<span class="forflytning-merke fm-ut">→ Venteliste</span>';
        if (fm === 'roterer') merke = '<span class="forflytning-merke fm-blir">↻ Roterer</span>';
        if (erSiste)          merke = '';
        const rkl           = ['rn-1','rn-2','rn-3','rn-4','rn-4'][ri] ?? '';
        const spillerData   = (bane.spillere ?? []).find(sp => sp.id === s.spillerId);
        const spillerRating = spillerData?.rating ?? STARTRATING;
        const nivaaKlRang   = getNivaaKlasse(spillerRating);
        return `<div class="rang-rad ${nivaaKlRang}">
          <div class="rang-nummer ${rkl}">${ri + 1}</div>
          <div class="rang-navn">${escHtml(s.navn ?? 'Ukjent')}</div>
          <div class="rang-statistikk">${s.seire}S +${s.for}−${s.imot}</div>
          ${merke}
        </div>`;
      }).join('');

      const bane5merke     = er5bane ? `<span style="font-size:12px;background:rgba(234,88,12,.15);color:var(--orange);border-radius:4px;padding:2px 7px;font-weight:700">5 SPL</span>` : '';
      const singelMerkeRes = bane.erSingel ? `<span style="font-size:12px;background:rgba(234,179,8,.15);color:var(--yellow);border-radius:4px;padding:2px 7px;font-weight:700">🏃 SINGEL</span>` : (app.er6SpillerFormat ? `<span style="font-size:12px;background:rgba(37,99,235,.15);color:var(--accent2);border-radius:4px;padding:2px 7px;font-weight:700">🎾 DOBBEL</span>` : '');
      const baneIkon       = erForst && !bane.erSingel ? '🏆' : erSistB && !app.er6SpillerFormat ? '🔻' : '';
      const baneNummerFarge = bane.erSingel ? 'var(--yellow)' : 'var(--accent)';

      return `<div class="kort">
        <div class="kort-hode">
          <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
            <span style="font-family:'Bebas Neue',cursive;font-size:39px;color:${baneNummerFarge};line-height:1">${bane.baneNr}</span>
            <span style="font-size:14px;text-transform:uppercase;color:var(--muted2);letter-spacing:1.5px">Bane ${baneIkon}</span>
            ${bane5merke}${singelMerkeRes}
          </div>
        </div>
        <div class="kort-innhold">${rader}</div>
      </div>`;
    }).join('');
  }
  _naviger('resultat');
}
window.visRundeResultat = visRundeResultat;

export function beregnForflytninger(rangerteBaner) {
  if (!rangerteBaner?.length) return {};

  // 6-spiller-format: ingen forfremmelse/degradering — alle roterer automatisk
  if (app.er6SpillerFormat) {
    const mv = {};
    rangerteBaner.forEach(bane => {
      (bane.rangert ?? []).forEach(s => { mv[s.spillerId] = 'roterer'; });
    });
    return mv;
  }

  const n  = rangerteBaner.length;
  const mv = {};
  if (n === 1) {
    (rangerteBaner[0]?.rangert ?? []).forEach(s => { mv[s.spillerId] = 'blir'; });
    return mv;
  }
  rangerteBaner.forEach((bane, i) => {
    const r    = bane?.rangert ?? [];
    const sist = r.length - 1; // 3 for 4-bane, 4 for 5-bane
    if (r.length < 4) return;
    r.forEach(s => { mv[s.spillerId] = 'blir'; });
    if (i > 0 && i < n-1)  { mv[r[0].spillerId] = 'opp'; mv[r[sist].spillerId] = 'ned'; }
    else if (i === 0)       { mv[r[sist].spillerId] = 'ned'; }
    else {
      mv[r[0].spillerId] = 'opp';
      if ((app.venteliste ?? []).length > 0) mv[r[sist].spillerId] = 'ut';
    }
  });
  return mv;
}

// ════════════════════════════════════════════════════════
// SLUTTRESULTAT
// ════════════════════════════════════════════════════════
// ────────────────────────────────────────────────────────
// MIX & MATCH — LIVE SAMMENLAGTABELL (pågående økt)
// Vises i Resultater-fanen mens Mix-økt er aktiv.
// Henter alle ferdigspilte kamper og beregner sammenlagt.
// ────────────────────────────────────────────────────────
async function visMixLiveTabell() {
  // Sett header
  const sluttNavn = document.getElementById('slutt-hdr-navn');
  const sluttSub  = document.getElementById('slutt-hdr-sub');
  if (sluttNavn) sluttNavn.textContent = 'Mix & Match';
  if (sluttSub)  sluttSub.textContent  = 'Sammenlagt';

  // Vis live-indikator
  const indikator     = document.getElementById('mix-live-indikator');
  const indikatorTekst = document.getElementById('mix-live-indikator-tekst');
  if (indikator)      indikator.style.display      = 'flex';
  if (indikatorTekst) indikatorTekst.textContent   = `Kamp ${app.runde ?? 1} pågår`;

  // Vis live-seksjon, skjul slutt-seksjonene
  const liveSeksjon   = document.getElementById('mix-live-tabell-seksjon');
  const mixBanner     = document.getElementById('mix-slutt-banner');
  const ledLabel      = document.getElementById('slutt-ledertavle-label');
  const ledertavleEl  = document.getElementById('ledertavle');
  const ratingEl      = document.getElementById('rating-endringer');
  const ratingSection = [...document.querySelectorAll('.seksjon-etikett')]
    .find(el => el.textContent.includes('Ratingendringer'));

  if (liveSeksjon)    liveSeksjon.style.display    = 'block';
  if (mixBanner)      mixBanner.style.display      = 'none';
  if (ledLabel)       ledLabel.style.display       = 'none';
  if (ledertavleEl)   ledertavleEl.closest('.kort').style.display = 'none';
  if (ratingEl)       ratingEl.closest('.kort').style.display     = 'none';
  if (ratingSection)  ratingSection.style.display                 = 'none';

  const innhold = document.getElementById('mix-live-tabell-innhold');
  if (!innhold) return;

  innhold.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted2)">Laster…</div>';

  try {
    const snap = await getDocs(
      query(collection(db, SAM.KAMPER), where('treningId', '==', app.treningId))
    );
    const alleKamper = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Beregn sammenlagt — samme logikk som mix-viewer.html
    const totaler = {};
    alleKamper
      .filter(k => k.ferdig && k.lag1Poeng != null && k.lag2Poeng != null)
      .forEach(k => {
        const lag1Vant = k.lag1Poeng > k.lag2Poeng;
        const lag2Vant = k.lag2Poeng > k.lag1Poeng;
        const leggTil = (id, navn, mine, vant) => {
          if (!id) return;
          if (!totaler[id]) totaler[id] = { navn: navn ?? 'Ukjent', poeng: 0, seire: 0, kamper: 0 };
          totaler[id].poeng  += mine;
          totaler[id].kamper += 1;
          if (vant) totaler[id].seire += 1;
        };
        leggTil(k.lag1_s1, k.lag1_s1_navn, k.lag1Poeng, lag1Vant);
        leggTil(k.lag1_s2, k.lag1_s2_navn, k.lag1Poeng, lag1Vant);
        leggTil(k.lag2_s1, k.lag2_s1_navn, k.lag2Poeng, lag2Vant);
        leggTil(k.lag2_s2, k.lag2_s2_navn, k.lag2Poeng, lag2Vant);
        if (k.hviler_id) {
          const hvp = k.hvilerPoeng ?? Math.ceil((k.lag1Poeng + k.lag2Poeng) / 2);
          if (!totaler[k.hviler_id]) totaler[k.hviler_id] = { navn: k.hviler_navn ?? 'Ukjent', poeng: 0, seire: 0, kamper: 0 };
          totaler[k.hviler_id].poeng += hvp;
        }
      });

    const sammenlagt = Object.values(totaler)
      .sort((a, b) => b.poeng - a.poeng || b.seire - a.seire);

    if (!sammenlagt.length) {
      innhold.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted2);font-size:15px">Ingen kamper er ferdig ennå.</div>';
      return;
    }

    // Engasjementstekst
    const banner = _lagMixLiveBanner(sammenlagt, app.runde ?? 1);

    // Tabell-header
    const plasseringSymbol = p => p === 1 ? '🥇' : p === 2 ? '🥈' : p === 3 ? '🥉' : `${p}.`;

    const rader = sammenlagt.map((s, i) => {
      const plass   = i + 1;
      const erLeder = plass === 1;
      return `<div class="rang-rad${erLeder ? ' mix-rang-leder' : ''}">
        <div style="font-family:'Bebas Neue',cursive;font-size:${plass <= 3 ? '22' : '18'}px;min-width:32px;line-height:1">${plasseringSymbol(plass)}</div>
        <div class="rang-navn" style="flex:1">${escHtml(s.navn)}</div>
        <div style="font-family:'DM Mono',monospace;font-size:20px;font-weight:600;color:${erLeder ? 'var(--yellow)' : 'var(--white)'};min-width:36px;text-align:right">${s.poeng}</div>
        <div style="font-family:'DM Mono',monospace;font-size:14px;color:var(--green2);min-width:28px;text-align:right">${s.seire}S</div>
        <div style="font-family:'DM Mono',monospace;font-size:14px;color:var(--muted2);min-width:28px;text-align:right">${s.kamper}K</div>
      </div>`;
    }).join('');

    innhold.innerHTML = `
      <div class="kort" style="margin-bottom:10px">
        <div class="kort-innhold" style="padding:12px 14px">
          <div style="font-size:15px;font-weight:500;color:var(--accent2);margin-bottom:2px">${banner}</div>
        </div>
      </div>
      <div class="kort">
        <div class="kort-innhold" style="padding:0">
          <div style="display:grid;grid-template-columns:32px 1fr 36px 28px 28px;gap:0;padding:8px 14px;border-bottom:1px solid var(--border2);font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);font-weight:600">
            <span>#</span><span>Navn</span>
            <span style="text-align:right">Poeng</span>
            <span style="text-align:right">S</span>
            <span style="text-align:right">K</span>
          </div>
          ${rader}
        </div>
      </div>`;

  } catch (e) {
    if (innhold) innhold.innerHTML =
      `<div style="padding:16px;color:var(--red2);font-size:14px">Feil ved lasting: ${escHtml(e?.message ?? String(e))}</div>`;
  }
}

function _lagMixLiveBanner(sammenlagt, runde) {
  if (!sammenlagt.length) return `⏸ Venter på resultater fra kamp ${runde}…`;
  if (sammenlagt.length >= 2) {
    const diff = sammenlagt[0].poeng - sammenlagt[1].poeng;
    if (sammenlagt.length >= 3 && sammenlagt[0].poeng - sammenlagt[2].poeng <= 6)
      return `🔥 Tett i toppen — bare ${sammenlagt[0].poeng - sammenlagt[2].poeng} poeng skiller de tre øverste!`;
    if (diff <= 5)
      return `🔥 Tett om toppen — ${diff} poeng skiller de to øverste!`;
    if (diff >= 15)
      return `👑 ${escHtml(sammenlagt[0].navn)} leder suverent — ${diff} poeng foran nummer 2!`;
  }
  return `🎲 ${escHtml(sammenlagt[0].navn)} leder med ${sammenlagt[0].poeng} poeng etter kamp ${runde}`;
}

// ────────────────────────────────────────────────────────
// KONKURRANSE — FORELØPIG LIVE-TABELL (pågående økt)
// Vises i Resultater-fanen mens konkurranse-økt er aktiv.
// Henter ferdigspilte kamper for gjeldende runde og viser
// foreløpig rangering per bane. Ingen forflytningsmerker.
// ────────────────────────────────────────────────────────
async function visKonkurranseLiveTabell() {
  // Sett header
  const sluttNavn = document.getElementById('slutt-hdr-navn');
  const sluttSub  = document.getElementById('slutt-hdr-sub');
  if (sluttNavn) sluttNavn.textContent = `Runde ${app.runde}`;
  if (sluttSub)  sluttSub.textContent  = 'Foreløpige resultater';

  // Vis live-indikator, skjul slutt-seksjonene
  const indikator      = document.getElementById('mix-live-indikator');
  const indikatorTekst = document.getElementById('mix-live-indikator-tekst');
  const liveSeksjon    = document.getElementById('mix-live-tabell-seksjon');
  const mixBanner      = document.getElementById('mix-slutt-banner');
  const ledLabel       = document.getElementById('slutt-ledertavle-label');
  const ledertavleKort = document.getElementById('ledertavle')?.closest('.kort');
  const ratingKort     = document.getElementById('rating-endringer')?.closest('.kort');
  const ratingSection  = [...document.querySelectorAll('.seksjon-etikett')]
    .find(el => el.textContent.includes('Ratingendringer'));

  if (indikator)      { indikator.style.display = 'flex'; }
  if (indikatorTekst) { indikatorTekst.textContent = `Runde ${app.runde} pågår`; }
  if (liveSeksjon)    { liveSeksjon.style.display = 'block'; }
  if (mixBanner)      { mixBanner.style.display = 'none'; }
  if (ledLabel)       { ledLabel.style.display = 'none'; }
  if (ledertavleKort) { ledertavleKort.style.display = 'none'; }
  if (ratingKort)     { ratingKort.style.display = 'none'; }
  if (ratingSection)  { ratingSection.style.display = 'none'; }

  const innhold = document.getElementById('mix-live-tabell-innhold');
  if (!innhold) return;
  innhold.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted2)">Laster…</div>';

  try {
    // Hent kamper for gjeldende runde
    let kamper = Object.values(getKampStatusCache());
    if (db && app.treningId) {
      const snap = await getDocs(
        query(collection(db, SAM.KAMPER),
          where('treningId', '==', app.treningId),
          where('rundeNr',   '==', app.runde))
      );
      if (!snap.empty) kamper = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    if (!app.baneOversikt?.length) {
      innhold.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted2);font-size:15px">Ingen baner er satt opp ennå.</div>';
      return;
    }

    const html = (app.baneOversikt ?? []).map(bane => {
      const baneKamper   = kamper.filter(k => k?.baneNr === `bane${bane.baneNr}`);
      const antallFerdig = baneKamper.filter(k => k?.ferdig).length;
      const antallTotalt = baneKamper.length || 3; // fallback 3 kamper
      const stats        = beregnSpillerstatistikk(bane.spillere ?? [], baneKamper);
      const rangert      = sorterRangering(stats);

      if (!rangert.length) return '';

      const erForst = bane.baneNr === 1;
      const erSistB = bane.baneNr === app.antallBaner;
      const baneIkon = erForst ? '🏆' : erSistB && !app.er6SpillerFormat ? '🔻' : '';

      const fremgang = antallFerdig === 0
        ? `<span style="color:var(--muted2)">Ikke startet</span>`
        : antallFerdig === antallTotalt
          ? `<span style="color:var(--green2)">✓ Ferdig</span>`
          : `<span style="color:var(--yellow)">${antallFerdig} av ${antallTotalt} kamper ferdig</span>`;

      const rader = rangert.map((s, ri) => {
        const spillerData   = (bane.spillere ?? []).find(sp => sp.id === s.spillerId);
        const spillerRating = spillerData?.rating ?? STARTRATING;
        const nivaaKlRang   = getNivaaKlasse(spillerRating);
        const rkl           = ['rn-1','rn-2','rn-3','rn-4','rn-4'][ri] ?? '';
        return `<div class="rang-rad ${nivaaKlRang}">
          <div class="rang-nummer ${rkl}">${ri + 1}</div>
          <div class="rang-navn">${escHtml(s.navn ?? 'Ukjent')}</div>
          <div class="rang-statistikk">${s.seire}S +${s.for}−${s.imot}</div>
        </div>`;
      }).join('');

      return `<div class="kort" style="margin-bottom:10px">
        <div class="kort-hode">
          <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
            <span style="font-family:'Bebas Neue',cursive;font-size:39px;color:var(--accent);line-height:1">${bane.baneNr}</span>
            <span style="font-size:14px;text-transform:uppercase;color:var(--muted2);letter-spacing:1.5px">Bane ${baneIkon}</span>
          </div>
          <div style="font-size:13px;margin-top:2px">${fremgang}</div>
        </div>
        <div class="kort-innhold">${rader}</div>
      </div>`;
    }).join('');

    innhold.innerHTML = html ||
      '<div style="padding:24px;text-align:center;color:var(--muted2);font-size:15px">Ingen resultater ennå.</div>';

  } catch (e) {
    if (innhold) innhold.innerHTML =
      `<div style="padding:16px;color:var(--red2);font-size:14px">Feil ved lasting: ${escHtml(e?.message ?? String(e))}</div>`;
  }
}

// ────────────────────────────────────────────────────────
// MIX A/B — LIVE TABELLER (pågående økt)
// Viser én tabell per gruppe basert på ferdigspilte kamper.
// ────────────────────────────────────────────────────────
async function visMixABLiveTabell() {
  const sluttNavn = document.getElementById('slutt-hdr-navn');
  const sluttSub  = document.getElementById('slutt-hdr-sub');
  if (sluttNavn) sluttNavn.textContent = 'Mix A/B';
  if (sluttSub)  sluttSub.textContent  = 'Foreløpige resultater';

  const indikator      = document.getElementById('mix-live-indikator');
  const indikatorTekst = document.getElementById('mix-live-indikator-tekst');
  const liveSeksjon    = document.getElementById('mix-live-tabell-seksjon');
  const mixBanner      = document.getElementById('mix-slutt-banner');
  const ledLabel       = document.getElementById('slutt-ledertavle-label');
  const ledertavleKort = document.getElementById('ledertavle')?.closest('.kort');
  const ratingKort     = document.getElementById('rating-endringer')?.closest('.kort');
  const ratingSection  = [...document.querySelectorAll('.seksjon-etikett')]
    .find(el => el.textContent.includes('Ratingendringer'));

  if (indikator)      { indikator.style.display = 'flex'; }
  if (indikatorTekst) { indikatorTekst.textContent = `Kamp ${app.runde ?? 1} pågår`; }
  if (liveSeksjon)    { liveSeksjon.style.display = 'block'; }
  if (mixBanner)      { mixBanner.style.display = 'none'; }
  if (ledLabel)       { ledLabel.style.display = 'none'; }
  if (ledertavleKort) { ledertavleKort.style.display = 'none'; }
  if (ratingKort)     { ratingKort.style.display = 'none'; }
  if (ratingSection)  { ratingSection.style.display = 'none'; }

  const innhold = document.getElementById('mix-live-tabell-innhold');
  if (!innhold) return;
  innhold.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted2)">Laster…</div>';

  try {
    const snap = await getDocs(
      query(collection(db, SAM.KAMPER), where('treningId', '==', app.treningId))
    );
    const alleKamper = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const gruppeAIds = new Set(app.mixAbGruppeA ?? []);
    const gruppeBIds = new Set(app.mixAbGruppeB ?? []);
    const banerA     = app.mixAbBanerA ?? 1;

    // Fordel kamper på gruppe basert på baneNr
    const kamperA = alleKamper.filter(k => {
      const nr = parseInt((k.baneNr ?? '').replace('bane', ''), 10);
      return nr >= 1 && nr <= banerA;
    });
    const kamperB = alleKamper.filter(k => {
      const nr = parseInt((k.baneNr ?? '').replace('bane', ''), 10);
      return nr > banerA;
    });

    const _lagGruppeSeksjon = (gruppeLabel, farge, kamper, gruppeIds) => {
      const totaler = {};
      kamper
        .filter(k => k.ferdig && k.lag1Poeng != null && k.lag2Poeng != null)
        .forEach(k => {
          const lag1Vant = k.lag1Poeng > k.lag2Poeng;
          const lag2Vant = k.lag2Poeng > k.lag1Poeng;
          const leggTil = (id, navn, mine, vant) => {
            if (!id || !gruppeIds.has(id)) return;
            if (!totaler[id]) totaler[id] = { navn: navn ?? 'Ukjent', poeng: 0, seire: 0, kamper: 0 };
            totaler[id].poeng  += mine;
            totaler[id].kamper += 1;
            if (vant) totaler[id].seire += 1;
          };
          leggTil(k.lag1_s1, k.lag1_s1_navn, k.lag1Poeng, lag1Vant);
          leggTil(k.lag1_s2, k.lag1_s2_navn, k.lag1Poeng, lag1Vant);
          leggTil(k.lag2_s1, k.lag2_s1_navn, k.lag2Poeng, lag2Vant);
          leggTil(k.lag2_s2, k.lag2_s2_navn, k.lag2Poeng, lag2Vant);
        });

      const sortert = Object.values(totaler).sort((a, b) => b.poeng - a.poeng || b.seire - a.seire);
      if (!sortert.length) return `<div class="kort" style="margin-bottom:10px">
        <div class="kort-hode"><span style="font-family:'Bebas Neue',cursive;font-size:26px;color:${farge}">Gruppe ${gruppeLabel}</span></div>
        <div class="kort-innhold"><div style="padding:12px;text-align:center;color:var(--muted2)">Ingen kamper ferdig ennå.</div></div>
      </div>`;

      const plasseringSymbol = p => p === 1 ? '🥇' : p === 2 ? '🥈' : p === 3 ? '🥉' : `${p}.`;
      const rader = sortert.map((s, i) => {
        const plass   = i + 1;
        const erLeder = plass === 1;
        return `<div class="rang-rad${erLeder ? ' mix-rang-leder' : ''}">
          <div style="font-family:'Bebas Neue',cursive;font-size:${plass <= 3 ? '22' : '18'}px;min-width:32px;line-height:1">${plasseringSymbol(plass)}</div>
          <div class="rang-navn" style="flex:1">${escHtml(s.navn)}</div>
          <div style="font-family:'DM Mono',monospace;font-size:20px;font-weight:600;color:${erLeder ? 'var(--yellow)' : 'var(--white)'};min-width:36px;text-align:right">${s.poeng}</div>
          <div style="font-family:'DM Mono',monospace;font-size:14px;color:var(--green2);min-width:28px;text-align:right">${s.seire}S</div>
          <div style="font-family:'DM Mono',monospace;font-size:14px;color:var(--muted2);min-width:28px;text-align:right">${s.kamper}K</div>
        </div>`;
      }).join('');

      return `<div class="kort" style="margin-bottom:10px">
        <div class="kort-hode">
          <span style="font-family:'Bebas Neue',cursive;font-size:26px;color:${farge}">Gruppe ${gruppeLabel}</span>
        </div>
        <div class="kort-innhold" style="padding:0">
          <div style="display:grid;grid-template-columns:32px 1fr 36px 28px 28px;gap:0;padding:8px 14px;border-bottom:1px solid var(--border2);font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);font-weight:600">
            <span>#</span><span>Navn</span>
            <span style="text-align:right">Poeng</span>
            <span style="text-align:right">S</span>
            <span style="text-align:right">K</span>
          </div>
          ${rader}
        </div>
      </div>`;
    };

    innhold.innerHTML =
      _lagGruppeSeksjon('A', 'var(--green2)', kamperA, gruppeAIds) +
      _lagGruppeSeksjon('B', 'var(--red2)',   kamperB, gruppeBIds);

  } catch (e) {
    if (innhold) innhold.innerHTML =
      `<div style="padding:16px;color:var(--red2);font-size:14px">Feil ved lasting: ${escHtml(e?.message ?? String(e))}</div>`;
  }
}

export async function visSluttresultat() {
  // ── Mix A/B-økt er aktiv — vis live tabeller per gruppe ──
  if (erMixAB() && app.treningId && app._oektAktiv) {
    await visMixABLiveTabell();
    return;
  }

  // ── Mix-økt er aktiv — vis live sammenlagtabell ──────────
  if (erMix() && app.treningId && app._oektAktiv) {
    await visMixLiveTabell();
    return;
  }

  // ── Konkurranse-økt er aktiv — vis foreløpig banestatus ──
  if (!erMix() && app.treningId && app._oektAktiv) {
    await visKonkurranseLiveTabell();
    return;
  }

  // Nullstill live-visning
  const liveSeksjon    = document.getElementById('mix-live-tabell-seksjon');
  const indikator      = document.getElementById('mix-live-indikator');
  const ledLabel       = document.getElementById('slutt-ledertavle-label');
  const ledertavleKort = document.getElementById('ledertavle')?.closest('.kort');
  const ratingKort     = document.getElementById('rating-endringer')?.closest('.kort');
  const ratingSection  = [...document.querySelectorAll('.seksjon-etikett')]
    .find(el => el.textContent.includes('Ratingendringer'));
  if (liveSeksjon)   liveSeksjon.style.display   = 'none';
  if (indikator)     indikator.style.display      = 'none';
  if (ledLabel)      ledLabel.style.display       = '';
  if (ledertavleKort) ledertavleKort.style.display = '';
  if (ratingKort)    ratingKort.style.display     = '';
  if (ratingSection) ratingSection.style.display  = '';

  let data = app.ratingEndringer ?? [];

  if (!data.length && db) {
    document.getElementById('ledertavle').innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--muted2)">Laster resultater…</div>';
    try {
      const treningId = app.treningId || sessionStorage.getItem('aktivTreningId');
      if (treningId) {
        // Prøv opptil 3 ganger med 1 sekunds mellomrom — Firestore-replikering
        // kan ha en kort forsinkelse mellom status='avsluttet' og synlige resultater.
        let docs = [];
        for (let forsok = 0; forsok < 3; forsok++) {
          if (forsok > 0) await new Promise(r => setTimeout(r, 1000));
          const resSnap = await getDocs(
            query(collection(db, SAM.RESULTATER), where('treningId', '==', treningId))
          );
          docs = resSnap.docs;
          if (docs.length > 0) break;
        }
        data = docs
          .map(d => d.data())
          .sort((a, b) => a.sluttPlassering - b.sluttPlassering)
          .map(r => ({
            spillerId:       r.spillerId,
            navn:            r.spillerNavn ?? 'Ukjent',
            sluttPlassering: r.sluttPlassering,
            nyRating:        r.ratingEtter,
            ratingVedStart:  r.ratingFor,
            endring:         r.ratingEndring,
            spillModus:      r.spillModus,
            for:             r.totalPoeng    ?? 0,
            antallKamper:    r.antallKamper  ?? 0,
            seire:           r.seire         ?? 0,
            imot:            r.imot          ?? 0,
          }));
      }
    } catch (e) {
      console.warn('[visSluttresultat] Kunne ikke hente fra Firestore:', e?.message ?? e);
    }
  }

  if (!data.length) {
    document.getElementById('ledertavle').innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--muted2)">Ingen økt avsluttet ennå</div>';
    document.getElementById('rating-endringer').innerHTML = '';
    return;
  }

  // Bestem layout: mix-mode, lagret mix-økt, eller konkurranse
  const visMixLayout = erMix()
    || data[0]?.spillModus === 'mix'
    || data.every(s => s.endring === 0 && s.nyRating === s.ratingVedStart);

  if (visMixLayout) {
    visMixSluttresultat(data);
  } else {
    visKonkurranseSluttresultat(data);
  }
}

// ────────────────────────────────────────────────────────
// KONKURRANSE-SLUTTRESULTAT
// Rating, rangering og Elo-endringer per spiller.
// ────────────────────────────────────────────────────────
function visKonkurranseSluttresultat(data) {
  const mixBanner = document.getElementById('mix-slutt-banner');
  if (mixBanner) mixBanner.style.display = 'none';

  const sluttNavn = document.getElementById('slutt-hdr-navn');
  const sluttSub  = document.getElementById('slutt-hdr-sub');
  const ledLabel  = document.getElementById('slutt-ledertavle-label');
  if (sluttNavn) sluttNavn.textContent = 'Sluttresultat';
  if (sluttSub)  sluttSub.textContent  = 'Økten er ferdig';
  if (ledLabel)  ledLabel.textContent  = '🏆 Ledertavle';

  document.getElementById('ledertavle').innerHTML = data.map(s => {
    const ini = lagInitialer(s.navn);
    return `<div class="lb-rad" onclick="apneProfil('${s.spillerId}')">
      <div class="lb-plass${s.sluttPlassering <= 3 ? ' topp3' : ''}">${s.sluttPlassering}</div>
      <div class="lb-avatar">${ini}</div>
      <div class="lb-navn">${s.navn ?? 'Ukjent'}</div>
      <div style="text-align:right">
        <div style="font-family:'DM Mono',monospace;font-size:15px;color:var(--muted2)">${s.nyRating}</div>
        <div class="lb-endring ${s.endring >= 0 ? 'pos' : 'neg'}">${s.endring >= 0 ? '+' : ''}${s.endring}</div>
      </div>
    </div>`;
  }).join('');

  const ratingEl      = document.getElementById('rating-endringer');
  const ratingSection = [...document.querySelectorAll('.seksjon-etikett')]
    .find(el => el.textContent.includes('Ratingendringer'));
  if (ratingEl)      ratingEl.closest('.kort').style.display = '';
  if (ratingSection) ratingSection.style.display             = '';
  if (ratingEl) ratingEl.innerHTML = data.map(s => `
    <div class="lb-rad" style="cursor:default">
      <div style="flex:1;font-size:17px">${s.navn ?? 'Ukjent'}</div>
      <div style="font-family:'DM Mono',monospace;font-size:15px;color:var(--muted2);margin-right:10px">${s.ratingVedStart ?? STARTRATING} → ${s.nyRating}</div>
      <div class="lb-endring ${s.endring >= 0 ? 'pos' : 'neg'}">${s.endring >= 0 ? '+' : ''}${s.endring}</div>
    </div>`).join('');
}

// ────────────────────────────────────────────────────────
// MIX & MATCH — SLUTTRESULTAT
// Totalpoeng, antall kamper og positive utmerkelser.
// Ingen rating. Uformell, sosial tone.
// ────────────────────────────────────────────────────────
function visMixSluttresultat(data) {
  const mixBanner = document.getElementById('mix-slutt-banner');
  if (mixBanner) mixBanner.style.display = 'block';

  const sluttNavn = document.getElementById('slutt-hdr-navn');
  const sluttSub  = document.getElementById('slutt-hdr-sub');
  const ledLabel  = document.getElementById('slutt-ledertavle-label');
  if (sluttNavn) sluttNavn.textContent = 'Mix & Match';
  if (sluttSub)  sluttSub.textContent  = 'Takk for spillet!';
  if (ledLabel)  ledLabel.textContent  = '🎉 Øktoversikt';

  // Skjul konkurranse-seksjonene
  const ratingEl      = document.getElementById('rating-endringer');
  const ratingSection = [...document.querySelectorAll('.seksjon-etikett')]
    .find(el => el.textContent.includes('Ratingendringer'));
  if (ratingEl)      ratingEl.closest('.kort').style.display = 'none';
  if (ratingSection) ratingSection.style.display             = 'none';

  // ── Utmerkelser ───────────────────────────────────────────────
  // Sorter etter totalpoeng for å finne vinnerne
  const flerstPoengId  = [...data].sort((a, b) => (b.for ?? 0) - (a.for ?? 0))[0]?.spillerId;
  const flestKamperId  = [...data].sort((a, b) => (b.antallKamper ?? 0) - (a.antallKamper ?? 0))[0]?.spillerId;
  const flestSeireId   = [...data]
    .filter(s => (s.antallKamper ?? 0) > 0)
    .sort((a, b) => (b.seire ?? 0) - (a.seire ?? 0))[0]?.spillerId;

  // Sorter visning etter totalpoeng
  const sortert = [...data].sort((a, b) => (b.for ?? 0) - (a.for ?? 0));

  // Positive heiarop-tekster — veksler så ingen får samme
  const heiarop = [
    'Bra jobba! 👏', 'Fin innsats! ⚡', 'Godt spilt! 🎯',
    'Solid spilling! 💪', 'Bra innsats! 😄', 'Godt gjort! 🤝',
    'Strålende! ✨', 'Kjempebra! 🌟',
  ];

  document.getElementById('ledertavle').innerHTML = sortert.map((s, i) => {
    const ini          = lagInitialer(s.navn);
    const totalPoeng   = s.for          ?? 0;
    const antallKamper = s.antallKamper ?? 0;
    const seire        = s.seire        ?? 0;
    const winPst       = antallKamper > 0 ? Math.round((seire / antallKamper) * 100) : 0;

    // Utmerkelser for denne spilleren
    const utmerkelser = [];
    if (sortert.length > 1) {
      if (s.spillerId === flerstPoengId)  utmerkelser.push({ ikon: '🎖', tekst: 'Flest poeng' });
      if (s.spillerId === flestSeireId && s.spillerId !== flerstPoengId)
        utmerkelser.push({ ikon: '🔥', tekst: 'Flest seire' });
    }

    const erTopp = i === 0 && sortert.length > 1;
    const rosHTML = `<div class="mix-spiller-ros">${heiarop[i % heiarop.length]}</div>`;
    const utmerkelseHTML = utmerkelser.length
      ? `<div class="mix-utmerkelser">${utmerkelser.map(u => `<span class="mix-utmerkelse">${u.ikon} ${u.tekst}</span>`).join('')}</div>`
      : '';

    return `<div class="mix-spiller-kort${erTopp ? ' mix-spiller-kort-topp' : ''}">
      <div class="mix-spiller-hoved">
        <div class="mix-spiller-avatar${erTopp ? ' mix-spiller-avatar-topp' : ''}">${ini}</div>
        <div class="mix-spiller-meta">
          <div class="mix-spiller-navn">${escHtml(s.navn ?? 'Ukjent')}</div>
          ${rosHTML}${utmerkelseHTML}
        </div>
        <div class="mix-poeng-boks${erTopp ? ' mix-poeng-boks-topp' : ''}">
          <div class="mix-poeng-tal">${totalPoeng}</div>
          <div class="mix-poeng-lbl">poeng</div>
        </div>
      </div>
      <div class="mix-statistikk-rad">
        <div class="mix-stat-celle">
          <span class="mix-stat-verdi">${antallKamper}</span>
          <span class="mix-stat-lbl">kamper</span>
        </div>
        <div class="mix-stat-celle">
          <span class="mix-stat-verdi">${seire}</span>
          <span class="mix-stat-lbl">seire</span>
        </div>
        <div class="mix-stat-celle">
          <span class="mix-stat-verdi">${winPst}%</span>
          <span class="mix-stat-lbl">winrate</span>
        </div>
      </div>
    </div>`;
  }).join('');
}


// ════════════════════════════════════════════════════════
// SPILLERPROFIL