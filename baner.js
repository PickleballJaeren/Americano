// ════════════════════════════════════════════════════════
// baner.js — visning av baner og poengregistrering
// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
// INNHOLDSFORTEGNELSE
// ────────────────────────────────────────────────────────
//  1. Initialisering og cache          (~linje  17)
//  2. Runde-UI og baneoversikt         (~linje  27)
//  3. Banekort-rendering               (~linje 107)
//  4. Poengregistrering (Americano)    (~linje 349)
//  5. Best av 3 — modal og logikk     (~linje 578)
//  6. Poeng-picker (delt)              (~linje 967)
//  7. Bane-navigasjon og poeng-nav    (~linje 1080)
//  8. Rediger banefordeling (admin)   (~linje 1149)
// ════════════════════════════════════════════════════════

import {
  db, SAM, STARTRATING, PARTER_6_DOBBEL, PARTER_6_SINGEL,
  collection, doc, addDoc, updateDoc,
  query, where, getDocs, writeBatch, serverTimestamp,
} from './firebase.js';
import { app, erMix } from './state.js';
import { getParter, erSingelBane, hentParter } from './rotasjon.js';
import { visMelding, visFBFeil, escHtml } from './ui.js';

// ── Avhengigheter injisert fra app.js via banerInit() ────────────────────────
let _naviger            = () => {};
let _oppdaterAvbrytKnapp = () => {};
let _getAktivKlubbId    = () => null;

export function banerInit(deps) {
  _naviger             = deps.naviger;
  _oppdaterAvbrytKnapp = deps.oppdaterAvbrytKnapp;
  _getAktivKlubbId     = deps.getAktivKlubbId ?? (() => null);
}

// kampStatusCache — bruk alltid getKampStatusCache()/setKampStatusCache()
let kampStatusCache = {};
export function setKampStatusCache(v) { kampStatusCache = v; }
export function getKampStatusCache()  { return kampStatusCache; }

// ════════════════════════════════════════════════════════
// HJELPEFUNKSJON — brukes av visBaner, navigerBane og oppdaterPoengNav
// ════════════════════════════════════════════════════════

/**
 * Returnerer true når alle baner i gjeldende runde har registrerte poeng.
 * Håndterer alle banetyper: Mix (K1 per bane), singel, 6-spiller dobbel og standard 4/5-spiller.
 */
export function erAlleBanerFerdig() {
  const baner = app.baneOversikt ?? [];
  if (baner.length === 0) return false;
  return baner.every(bane => {
    const n = bane?.spillere?.length ?? 0;
    if (n < 2) return false;
    if (erMix()) return kampStatusCache[`bane${bane.baneNr}_1`]?.ferdig === true;
    if (erSingelBane(bane)) return kampStatusCache[`bane${bane.baneNr}_1`]?.ferdig === true;
    const parter = hentParter(bane, false, app.er6SpillerFormat);
    return parter.every(par => {
      const k = kampStatusCache[`bane${bane.baneNr}_${par.nr}`];
      return app.scoringsFormat === 'best_of_3' ? k?.bekreftet === true : k?.ferdig === true;
    });
  });
}

export function oppdaterRundeUI() {
  // 99 er intern "ingen fast grense"-verdi — skal ikke vises til bruker
  const visMaks = app.maksRunder < 99;
  const rundeLabel = erMix() ? 'Kamp' : 'Runde';

  const rundeHdr = document.getElementById('runde-hdr');
  const maksHdr  = document.getElementById('maks-runder-hdr');
  if (rundeHdr) rundeHdr.textContent = app.runde;
  if (maksHdr)  maksHdr.textContent  = visMaks ? app.maksRunder : '';

  // Mix: annen sub-header i bane-headeren
  const banerSub = document.getElementById('baner-hdr-sub');
  if (banerSub) banerSub.textContent = erMix() ? 'Mix & Match' : 'Baneoversikt';

  // Mix-merke — kun synlig i Mix & Match-modus
  const mixMerkeEl = document.getElementById('mix-modus-merke');
  if (mixMerkeEl) mixMerkeEl.style.display = erMix() ? 'inline-flex' : 'none';

  // Header-tittel og indikator-tekst
  const appName = document.querySelector('#skjerm-baner .app-name');
  if (appName) {
    appName.innerHTML = visMaks
      ? `${rundeLabel} <span id="runde-hdr">${app.runde}</span>/<span id="maks-runder-hdr">${app.maksRunder}</span>`
      : `${rundeLabel} <span id="runde-hdr">${app.runde}</span>`;
  }

  const indEl = document.getElementById('runde-indikator-tekst');
  if (indEl) {
    indEl.textContent = erMix()
      ? `Kamp ${app.runde} — trykk på en bane for å registrere poeng 🎲`
      : `Runde ${app.runde} pågår — trykk på en bane for å registrere poeng`;
  }

  // Sett tekst på neste-kamp/neste-runde-knappen
  const nesteKnapp = document.getElementById('neste-runde-knapp');
  if (nesteKnapp) nesteKnapp.textContent = erMix() ? 'NESTE KAMP →' : 'NESTE RUNDE →';

  // Fremgangsprikker — vis kun når maks er kjent
  const wrap = document.getElementById('fremgang-beholder');
  if (wrap) {
    let h = '';
    if (visMaks) {
      for (let i = 1; i <= app.maksRunder; i++) {
        const kl = i < app.runde ? 'ferdig' : i === app.runde ? 'aktiv' : '';
        h += `<div class="fremgang-prikk ${kl}"></div>`;
      }
      h += `<span class="fremgang-tekst">${rundeLabel} ${app.runde} av ${app.maksRunder}</span>`;
    } else {
      h += `<div class="fremgang-prikk aktiv"></div>`;
      h += `<span class="fremgang-tekst">${rundeLabel} ${app.runde}</span>`;
    }
    wrap.innerHTML = h;
  }
}
// ════════════════════════════════════════════════════════
// BANEOVERSIKT
// ════════════════════════════════════════════════════════

let _visBanerTimer = null;
export function visBanerDebounced() {
  clearTimeout(_visBanerTimer);
  _visBanerTimer = setTimeout(visBaner, 50);
}

export function oppdaterKampStatus(kamper) {
  kampStatusCache = {};
  (kamper ?? []).forEach(k => {
    if (k?.baneNr && k?.kampNr != null) {
      kampStatusCache[`${k.baneNr}_${k.kampNr}`] = k;
    }
  });
  const baneLaster = document.getElementById('bane-laster');
  if (baneLaster) baneLaster.style.display = 'none';
  visBanerDebounced();
}

export function visBaner() {
  // Ingen aktiv økt — vis tom tilstand og skjul alt
  if (!app.treningId) {
    const rh = document.getElementById('runde-hdr');
    const mh = document.getElementById('maks-runder-hdr');
    if (rh) rh.textContent = '—';
    if (mh) mh.textContent = '—';
    document.getElementById('runde-indikator-tekst').textContent = 'Ingen aktiv økt';
    document.getElementById('fremgang-beholder').innerHTML    = '';
    document.getElementById('venteliste-visning').innerHTML   = '';
    document.getElementById('bane-liste').innerHTML =
      '<div style="padding:30px 0;text-align:center;color:var(--muted2);font-size:17px">' +
      'Ingen økt pågår. Gå til <strong style="color:var(--white)">Hjem</strong>-fanen for å starte ny økt.</div>';
    document.getElementById('neste-runde-knapp').disabled = true;
    return;
  }

  const vl     = app.venteliste ?? [];
  const vlWrap = document.getElementById('venteliste-visning');
  if (vl.length > 0) {
    vlWrap.innerHTML = `<div class="venteliste-boks">
      <div class="venteliste-tittel">Venteliste (${vl.length})</div>
      ${vl.map((s,i) => `<div class="vl-rad">
        <div class="vl-pos">#${i+1}</div>
        <div style="flex:1">${s.navn ?? 'Ukjent'}</div>
        <div style="font-family:'DM Mono',monospace;font-size:14px;color:var(--muted2)">⭐ ${s.rating ?? STARTRATING}</div>
      </div>`).join('')}
    </div>`;
  } else {
    vlWrap.innerHTML = '';
  }

  document.getElementById('bane-liste').innerHTML = (app.baneOversikt ?? []).map(bane => {
    const antallSpillere = bane?.spillere?.length ?? 0;
    const erSingel = erSingelBane(bane);
    if (antallSpillere < 2) return '';

    // ── Mix & Match ──────────────────────────────────────────────────────────
    if (erMix()) {
      const k        = kampStatusCache[`bane${bane.baneNr}_1`];
      const ferdig   = k?.ferdig === true;
      const baneMaksPoeng = bane.maksPoeng ?? app.poengPerKamp ?? 15;
      const spillTilMerke = `<span style="font-size:12px;background:rgba(37,99,235,.12);color:var(--accent2);border-radius:4px;padding:2px 7px;font-weight:700">Til ${baneMaksPoeng}</span>`;

      // ── Mix singel-bane (6-spiller-format): 1 vs 1 ──
      if (erSingel) {
        const s = bane.spillere;
        const n1 = k ? (k.lag1_s1_navn ?? s[0]?.navn ?? '?') : (s[0]?.navn ?? '?');
        const n2 = k ? (k.lag2_s1_navn ?? s[1]?.navn ?? '?') : (s[1]?.navn ?? '?');
        const singelMerke = `<span style="font-size:12px;background:rgba(234,179,8,.15);color:var(--yellow);border-radius:4px;padding:2px 7px;font-weight:700;letter-spacing:.5px">🏃 SINGEL</span>`;
        return `<div class="kort" onclick="apnePoenginput(${bane.baneNr})" style="cursor:pointer">
          <div class="kort-hode">
            <div style="display:flex;align-items:baseline;gap:10px">
              <div class="bane-nummer-stor" style="color:var(--yellow)">${bane.baneNr}</div>
              <div>
                <div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted2);display:flex;align-items:center;gap:6px">Singel ${singelMerke} ${spillTilMerke}</div>
                <div style="font-size:15px;color:${ferdig ? 'var(--green2)' : 'var(--muted2)'};font-weight:600">${ferdig ? '✓ Ferdig' : 'Mangler poeng'}</div>
              </div>
            </div>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
          </div>
          <div class="kort-innhold">
            <div class="kamp-rad">
              <div style="flex:1">
                <div class="kamp-lag" style="color:var(--white)">${escHtml(n1)}</div>
                <div class="kamp-mot">mot</div>
                <div class="kamp-lag" style="color:var(--white)">${escHtml(n2)}</div>
              </div>
              <div class="kamp-poeng-merke ${ferdig ? 'poeng-ferdig' : 'poeng-mangler'}">
                ${ferdig ? `${k.lag1Poeng}–${k.lag2Poeng}` : '—'}
              </div>
            </div>
          </div>
        </div>`;
      }

      // ── Mix dobbel-bane: 2 vs 2 ──
      const lag1 = k
        ? `${k.lag1_s1_navn ?? '?'} + ${k.lag1_s2_navn ?? '?'}`
        : `${bane.spillere[0]?.navn ?? '?'} + ${bane.spillere[1]?.navn ?? '?'}`;
      const lag2 = k
        ? `${k.lag2_s1_navn ?? '?'} + ${k.lag2_s2_navn ?? '?'}`
        : `${bane.spillere[2]?.navn ?? '?'} + ${bane.spillere[3]?.navn ?? '?'}`;
      return `<div class="kort" onclick="apnePoenginput(${bane.baneNr})" style="cursor:pointer">
        <div class="kort-hode">
          <div style="display:flex;align-items:baseline;gap:10px">
            <div class="bane-nummer-stor" style="color:var(--green2)">${bane.baneNr}</div>
            <div>
              <div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted2)">Bane ${spillTilMerke}</div>
              <div style="font-size:15px;color:${ferdig ? 'var(--green2)' : 'var(--muted2)'};font-weight:600">${ferdig ? '✓ Ferdig' : 'Mangler poeng'}</div>
            </div>
          </div>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        </div>
        <div class="kort-innhold">
          <div class="kamp-rad">
            <div style="flex:1">
              <div class="kamp-lag">${lag1}</div>
              <div class="kamp-mot">mot</div>
              <div class="kamp-lag">${lag2}</div>
            </div>
            <div class="kamp-poeng-merke ${ferdig ? 'poeng-ferdig' : 'poeng-mangler'}">
              ${ferdig ? `${k.lag1Poeng}–${k.lag2Poeng}` : '—'}
            </div>
          </div>
        </div>
      </div>`;
    }

    // ── Singel-bane i konkurranse-modus (6-spiller-format) ──
    if (erSingel) {
      const k      = kampStatusCache[`bane${bane.baneNr}_1`];
      const ferdig = k?.ferdig === true;
      const s      = bane.spillere;
      const rad = `<div class="kamp-rad">
        <div class="kamp-nummer">K1</div>
        <div style="flex:1">
          <div class="kamp-lag" style="color:var(--white)">${s[0]?.navn ?? '?'}</div>
          <div class="kamp-mot">mot</div>
          <div class="kamp-lag" style="color:var(--white)">${s[1]?.navn ?? '?'}</div>
        </div>
        <div class="kamp-poeng-merke ${ferdig && (app.scoringsFormat !== 'best_of_3' || k?.bekreftet) ? 'poeng-ferdig' : (k?.games?.length ? 'poeng-pagar' : 'poeng-mangler')}" style="display:flex;flex-direction:column;align-items:center;gap:4px">
          ${app.scoringsFormat === 'best_of_3'
            ? (k?.bekreftet ? `${k.lag1Poeng}–${k.lag2Poeng} 🏆` : k?.games?.length ? `<span style="font-size:11px;color:var(--yellow)">${k.lag1Poeng}–${k.lag2Poeng} games</span>` : '—')
            : ferdig ? `${k.lag1Poeng}–${k.lag2Poeng}` : '—'}
        </div>
      </div>`;
      const baneMaksPoeng = bane.maksPoeng ?? app.poengPerKamp ?? 15;
      const spillTilMerke = `<span style="font-size:12px;background:rgba(37,99,235,.12);color:var(--accent2);border-radius:4px;padding:2px 7px;font-weight:700;letter-spacing:.3px">Til ${baneMaksPoeng}</span>`;
      const singelMerke = `<span style="font-size:12px;background:rgba(234,179,8,.15);color:var(--yellow);border-radius:4px;padding:2px 7px;font-weight:700;letter-spacing:.5px">🏃 SINGEL</span>`;
      return `<div class="kort" onclick="apnePoenginput(${bane.baneNr})" style="cursor:pointer">
        <div class="kort-hode">
          <div style="display:flex;align-items:baseline;gap:10px">
            <div class="bane-nummer-stor" style="color:var(--yellow)">${bane.baneNr}</div>
            <div>
              <div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted2);display:flex;align-items:center;gap:6px">Singel ${singelMerke} ${spillTilMerke}</div>
              <div style="font-size:15px;color:${ferdig?'var(--green2)':'var(--muted2)'};font-weight:600">${ferdig?'✓ Ferdig':'Mangler poeng'}</div>
            </div>
          </div>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        </div>
        <div class="kort-innhold">${rad}</div>
      </div>`;
    }

    // ── Dobbel-bane (normal eller 6-spiller-format) ──
    if (antallSpillere < 4) return '';
    const parter = hentParter(bane, false, app.er6SpillerFormat);
    const rader = parter.map(par => {
      const k      = kampStatusCache[`bane${bane.baneNr}_${par.nr}`];
      const ferdig = k?.ferdig === true;
      const s      = bane.spillere;
      const hvilerNavn = par.hviler != null ? (s[par.hviler]?.navn ?? null) : null;
      // Best av 3: bygg game-oversikt for banekortet
      const erB3 = app.scoringsFormat === 'best_of_3';
      const b3Games = erB3 ? (k?.games ?? []) : [];
      const b3Bekreftet = erB3 && k?.bekreftet === true;
      const b3Stilling = erB3 ? (() => {
        let l1 = 0, l2 = 0;
        b3Games.filter(Boolean).forEach(g => { if (g.l1 > g.l2) l1++; else if (g.l2 > g.l1) l2++; });
        return { lag1: l1, lag2: l2, ferdig: l1 === 2 || l2 === 2 };
      })() : null;

      // Poengmerke — standard Americano eller best-av-3
      const poengMerkeHTML = erB3
        ? (() => {
            const stilKlasse = b3Bekreftet ? 'poeng-ferdig' : b3Games.length ? 'poeng-pagar' : 'poeng-mangler';
            const stillingTekst = b3Stilling ? `${b3Stilling.lag1}–${b3Stilling.lag2}` : '0–0';
            const gameListe = b3Games.filter(Boolean).map((g, i) =>
              `<span style="font-size:10px;color:var(--muted2);white-space:nowrap">G${i+1}: ${g.l1}-${g.l2}</span>`
            ).join('<span style="color:var(--border2);margin:0 2px">·</span>');
            const lagreKnapp = !b3Bekreftet && b3Stilling?.ferdig
              ? `<button class="knapp knapp-gronn" style="font-size:10px;padding:2px 7px;font-family:'Bebas Neue',cursive;margin-top:2px" onclick="event.stopPropagation();_apneBestAv3FraKort(${bane.baneNr},${par.nr})">LAGRE</button>`
              : '';
            return `<div class="${stilKlasse}" style="display:flex;flex-direction:column;align-items:center;gap:2px;min-width:54px;padding:4px 6px;border-radius:8px;font-size:15px;font-weight:700">
              ${b3Bekreftet ? `${stillingTekst} 🏆` : b3Games.length ? stillingTekst : '—'}
              ${gameListe ? `<div style="display:flex;flex-direction:column;align-items:center;gap:1px">${gameListe}</div>` : ''}
              ${lagreKnapp}
            </div>`;
          })()
        : `<div class="kamp-poeng-merke ${ferdig ? 'poeng-ferdig' : 'poeng-mangler'}">${ferdig ? `${k.lag1Poeng}–${k.lag2Poeng}` : '—'}</div>`;

      // Highlight laget som leder i best-av-3
      const lag1Farge = erB3 && b3Stilling
        ? b3Stilling.lag1 > b3Stilling.lag2
          ? 'var(--green2)'
          : b3Stilling.lag2 > b3Stilling.lag1
            ? 'var(--muted)'
            : 'var(--white)'
        : 'var(--white)';
      const lag2Farge = erB3 && b3Stilling
        ? b3Stilling.lag2 > b3Stilling.lag1
          ? 'var(--green2)'
          : b3Stilling.lag1 > b3Stilling.lag2
            ? 'var(--muted)'
            : 'var(--white)'
        : 'var(--white)';

      return `<div class="kamp-rad" style="cursor:pointer;align-items:flex-start" onclick="apneEnkeltKamp(${bane.baneNr}, ${par.nr})">
        <div class="kamp-nummer" style="padding-top:2px">K${par.nr}</div>
        <div style="flex:1">
          <div class="kamp-lag" style="color:${lag1Farge};font-weight:${erB3 && b3Stilling?.lag1 > b3Stilling?.lag2 ? '700' : '400'}">${s[par.lag1[0]]?.navn ?? '?'} + ${s[par.lag1[1]]?.navn ?? '?'}</div>
          <div class="kamp-mot">mot</div>
          <div class="kamp-lag" style="color:${lag2Farge};font-weight:${erB3 && b3Stilling?.lag2 > b3Stilling?.lag1 ? '700' : '400'}">${s[par.lag2[0]]?.navn ?? '?'} + ${s[par.lag2[1]]?.navn ?? '?'}</div>
          ${hvilerNavn ? `<div style="font-size:13px;color:var(--orange);margin-top:4px">💤 ${hvilerNavn} hviler</div>` : ''}
        </div>
        ${poengMerkeHTML}
      </div>`;
    }).join('');
    const alleFerdig = parter.every(par => kampStatusCache[`bane${bane.baneNr}_${par.nr}`]?.ferdig === true);
    const bane5merke = antallSpillere === 5
      ? `<span style="font-size:12px;background:rgba(234,88,12,.15);color:var(--orange);border-radius:4px;padding:2px 7px;font-weight:700;letter-spacing:.5px">5 SPL</span>`
      : '';
    const dobbelMerke = app.er6SpillerFormat
      ? `<span style="font-size:12px;background:rgba(37,99,235,.15);color:var(--accent2);border-radius:4px;padding:2px 7px;font-weight:700;letter-spacing:.5px">🎾 DOBBEL</span>`
      : '';
    const baneMaksPoeng = bane.maksPoeng ?? (app.poengPerKamp ?? 17);
    const spillTilMerke = app.scoringsFormat === 'best_of_3'
      ? `<span style="font-size:12px;background:rgba(37,99,235,.12);color:var(--accent2);border-radius:4px;padding:2px 7px;font-weight:700;letter-spacing:.3px">Best av 3</span>`
      : `<span style="font-size:12px;background:rgba(37,99,235,.12);color:var(--accent2);border-radius:4px;padding:2px 7px;font-weight:700;letter-spacing:.3px">Til ${baneMaksPoeng}</span>`;
    return `<div class="kort">
      <div class="kort-hode">
        <div style="display:flex;align-items:baseline;gap:10px">
          <div class="bane-nummer-stor">${bane.baneNr}</div>
          <div>
            <div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted2);display:flex;align-items:center;gap:6px">Bane ${bane5merke} ${dobbelMerke} ${spillTilMerke}</div>
            <div style="font-size:15px;color:${alleFerdig?'var(--green2)':'var(--muted2)'};font-weight:600">${alleFerdig?'✓ Ferdig':'Mangler poeng'}</div>
          </div>
        </div>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </div>
      <div class="kort-innhold">${rader}</div>
    </div>`;
  }).join('');

  const alleBanerFerdig = erAlleBanerFerdig();
  document.getElementById('neste-runde-knapp').disabled = !alleBanerFerdig;
  _oppdaterAvbrytKnapp();

  // Vis redigeringsknappen (allerede i HTML, bare skjult som standard)
  const redigerKnapp = document.getElementById('rediger-baner-knapp');
  if (redigerKnapp) redigerKnapp.style.display = 'block';

  // Oppdater tilskuerskjermen med nytt bane-innhold
  if (typeof window.oppdaterTilskuerInnhold === 'function') {
    window.oppdaterTilskuerInnhold();
  }
}

// ════════════════════════════════════════════════════════
// POENGREGISTRERING + VALIDERING
// ════════════════════════════════════════════════════════
export function apnePoenginput(baneNr) {
  const bane = (app.baneOversikt ?? []).find(b => b.baneNr === baneNr);
  const erSingelBanePi = erSingelBane(bane);
  if (!bane || !bane.spillere || (!erSingelBanePi && bane.spillere.length < 4)) {
    visMelding('Banedataen er ikke tilgjengelig.', 'feil');
    return;
  }
  app.aktivBane = baneNr;

  if (app.scoringsFormat === 'best_of_3' && !erMix()) {
    _apneBestAv3Modal(bane, null);
    return;
  }

  document.getElementById('poeng-bane-nummer').textContent = baneNr;
  document.getElementById('poeng-bane-stor').textContent   = baneNr;
  const maksPoeng = bane.maksPoeng ?? (app.poengPerKamp ?? 17);
  document.getElementById('maks-hint').textContent         = maksPoeng;
  document.getElementById('valider-feil').style.display    = 'none';
  const doneBtn = document.getElementById('done-knapp');
  if (doneBtn) doneBtn.style.display = 'none';

  const parter = hentParter(bane, erMix(), app.er6SpillerFormat);

  const eksisterende = {};
  parter.forEach(par => {
    const k = kampStatusCache[`bane${baneNr}_${par.nr}`];
    if (k?.ferdig) eksisterende[par.nr] = { l1: k.lag1Poeng, l2: k.lag2Poeng };
  });

  // Mix: hent spillernavn fra kampdata (K1) i stedet for bane.spillere
  const mixKamp = erMix() ? (kampStatusCache[`bane${baneNr}_1`] ?? null) : null;

  document.getElementById('poeng-kamper').innerHTML = parter.map((par, i) => {
    const e   = eksisterende[par.nr];
    const s   = bane.spillere;

    // ── Singel-kamp: 1 vs 1 ──
    if (erSingelBanePi) {
      const l1n = s[0]?.navn ?? '?';
      const l2n = s[1]?.navn ?? '?';
      const statusHTML = e != null
        ? `<div class="kamp-status lagret" id="kamp-status-${i}">✓ Lagret</div>`
        : `<div class="kamp-status" id="kamp-status-${i}"></div>`;
      return `<div class="kamp-kort" id="kk-${i}" data-maks="${bane.maksPoeng ?? app.poengPerKamp ?? 15}">
        <div class="kamp-hode">
          🏃 Singel <span class="kamp-merke" style="background:rgba(234,179,8,.15);color:var(--yellow)">1 vs 1</span>
          ${statusHTML}
        </div>
        <div style="text-align:center;font-size:14px;color:var(--yellow);padding:6px 0 2px;font-weight:600">Singel — spill til ${bane.maksPoeng ?? app.poengPerKamp ?? 15} poeng</div>
        <div class="lag-rad">
          <div class="lag-boks">
            <div class="lag-navn" style="color:var(--white);font-weight:600">${escHtml(l1n)}</div>
            <input type="hidden" id="s${i}_l1" value="${e != null ? e.l1 : ''}"/>
            <div class="poeng-velger-boks" id="pvb_${i}_l1" onclick="_apnePicker(${i},'l1')">${e != null ? e.l1 : '–'}</div>
            <div class="poeng-picker" id="pp_${i}_l1" style="display:none"></div>
          </div>
          <div class="vs-deler">–</div>
          <div class="lag-boks">
            <div class="lag-navn" style="color:var(--white);font-weight:600">${escHtml(l2n)}</div>
            <input type="hidden" id="s${i}_l2" value="${e != null ? e.l2 : ''}"/>
            <div class="poeng-velger-boks" id="pvb_${i}_l2" onclick="_apnePicker(${i},'l2')">${e != null ? e.l2 : '–'}</div>
            <div class="poeng-picker" id="pp_${i}_l2" style="display:none"></div>
          </div>
        </div>
      </div>`;
    }

    // ── Dobbel-kamp: 2 vs 2 ──
    // Mix: hent lagnavnene fra Firestore-kampdata (riktig rekkefølge)
    const l1n = mixKamp
      ? `${mixKamp.lag1_s1_navn ?? '?'} + ${mixKamp.lag1_s2_navn ?? '?'}`
      : `${s[par.lag1[0]]?.navn ?? '?'} + ${s[par.lag1[1]]?.navn ?? '?'}`;
    const l2n = mixKamp
      ? `${mixKamp.lag2_s1_navn ?? '?'} + ${mixKamp.lag2_s2_navn ?? '?'}`
      : `${s[par.lag2[0]]?.navn ?? '?'} + ${s[par.lag2[1]]?.navn ?? '?'}`;
    const hvilerHTML = par.hviler != null && s[par.hviler]
      ? `<div style="text-align:center;font-size:14px;color:var(--orange);padding:6px 0 2px">💤 ${escHtml(s[par.hviler].navn)} hviler — får snittpoeng</div>`
      : '';
    const statusHTML = e != null
      ? `<div class="kamp-status lagret" id="kamp-status-${i}">✓ Lagret</div>`
      : `<div class="kamp-status" id="kamp-status-${i}"></div>`;
    return `<div class="kamp-kort" id="kk-${i}" data-maks="${bane.maksPoeng ?? app.poengPerKamp ?? 15}">
      <div class="kamp-hode">
        Kamp ${par.nr} <span class="kamp-merke">Americano</span>
        ${statusHTML}
      </div>
      ${hvilerHTML}
      <div class="lag-rad">
        <div class="lag-boks">
          <div class="lag-navn">${escHtml(l1n)}</div>
          <input type="hidden" id="s${i}_l1" value="${e != null ? e.l1 : ''}"/>
          <div class="poeng-velger-boks" id="pvb_${i}_l1" onclick="_apnePicker(${i},'l1')">${e != null ? e.l1 : '–'}</div>
          <div class="poeng-picker" id="pp_${i}_l1" style="display:none"></div>
        </div>
        <div class="vs-deler">–</div>
        <div class="lag-boks">
          <div class="lag-navn">${escHtml(l2n)}</div>
          <input type="hidden" id="s${i}_l2" value="${e != null ? e.l2 : ''}"/>
          <div class="poeng-velger-boks" id="pvb_${i}_l2" onclick="_apnePicker(${i},'l2')">${e != null ? e.l2 : '–'}</div>
          <div class="poeng-picker" id="pp_${i}_l2" style="display:none"></div>
        </div>
      </div>
    </div>`;
  }).join('');
  _naviger('poeng');
  oppdaterPoengNav();

  setTimeout(() => {
    for (let i = 0; i < parter.length; i++) {
      const el = document.getElementById(`pvb_${i}_l1`);
      if (el && document.getElementById(`s${i}_l1`)?.value === '') { _apnePicker(i, 'l1'); break; }
    }
  }, 180);
}
window.apnePoenginput = apnePoenginput;
/**
 * Åpner poengregistrering for én spesifikk kamp på en bane.
 * kampNr er 1-basert (K1, K2, K3) og tilsvarer par.nr i Firestore.
 */
export function apneEnkeltKamp(baneNr, kampNr) {
  const bane = (app.baneOversikt ?? []).find(b => b.baneNr === baneNr);
  if (!bane || !bane.spillere) { visMelding('Banedataen er ikke tilgjengelig.', 'feil'); return; }

  app.aktivBane = baneNr;

  // Best av 3 — åpne dedikert modal med riktig par
  if (app.scoringsFormat === 'best_of_3' && !erMix()) {
    const parter = getParter(bane.spillere.length);
    const par    = parter.find(p => p.nr === kampNr);
    if (par) { _apneBestAv3Modal(bane, par); return; }
  }
  document.getElementById('poeng-bane-nummer').textContent = baneNr;
  document.getElementById('poeng-bane-stor').textContent   = baneNr;
  const maksPoeng = bane.maksPoeng ?? (app.poengPerKamp ?? 17);
  document.getElementById('maks-hint').textContent = maksPoeng;
  document.getElementById('valider-feil').style.display = 'none';
  const doneBtn = document.getElementById('done-knapp');
  if (doneBtn) doneBtn.style.display = 'none';

  const alleParter = hentParter(bane, erMix(), app.er6SpillerFormat);

  // Finn riktig par basert på kampNr
  const par = alleParter.find(p => p.nr === kampNr);
  if (!par) { visMelding('Fant ikke kampen.', 'feil'); return; }

  // i=0 alltid siden vi viser kun én kamp — men kampNr bevares for Firestore-lagring
  const i = 0;
  const k = kampStatusCache[`bane${baneNr}_${par.nr}`];
  const e = k?.ferdig ? { l1: k.lag1Poeng, l2: k.lag2Poeng } : null;
  const s = bane.spillere;

  const statusHTML = e != null
    ? `<div class="kamp-status lagret" id="kamp-status-${i}">✓ Lagret</div>`
    : `<div class="kamp-status" id="kamp-status-${i}"></div>`;

  let kortHTML;
  if (erSingelBane(bane)) {
    kortHTML = `<div class="kamp-kort" id="kk-${i}" data-maks="${maksPoeng}" data-kampnr="${par.nr}">
      <div class="kamp-hode">🏃 Singel <span class="kamp-merke" style="background:rgba(234,179,8,.15);color:var(--yellow)">1 vs 1</span>${statusHTML}</div>
      <div style="text-align:center;font-size:14px;color:var(--yellow);padding:6px 0 2px;font-weight:600">Singel — spill til ${maksPoeng} poeng</div>
      <div class="lag-rad">
        <div class="lag-boks">
          <div class="lag-navn" style="color:var(--white);font-weight:600">${escHtml(s[0]?.navn ?? '?')}</div>
          <input type="hidden" id="s${i}_l1" value="${e != null ? e.l1 : ''}"/>
          <div class="poeng-velger-boks" id="pvb_${i}_l1" onclick="_apnePicker(${i},'l1')">${e != null ? e.l1 : '–'}</div>
          <div class="poeng-picker" id="pp_${i}_l1" style="display:none"></div>
        </div>
        <div class="vs-deler">–</div>
        <div class="lag-boks">
          <div class="lag-navn" style="color:var(--white);font-weight:600">${escHtml(s[1]?.navn ?? '?')}</div>
          <input type="hidden" id="s${i}_l2" value="${e != null ? e.l2 : ''}"/>
          <div class="poeng-velger-boks" id="pvb_${i}_l2" onclick="_apnePicker(${i},'l2')">${e != null ? e.l2 : '–'}</div>
          <div class="poeng-picker" id="pp_${i}_l2" style="display:none"></div>
        </div>
      </div>
    </div>`;
  } else {
    const l1n = `${s[par.lag1[0]]?.navn ?? '?'} + ${s[par.lag1[1]]?.navn ?? '?'}`;
    const l2n = `${s[par.lag2[0]]?.navn ?? '?'} + ${s[par.lag2[1]]?.navn ?? '?'}`;
    const hvilerHTML = par.hviler != null && s[par.hviler]
      ? `<div style="text-align:center;font-size:14px;color:var(--orange);padding:6px 0 2px">💤 ${escHtml(s[par.hviler].navn)} hviler — får snittpoeng</div>`
      : '';
    kortHTML = `<div class="kamp-kort" id="kk-${i}" data-maks="${maksPoeng}" data-kampnr="${par.nr}">
      <div class="kamp-hode">Kamp ${par.nr} <span class="kamp-merke">Americano</span>${statusHTML}</div>
      ${hvilerHTML}
      <div class="lag-rad">
        <div class="lag-boks">
          <div class="lag-navn">${escHtml(l1n)}</div>
          <input type="hidden" id="s${i}_l1" value="${e != null ? e.l1 : ''}"/>
          <div class="poeng-velger-boks" id="pvb_${i}_l1" onclick="_apnePicker(${i},'l1')">${e != null ? e.l1 : '–'}</div>
          <div class="poeng-picker" id="pp_${i}_l1" style="display:none"></div>
        </div>
        <div class="vs-deler">–</div>
        <div class="lag-boks">
          <div class="lag-navn">${escHtml(l2n)}</div>
          <input type="hidden" id="s${i}_l2" value="${e != null ? e.l2 : ''}"/>
          <div class="poeng-velger-boks" id="pvb_${i}_l2" onclick="_apnePicker(${i},'l2')">${e != null ? e.l2 : '–'}</div>
          <div class="poeng-picker" id="pp_${i}_l2" style="display:none"></div>
        </div>
      </div>
    </div>`;
  }

  document.getElementById('poeng-kamper').innerHTML = kortHTML;
  _naviger('poeng');
  oppdaterPoengNav();

  setTimeout(() => {
    const el = document.getElementById(`pvb_${i}_l1`);
    if (el && document.getElementById(`s${i}_l1`)?.value === '') _apnePicker(i, 'l1');
  }, 180);
}
window.apneEnkeltKamp = apneEnkeltKamp;


// ════════════════════════════════════════════════════════
// BEST AV 3 — modal for baner i konkurransemodus
// ════════════════════════════════════════════════════════

// Intern tilstand for pågående best-av-3-registrering
let _b3Bane      = null;   // bane-objekt
let _b3Par       = null;   // par-objekt (hvem spiller mot hvem)
let _b3Games     = [];     // [{l1, l2}, ...] — registrerte games
let _b3AktivGame = 0;      // 0-basert indeks
let _b3Bekreftet = false;  // true etter at sluttresultat er bekreftet — blokkerer redigering

function _apneBestAv3Modal(bane, parOverstyr) {
  const parter = getParter(bane.spillere.length);
  // Finn første uferdige par, eller bruk parOverstyr
  const par = parOverstyr ?? parter.find(p => {
    const k = kampStatusCache[`bane${bane.baneNr}_${p.nr}`];
    return !k?.ferdig;
  }) ?? parter[0];

  _b3Bane      = bane;
  _b3Par       = par;
  _b3Games     = [null, null, null];
  _b3AktivGame = 0;

  const s   = bane.spillere;
  const l1n = `${s[par.lag1[0]]?.navn ?? '?'} + ${s[par.lag1[1]]?.navn ?? '?'}`;
  const l2n = `${s[par.lag2[0]]?.navn ?? '?'} + ${s[par.lag2[1]]?.navn ?? '?'}`;

  // Last inn tidligere lagrede games fra cache
  const cached = kampStatusCache[`bane${bane.baneNr}_${par.nr}`];
  if (cached?.games?.length) {
    const innlastede = cached.games.filter(Boolean);
    for (let i = 0; i < innlastede.length; i++) _b3Games[i] = innlastede[i];
    // Sett aktivt game til neste uferdige (etter siste lagrede)
    const stilling = _b3Stilling();
    _b3AktivGame = stilling.ferdig ? innlastede.length - 1 : innlastede.length;
    _b3AktivGame = Math.min(_b3AktivGame, 2);
  }
  // Blokkert hvis allerede bekreftet
  _b3Bekreftet = cached?.bekreftet === true;

  _hentEllerLagB3Modal(l1n, l2n);
  _b3OppdaterUI();
  document.getElementById('modal-b3-konkurranse').style.display = 'flex';
}
window._apneBestAv3Modal = _apneBestAv3Modal;

function _hentEllerLagB3Modal(l1n, l2n) {
  if (document.getElementById('modal-b3-konkurranse')) {
    document.getElementById('b3-lag1-navn').textContent = l1n;
    document.getElementById('b3-lag2-navn').textContent = l2n;
    document.getElementById('b3-feil').textContent = '';
    return;
  }

  // Injiser CSS om ikke lastet
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

  const modal = document.createElement('div');
  modal.id = 'modal-b3-konkurranse';
  modal.className = 'modal-bakgrunn';
  modal.style.cssText = 'display:none';
  modal.innerHTML = `
    <div class="modal" style="border-radius:22px 22px 0 0">
      <div class="modal-tittel">Best av 3</div>
      <div id="b3-game-indikatorer" style="display:flex;justify-content:center;gap:10px;margin-bottom:8px"></div>
      <div id="b3-game-stilling" style="font-family:'Bebas Neue',cursive;font-size:22px;color:var(--white);text-align:center;letter-spacing:2px;margin-bottom:10px"></div>
      <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:start;margin-bottom:12px">
        <div>
          <div id="b3-lag1-navn" style="font-size:14px;color:var(--muted2);margin-bottom:8px;text-align:center;font-weight:500">${l1n}</div>
          <div class="poeng-velger-boks" id="b3-pvb-l1" onclick="b3ApnePicker('l1')">—</div>
          <div class="poeng-picker" id="b3-pp-l1" style="display:none"></div>
        </div>
        <div class="vs-deler" style="font-size:24px;padding-top:36px">—</div>
        <div>
          <div id="b3-lag2-navn" style="font-size:14px;color:var(--muted2);margin-bottom:8px;text-align:center;font-weight:500">${l2n}</div>
          <div class="poeng-velger-boks" id="b3-pvb-l2" onclick="b3ApnePicker('l2')">—</div>
          <div class="poeng-picker" id="b3-pp-l2" style="display:none"></div>
        </div>
      </div>
      <div id="b3-feil" style="color:var(--red2);font-size:14px;min-height:18px;margin-bottom:10px;text-align:center"></div>
      <div class="modal-knapper">
        <button class="knapp knapp-omriss" style="flex:1" onclick="b3LukkModal()">Avbryt</button>
        <button class="knapp knapp-gronn" id="b3-lagre-knapp" style="flex:2;font-family:'Bebas Neue',cursive;font-size:22px;letter-spacing:1px;opacity:0.4" disabled onclick="b3LagreKamp()">LAGRE</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

window.b3LukkModal = function() {
  const modal = document.getElementById('modal-b3-konkurranse');
  if (modal) modal.style.display = 'none';
  _b3LukkAllePickere();
};

/** Setter aktivt game til et tidligere registrert game for redigering. */
window.b3RedigerGame = function(gameIdx) {
  if (_b3Bekreftet) return;
  _b3AktivGame = gameIdx;
  _b3Games[gameIdx] = null; // nullstill slik at bruker registrerer på nytt
  _b3OppdaterUI();
  setTimeout(() => window.b3ApnePicker('l1'), 60);
};

window.b3ApnePicker = function(felt) {
  const annet = felt === 'l1' ? 'l2' : 'l1';
  document.getElementById(`b3-pp-${annet}`)?.style && (document.getElementById(`b3-pp-${annet}`).style.display = 'none');
  document.getElementById(`b3-pvb-${annet}`)?.classList.remove('aktiv');

  const picker = document.getElementById(`b3-pp-${felt}`);
  const boks   = document.getElementById(`b3-pvb-${felt}`);
  if (!picker || !boks) return;

  const erApen = picker.style.display !== 'none';
  if (erApen) { picker.style.display = 'none'; boks.classList.remove('aktiv'); return; }

  // Bygg tallgrid 0–11
  picker.innerHTML = '';
  const game = _b3Games[_b3AktivGame] ?? {};
  const gjeldende = felt === 'l1' ? game.l1 : game.l2;
  for (let n = 0; n <= 15; n++) {
    const el = document.createElement('div');
    el.className = 'poeng-picker-tall' + (n === gjeldende ? ' valgt' : '');
    el.textContent = n;
    el.onclick = (e) => { e.stopPropagation(); b3VelgPoeng(felt, n); };
    picker.appendChild(el);
  }
  picker.style.display = 'grid';
  boks.classList.add('aktiv');
};

window.b3VelgPoeng = function(felt, verdi) {
  if (_b3Bekreftet) return; // sluttresultat er bekreftet — ingen redigering
  if (!_b3Games[_b3AktivGame]) _b3Games[_b3AktivGame] = { l1: null, l2: null };
  _b3Games[_b3AktivGame][felt === 'l1' ? 'l1' : 'l2'] = verdi;

  const boks   = document.getElementById(`b3-pvb-${felt}`);
  const picker = document.getElementById(`b3-pp-${felt}`);
  if (boks)   boks.textContent = String(verdi);
  if (picker) picker.style.display = 'none';
  boks?.classList.remove('aktiv');

  const game = _b3Games[_b3AktivGame];
  if (game.l1 != null && game.l2 != null) {
    // Valider: pickleball best-av-3-regler
    // - Normal seier: vinner har 11, taper maks 9
    // - Deuce-seier: vinn med nøyaktig 2 (12-10, 13-11, 14-12, 15-13)
    // - Tak: 15-14
    const høy  = Math.max(game.l1, game.l2);
    const lav  = Math.min(game.l1, game.l2);
    const diff = høy - lav;
    const gyldig = (høy === 11 && lav <= 9) ||
                   (høy >= 12 && diff === 2) ||
                   (høy === 15 && diff === 1);
    if (!gyldig) {
      const feilTekst = høy < 11
        ? 'Vinneren må ha minst 11 poeng.'
        : høy > 15
          ? 'Maksimalt 15 poeng per game.'
          : lav === 10 && høy === 11
            ? 'Ved 10-10 (deuce) må man vinne med 2 — tidligst 12-10.'
            : `Ugyldig — gyldige resultater: 11-0 til 11-9, 12-10, 13-11, 14-12, 15-13, 15-14.`;
      document.getElementById('b3-feil').textContent = feilTekst;
      _b3Games[_b3AktivGame] = null;
      ['l1','l2'].forEach(f => {
        const b = document.getElementById(`b3-pvb-${f}`);
        if (b) b.textContent = '—';
      });
      setTimeout(() => window.b3ApnePicker('l1'), 60);
      return;
    }
    document.getElementById('b3-feil').textContent = '';

    // Autolagre dette gamet til Firestore
    _b3AutolagreGame(_b3AktivGame, game).then(() => {
      const stilling = _b3Stilling();
      if (stilling.ferdig) {
        // Alle games ferdige — oppdater UI og vent på manuell LAGRE
        _b3OppdaterUI();
      } else {
        // Gå tilbake til baneoversikten — neste game registreres ved neste klikk
        window.b3LukkModal();
        visMelding(`✓ Game ${_b3AktivGame + 1} lagret`);
      }
    });
  } else {
    // Åpne det andre feltet automatisk
    setTimeout(() => window.b3ApnePicker(felt === 'l1' ? 'l2' : 'l1'), 60);
  }
  _b3OppdaterUI();
};

async function _b3AutolagreGame(gameIdx, game) {
  if (!db || !app.treningId || !_b3Bane || !_b3Par) return;
  const baneNr = _b3Bane.baneNr;
  const par    = _b3Par;

  // Hent eller finn kamp-ID
  const kampId = await _hentKampDokIdB3(`bane${baneNr}`, par.nr);
  if (!kampId) { visMelding('Fant ikke kamp-dokument.', 'feil'); return; }

  // Bygg oppdatert games-array (kun de som er spilt)
  const gamesSpilt = _b3Games.filter(Boolean);
  const stilling   = _b3Stilling();

  // Oppdater Firestore — ferdig=false inntil bekreftet
  const batch = writeBatch(db);
  batch.update(doc(db, SAM.KAMPER, kampId), {
    games:      gamesSpilt,
    lag1Poeng:  stilling.lag1,
    lag2Poeng:  stilling.lag2,
    ferdig:     false,  // settes til true kun ved manuell LAGRE
    bekreftet:  false,
  });
  await batch.commit();

  // Oppdater cache
  kampStatusCache[`bane${baneNr}_${par.nr}`] = {
    ...(kampStatusCache[`bane${baneNr}_${par.nr}`] ?? {}),
    id: kampId,
    games: gamesSpilt,
    lag1Poeng: stilling.lag1,
    lag2Poeng: stilling.lag2,
    ferdig:    false,
    bekreftet: false,
    baneNr:    `bane${baneNr}`,
    kampNr:    par.nr,
  };

  // Oppdater baneoversikten i bakgrunnen
  visBaner();
}

function _b3LukkAllePickere() {
  ['l1','l2'].forEach(felt => {
    const p = document.getElementById(`b3-pp-${felt}`);
    const b = document.getElementById(`b3-pvb-${felt}`);
    if (p) p.style.display = 'none';
    if (b) b.classList.remove('aktiv');
  });
}

function _b3Stilling() {
  let lag1 = 0, lag2 = 0;
  _b3Games.filter(Boolean).forEach(g => {
    if (g.l1 > g.l2) lag1++;
    else if (g.l2 > g.l1) lag2++;
  });
  return { lag1, lag2, ferdig: lag1 === 2 || lag2 === 2 };
}

function _b3OppdaterUI() {
  const stilling = _b3Stilling();
  const fullteGames = _b3Games.filter(Boolean);

  // Indikatorer — klikk på ferdig game for å redigere (kun hvis ikke bekreftet)
  const indEl = document.getElementById('b3-game-indikatorer');
  if (indEl) {
    indEl.innerHTML = [0,1,2].map(i => {
      const g = _b3Games[i];
      let stil = 'width:22px;height:22px;border-radius:50%;border:2px solid var(--border2);display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;transition:background .2s';
      let tekst = i + 1;
      let onclick = '';
      if (g) {
        const farge = g.l1 > g.l2 ? 'var(--green)' : 'var(--red2)';
        stil += `;background:${farge};border-color:${farge};color:#fff`;
        tekst = `${g.l1}-${g.l2}`;
        stil += ';font-size:9px;width:36px;border-radius:10px';
        if (!_b3Bekreftet) {
          onclick = `onclick="b3RedigerGame(${i})"`;
          stil += ';cursor:pointer';
        }
      } else if (i === _b3AktivGame) {
        stil += ';border-color:var(--accent);background:rgba(37,99,235,.2);color:var(--accent)';
      }
      return `<span style="${stil}" ${onclick}>${tekst}</span>`;
    }).join('');
  }

  // Stilling
  const stEl = document.getElementById('b3-game-stilling');
  if (stEl) stEl.textContent = fullteGames.length ? `${stilling.lag1} – ${stilling.lag2}` : '';

  // Boks-tekst for aktivt game
  const game = _b3Games[_b3AktivGame] ?? {};
  const b1 = document.getElementById('b3-pvb-l1');
  const b2 = document.getElementById('b3-pvb-l2');
  if (b1) b1.textContent = game.l1 != null ? String(game.l1) : '—';
  if (b2) b2.textContent = game.l2 != null ? String(game.l2) : '—';

  // Lagre-knapp
  const lagreKnapp = document.getElementById('b3-lagre-knapp');
  if (lagreKnapp) {
    if (_b3Bekreftet) {
      lagreKnapp.disabled = true;
      lagreKnapp.style.opacity = '0.4';
      lagreKnapp.textContent = '✓ BEKREFTET';
    } else {
      lagreKnapp.disabled = !stilling.ferdig;
      lagreKnapp.style.opacity = stilling.ferdig ? '1' : '0.4';
      lagreKnapp.textContent = 'LAGRE';
    }
  }
}

window.b3LagreKamp = async function() {
  if (_b3Bekreftet) return;
  const stilling = _b3Stilling();
  if (!stilling.ferdig) return;

  const bane      = _b3Bane;
  const par       = _b3Par;
  const games     = _b3Games.filter(Boolean);
  const lag1Poeng = stilling.lag1;
  const lag2Poeng = stilling.lag2;

  try {
    const kampId = await _hentKampDokIdB3(`bane${bane.baneNr}`, par.nr);
    if (!kampId) { visMelding('Fant ikke kamp-dokument.', 'feil'); return; }

    // Bekreft sluttresultat — ferdig=true låser kampen og utløser rating-beregning
    const batch = writeBatch(db);
    batch.update(doc(db, SAM.KAMPER, kampId), {
      lag1Poeng, lag2Poeng, ferdig: true, bekreftet: true, games,
    });
    await batch.commit();

    // Oppdater cache og sett bekreftet-flagg
    _b3Bekreftet = true;
    kampStatusCache[`bane${bane.baneNr}_${par.nr}`] = {
      ...(kampStatusCache[`bane${bane.baneNr}_${par.nr}`] ?? {}),
      id: kampId, ferdig: true, bekreftet: true, lag1Poeng, lag2Poeng, games,
      baneNr: `bane${bane.baneNr}`, kampNr: par.nr,
    };

    visMelding('✓ Kamp bekreftet — resultater oppdatert');
    window.b3LukkModal();
    _naviger('baner');
    oppdaterPoengNav();
    visBaner();
  } catch (e) {
    console.error('[b3LagreKamp]', e);
    visMelding('Lagring feilet: ' + (e?.message ?? e), 'feil');
  }
};

/** Åpner best-av-3-modal fra LAGRE-knapp i banekortet. */
window._apneBestAv3FraKort = function(baneNr, kampNr) {
  const bane = (app.baneOversikt ?? []).find(b => b.baneNr === baneNr);
  if (!bane) return;
  const parter = getParter(bane.spillere.length);
  const par    = parter.find(p => p.nr === kampNr);
  if (par) _apneBestAv3Modal(bane, par);
};

async function _hentKampDokIdB3(baneNr, kampNr) {
  const cachenøkkel = `${baneNr}_${kampNr}`;
  if (kampStatusCache[cachenøkkel]?.id) return kampStatusCache[cachenøkkel].id;
  const snap = await getDocs(query(
    collection(db, SAM.KAMPER),
    where('treningId', '==', app.treningId),
    where('rundeNr',   '==', app.runde),
    where('baneNr',    '==', baneNr),
    where('kampNr',    '==', kampNr),
  ));
  return snap.docs[0]?.id ?? null;
}

// ── Poeng-picker: tallvelger 0–15 ──────────────────────────────
function _byggPickerCSS() {
  if (document.getElementById('poeng-picker-css')) return;
  const s = document.createElement('style');
  s.id = 'poeng-picker-css';
  s.textContent = `
    .poeng-velger-boks {
      cursor: pointer;
      background: var(--card2);
      border: 1.5px solid var(--border);
      border-radius: 10px;
      padding: 15px 12px;
      font-size: 39px;
      font-weight: 600;
      text-align: center;
      color: var(--white);
      min-height: 78px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: border-color 0.15s;
      user-select: none;
    }
    .poeng-velger-boks.aktiv {
      border-color: var(--blue, #378ADD);
    }
    .poeng-picker {
      margin-top: 8px;
      display: grid;
      grid-template-columns: repeat(8, 1fr);
      gap: 8px;
    }
    .poeng-picker-tall {
      cursor: pointer;
      border-radius: 6px;
      padding: 12px 3px;
      text-align: center;
      font-size: 23px;
      font-weight: 500;
      border: 0.5px solid var(--border);
      background: var(--card2);
      color: var(--white);
      transition: background 0.1s;
      user-select: none;
    }
    .poeng-picker-tall.valgt {
      background: var(--blue, #378ADD);
      border-color: var(--blue, #378ADD);
      color: #fff;
    }
  `;
  document.head.appendChild(s);
}

function _byggPickerGrid(kampIdx, lag) {
  const pickerId = `pp_${kampIdx}_${lag}`;
  const picker   = document.getElementById(pickerId);
  if (!picker) return;
  const gjeldende = parseInt(document.getElementById(`s${kampIdx}_${lag}`)?.value);
  picker.innerHTML = '';
  for (let n = 0; n <= 15; n++) {
    const el = document.createElement('div');
    el.className = 'poeng-picker-tall' + (n === gjeldende ? ' valgt' : '');
    el.textContent = n;
    el.onclick = (e) => { e.stopPropagation(); _velgPoeng(kampIdx, lag, n); };
    picker.appendChild(el);
  }
}

function _apnePicker(kampIdx, lag) {
  _byggPickerCSS();
  const annetLag = lag === 'l1' ? 'l2' : 'l1';
  // Lukk alltid picker for andre laget på samme kamp
  const annenPicker = document.getElementById(`pp_${kampIdx}_${annetLag}`);
  if (annenPicker) annenPicker.style.display = 'none';
  document.getElementById(`pvb_${kampIdx}_${annetLag}`)?.classList.remove('aktiv');

  const picker = document.getElementById(`pp_${kampIdx}_${lag}`);
  const boks   = document.getElementById(`pvb_${kampIdx}_${lag}`);
  if (!picker || !boks) return;

  const erApen = picker.style.display !== 'none';
  if (erApen) {
    picker.style.display = 'none';
    boks.classList.remove('aktiv');
  } else {
    _byggPickerGrid(kampIdx, lag);
    picker.style.display = 'grid';
    boks.classList.add('aktiv');
  }
}
window._apnePicker = _apnePicker;

function _velgPoeng(kampIdx, lag, verdi) {
  const input  = document.getElementById(`s${kampIdx}_${lag}`);
  const boks   = document.getElementById(`pvb_${kampIdx}_${lag}`);
  const picker = document.getElementById(`pp_${kampIdx}_${lag}`);
  if (!input || !boks) return;

  input.value      = verdi;
  boks.textContent = verdi;

  // Oppdater visuell markering i picker
  picker?.querySelectorAll('.poeng-picker-tall').forEach(el => {
    el.classList.toggle('valgt', parseInt(el.textContent) === verdi);
  });

  // Auto-fyll motstanderens poeng basert på makspoeng
  const annetLag   = lag === 'l1' ? 'l2' : 'l1';
  const kampKort   = document.getElementById(`kk-${kampIdx}`);
  const maks       = parseInt(kampKort?.dataset?.maks ?? app.poengPerKamp ?? 15);
  const annetVerdi = maks - verdi;
  const annetInput = document.getElementById(`s${kampIdx}_${annetLag}`);
  const annetBoks  = document.getElementById(`pvb_${kampIdx}_${annetLag}`);
  if (annetInput && annetBoks && annetVerdi >= 0) {
    annetInput.value      = annetVerdi;
    annetBoks.textContent = annetVerdi;
    const annetPicker = document.getElementById(`pp_${kampIdx}_${annetLag}`);
    annetPicker?.querySelectorAll('.poeng-picker-tall').forEach(el => {
      el.classList.toggle('valgt', parseInt(el.textContent) === annetVerdi);
    });
    validerInndata(kampIdx, annetLag);
  }

  // Kall validerInndata slik at autolagring fungerer som før
  validerInndata(kampIdx, lag);

  // Lukk picker etter kort forsinkelse
  setTimeout(() => {
    if (picker) picker.style.display = 'none';
    boks.classList.remove('aktiv');
  }, 250);
}
window._velgPoeng = _velgPoeng;
// Naviger til forrige/neste bane fra poengregistreringsskjermen.
// retning: -1 = forrige, +1 = neste
// Hvis neste og alle baner er ferdige: gå til resultater.
export function navigerBane(retning) {
  const baner     = app.baneOversikt ?? [];
  const gjeldende = app.aktivBane ?? 1;
  const idx       = baner.findIndex(b => b.baneNr === gjeldende);

  if (retning === -1) {
    // Alltid tilbake til oversikt — bruker velger kamp derfra
    _naviger('baner');
  } else {
    if (erAlleBanerFerdig()) {
      // Alle baner ferdig — gå til "se resultater"
      window.visRundeResultat();
      return;
    }
    // Alltid tilbake til oversikt — bruker velger kamp på neste bane derfra
    _naviger('baner');
  }
}
window.navigerBane = navigerBane;
// Oppdater Forrige/Neste-knappene basert på gjeldende bane og status
export function oppdaterPoengNav() {
  const baner     = app.baneOversikt ?? [];
  const gjeldende = app.aktivBane ?? 1;
  const idx       = baner.findIndex(b => b.baneNr === gjeldende);

  const forrigeKnapp = document.getElementById('poeng-forrige-knapp');
  const nesteKnapp   = document.getElementById('poeng-neste-knapp');
  if (!forrigeKnapp || !nesteKnapp) return;

  // Forrige: alltid tilgjengelig (bane 1 → tilbake til oversikt)
  forrigeKnapp.textContent = idx <= 0 ? '← Oversikt' : `← Bane ${baner[idx - 1]?.baneNr}`;

  if (erAlleBanerFerdig()) {
    nesteKnapp.textContent = '🏁 Se resultater';
    nesteKnapp.className   = 'knapp knapp-gronn';
  } else if (idx >= baner.length - 1) {
    nesteKnapp.textContent = '← Tilbake til oversikt';
    nesteKnapp.className   = 'knapp knapp-omriss';
  } else {
    nesteKnapp.textContent = `Bane ${baner[idx + 1]?.baneNr} →`;
    nesteKnapp.className   = 'knapp knapp-primaer';
  }
}
window.oppdaterPoengNav = oppdaterPoengNav;
// ════════════════════════════════════════════════════════
// REDIGER BANEFORDELING (admin)
// ════════════════════════════════════════════════════════

// Lokal arbeidskopi mens editoren er åpen
let _redigerBaner    = [];
let _redigerMaksPoeng = null; // null = bruk automatikk, tall = admin-overstyring

export function apneRedigerBaner() {
  if (!app.treningId) return;
  _naviger && window.krevAdmin
    ? window.krevAdmin('Rediger baner', 'Kun administrator kan endre banefordeling.', _visRedigerModal)
    : _visRedigerModal();
}
window.apneRedigerBaner = apneRedigerBaner;
window.visRedigerBanerModal = apneRedigerBaner;

function _visRedigerModal() {
  // Dyp kopi av baneOversikt så vi ikke muterer app-state før lagring
  _redigerBaner = (app.baneOversikt ?? []).map(b => ({
    ...b,
    spillere: [...(b.spillere ?? [])],
  }));
  // Start med gjeldende poengverdi fra første bane (bruker faktisk konfigurert verdi)
  _redigerMaksPoeng = (app.baneOversikt ?? [])[0]?.maksPoeng ?? app.poengPerKamp ?? 15;

  const modal = _byggRedigerModal();
  document.body.appendChild(modal);
  _oppdaterPoengVelger();
  _oppdaterRedigerVisning();
}

function _lukkRedigerModal() {
  document.getElementById('modal-rediger-baner')?.remove();
  _redigerBaner    = [];
  _redigerMaksPoeng = null;
}
window._lukkRedigerModal = _lukkRedigerModal;

/**
 * Åpner rediger-banefordeling med én spiller allerede fjernet.
 * Kalles fra deltaker-modalen når admin trykker «Ta ut nå».
 */
function _apneRedigerMedSpillerFjernet(spillerId) {
  // Lukk deltaker-modalen
  document.getElementById('modal-deltaker-admin')?.remove();

  // Bygg arbeidskopi med spilleren fjernet
  _redigerBaner = (app.baneOversikt ?? []).map(b => ({
    ...b,
    spillere: (b.spillere ?? []).filter(s => s.id !== spillerId),
  }));

  _redigerMaksPoeng = (app.baneOversikt ?? [])[0]?.maksPoeng ?? app.poengPerKamp ?? 15;
  const modal = _byggRedigerModal();
  document.body.appendChild(modal);
  _oppdaterPoengVelger();
  _oppdaterRedigerVisning();

  // Vis en hjelpetekst øverst i modalen
  const innhold = document.getElementById('rediger-baner-innhold');
  if (innhold) {
    const banner = document.createElement('div');
    banner.style.cssText = 'background:rgba(234,179,8,.12);border:1px solid rgba(234,179,8,.3);border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:14px;color:var(--yellow)';
    banner.textContent = '⚠️ Spilleren er fjernet. Fyll opp banen ved å dra inn en annen spiller, eller lagre slik det er.';
    innhold.prepend(banner);
  }
}
window._apneRedigerMedSpillerFjernet = _apneRedigerMedSpillerFjernet;

/**
 * Åpner rediger-banefordeling med én spiller allerede lagt til.
 * Spilleren plasseres på banen med færrest spillere (mest ledig plass).
 */
function _apneRedigerMedSpillerLagtTil(spillerId) {
  const spiller = (app.spillere ?? []).find(s => s.id === spillerId);
  if (!spiller) return;

  // Lukk deltaker-modalen
  document.getElementById('modal-deltaker-admin')?.remove();

  // Bygg arbeidskopi
  _redigerBaner = (app.baneOversikt ?? []).map(b => ({
    ...b,
    spillere: [...(b.spillere ?? [])],
  }));

  // Legg spilleren på banen med færrest spillere
  const maalBane = _redigerBaner.reduce((min, b) =>
    b.spillere.length < min.spillere.length ? b : min
  , _redigerBaner[0]);

  if (maalBane) {
    maalBane.spillere.push({
      id:     spiller.id,
      navn:   spiller.navn   ?? 'Ukjent',
      rating: spiller.rating ?? STARTRATING,
    });
  }

  _redigerMaksPoeng = (app.baneOversikt ?? [])[0]?.maksPoeng ?? app.poengPerKamp ?? 15;
  const modal = _byggRedigerModal();
  document.body.appendChild(modal);
  _oppdaterPoengVelger();
  _oppdaterRedigerVisning();

  // Vis hjelpetekst
  const innhold = document.getElementById('rediger-baner-innhold');
  if (innhold) {
    const banner = document.createElement('div');
    banner.style.cssText = 'background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:14px;color:var(--green2)';
    banner.textContent = `✓ ${spiller.navn} er lagt til på bane ${maalBane?.baneNr ?? ''}. Flytt til ønsket bane ved behov, og trykk Lagre.`;
    innhold.prepend(banner);
  }
}
window._apneRedigerMedSpillerLagtTil = _apneRedigerMedSpillerLagtTil;

function _byggRedigerModal() {
  const existing = document.getElementById('modal-rediger-baner');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'modal-rediger-baner';
  modal.style.cssText = `
    position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.85);
    display:flex;flex-direction:column;overflow-y:auto;padding:16px;box-sizing:border-box;
  `;
  modal.innerHTML = `
    <div style="max-width:560px;width:100%;margin:0 auto">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div style="font-size:20px;font-weight:700;color:var(--white)">✏️ Rediger banefordeling</div>
        <button onclick="_lukkRedigerModal()" style="background:none;border:1px solid var(--border);border-radius:8px;padding:6px 12px;color:var(--muted2);font-size:15px;cursor:pointer">✕ Avbryt</button>
      </div>
      <div id="rediger-poeng-velger" style="background:var(--navy3);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div>
          <div style="font-size:14px;font-weight:600;color:var(--white)">Poeng per kamp</div>
          <div id="rediger-poeng-hint" style="font-size:12px;color:var(--muted2);margin-top:2px"></div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <button onclick="_justerRedigerPoeng(-1)" style="width:36px;height:36px;border-radius:8px;border:1px solid var(--border2);background:var(--navy2);color:var(--white);font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center">−</button>
          <div id="rediger-poeng-verdi" style="font-family:'DM Mono',monospace;font-size:22px;font-weight:700;color:var(--yellow);min-width:36px;text-align:center"></div>
          <button onclick="_justerRedigerPoeng(1)" style="width:36px;height:36px;border-radius:8px;border:1px solid var(--border2);background:var(--navy2);color:var(--white);font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center">+</button>
        </div>
      </div>
      <div id="rediger-baner-innhold"></div>
      <div id="rediger-feil" style="color:var(--red);font-size:14px;margin:8px 0;min-height:20px"></div>
      <button onclick="_lagreRedigerBaner()" class="knapp knapp-gronn" style="width:100%;margin-top:8px;font-size:17px">
        💾 Lagre ny banefordeling
      </button>
    </div>
  `;
  return modal;
}

// ── Poeng-velger for rediger-modal ───────────────────────────────────────────

/**
 * Oppdaterer poeng-velger-UI basert på _redigerMaksPoeng og gjeldende banesammensetning.
 * Viser hint om automatisk 5-spillerjustering når relevante banetyper er blandet.
 */
function _oppdaterPoengVelger() {
  const verdiEl = document.getElementById('rediger-poeng-verdi');
  const hintEl  = document.getElementById('rediger-poeng-hint');
  if (!verdiEl) return;

  const mp = _redigerMaksPoeng ?? app.poengPerKamp ?? 15;
  verdiEl.textContent = mp;

  // Beregn banesammensetning for hint-tekst
  const har4      = (_redigerBaner ?? []).some(b => (b.spillere?.length ?? 0) === 4 && !b.erSingel);
  const har5      = (_redigerBaner ?? []).some(b => (b.spillere?.length ?? 0) === 5);
  const harSingel = (_redigerBaner ?? []).some(b => b.erSingel === true || (b.spillere?.length ?? 0) === 2);

  if (hintEl) {
    if (har4 && har5) {
      const mp5 = Math.round(mp * 3 / 5);
      hintEl.textContent = `4-spillerbaner: ${mp} p  ·  5-spillerbaner: ${mp5} p (auto)`;
    } else if (harSingel && har4) {
      hintEl.textContent = `Dobbel: ${mp} p  ·  Singel: ${mp} p`;
    } else if (har5 && !har4) {
      hintEl.textContent = `Alle baner: ${mp} p — ingen 4-spillerbane å ta hensyn til`;
    } else {
      hintEl.textContent = `Alle baner spiller til ${mp} poeng`;
    }
  }
}

/**
 * Justerer _redigerMaksPoeng med ±1 (min 5, maks 50) og oppdaterer UI.
 */
window._justerRedigerPoeng = function(delta) {
  const gjeld = _redigerMaksPoeng ?? app.poengPerKamp ?? 15;
  _redigerMaksPoeng = Math.max(5, Math.min(50, gjeld + delta));
  _oppdaterPoengVelger();
};

function _oppdaterRedigerVisning() {
  const innhold = document.getElementById('rediger-baner-innhold');
  if (!innhold) return;
  // Oppdater hint-tekst når banesammensetningen endres (f.eks. etter dra-og-slipp)
  _oppdaterPoengVelger();

  innhold.innerHTML = _redigerBaner.map((bane, bi) => {
    const spillerHTML = (bane.spillere ?? []).map((s, si) => `
      <div class="rediger-spiller-rad" data-bane="${bi}" data-spiller="${si}"
           draggable="true"
           ondragstart="_dragStart(event,${bi},${si})"
           ondragover="event.preventDefault()"
           ondrop="_dragDrop(event,${bi},${si})"
           ontouchstart="_touchStart(event,${bi},${si})"
           style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg2);border-radius:8px;margin-bottom:6px;cursor:grab;border:1px solid var(--border);touch-action:none">
        <span style="color:var(--muted);font-size:18px">⠿</span>
        <span style="flex:1;font-size:16px;color:var(--white)">${escHtml(s.navn ?? 'Ukjent')}</span>
        <span style="font-family:'DM Mono',monospace;font-size:13px;color:var(--muted2)">⭐ ${s.rating ?? STARTRATING}</span>
        <select onchange="_flyttSpiller(${bi},${si},this.value)"
                style="background:var(--bg3,#1a2740);border:1px solid var(--border);border-radius:6px;padding:4px 8px;color:var(--white);font-size:13px;cursor:pointer">
          ${_redigerBaner.map((_, ti) => `<option value="${ti}" ${ti === bi ? 'selected' : ''}>Bane ${ti + 1}</option>`).join('')}
        </select>
      </div>
    `).join('');

    const antall = (bane.spillere ?? []).length;
    const gyldig = antall === 4 || antall === 5 || antall === 2;
    const fargeBord = gyldig ? 'var(--border)' : 'var(--red)';

    return `
      <div style="border:1px solid ${fargeBord};border-radius:12px;padding:14px;margin-bottom:14px;background:var(--bg1,#0a1628)"
           data-bane-container="${bi}"
           ondragover="event.preventDefault()"
           ondrop="_dragDropBane(event,${bi})">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <div style="font-size:22px;font-weight:800;color:var(--accent2)">Bane ${bane.baneNr}</div>
          <div style="font-size:13px;color:${gyldig ? 'var(--muted2)' : 'var(--red)'}">${antall} spillere${!gyldig ? ' — ugyldig (trenger 4 eller 5)' : ''}</div>
        </div>
        ${spillerHTML}
      </div>
    `;
  }).join('');
}

// ── Dra og slipp (HTML5 + Touch for Android/iOS) ─────────────────────────────
let _dragFraBane    = null;
let _dragFraSpiller = null;

// ── HTML5 drag (desktop) ──────────────────────────────────────────────────────
window._dragStart = function(e, baneIdx, spillerIdx) {
  _dragFraBane    = baneIdx;
  _dragFraSpiller = spillerIdx;
  e.dataTransfer.effectAllowed = 'move';
};

window._dragDrop = function(e, tilBane, tilSpiller) {
  e.preventDefault();
  if (_dragFraBane === null) return;
  _byttSpillere(_dragFraBane, _dragFraSpiller, tilBane, tilSpiller);
  _dragFraBane = null;
};

window._dragDropBane = function(e, tilBane) {
  e.preventDefault();
  if (_dragFraBane === null || _dragFraBane === tilBane) return;
  const spiller = _redigerBaner[_dragFraBane].spillere.splice(_dragFraSpiller, 1)[0];
  _redigerBaner[tilBane].spillere.push(spiller);
  _dragFraBane = null;
  _oppdaterRedigerVisning();
};

// ── Touch drag (Android / iOS) ────────────────────────────────────────────────
let _touchDragEl   = null;
let _touchKlone    = null;
let _touchFraBane  = null;
let _touchFraIdx   = null;
let _touchOffsetX  = 0;
let _touchOffsetY  = 0;

function _touchStart(e, baneIdx, spillerIdx) {
  const touch = e.touches[0];
  _touchFraBane = baneIdx;
  _touchFraIdx  = spillerIdx;
  _touchDragEl  = e.currentTarget;

  const rect = _touchDragEl.getBoundingClientRect();
  _touchOffsetX = touch.clientX - rect.left;
  _touchOffsetY = touch.clientY - rect.top;

  // Lag en klon som flyter over siden
  _touchKlone = _touchDragEl.cloneNode(true);
  _touchKlone.style.cssText = `
    position: fixed;
    left: ${rect.left}px;
    top: ${rect.top}px;
    width: ${rect.width}px;
    opacity: 0.85;
    pointer-events: none;
    z-index: 9999;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    transition: none;
  `;
  document.body.appendChild(_touchKlone);
  _touchDragEl.style.opacity = '0.3';
  e.preventDefault();
}

function _touchMove(e) {
  if (!_touchKlone) return;
  const touch = e.touches[0];
  _touchKlone.style.left = (touch.clientX - _touchOffsetX) + 'px';
  _touchKlone.style.top  = (touch.clientY - _touchOffsetY) + 'px';
  e.preventDefault();
}

function _touchEnd(e) {
  if (!_touchKlone) return;
  const touch = e.changedTouches[0];

  // Fjern klonen og gjenopprett original
  _touchKlone.remove();
  _touchKlone = null;
  if (_touchDragEl) _touchDragEl.style.opacity = '';

  // Finn elementet under fingeren
  const maal = document.elementFromPoint(touch.clientX, touch.clientY);
  if (!maal) { _touchFraBane = null; return; }

  // Sjekk om vi slapp på en spillerrad
  const spillerRad = maal.closest('[data-bane][data-spiller]');
  if (spillerRad) {
    const tilBane    = parseInt(spillerRad.dataset.bane);
    const tilSpiller = parseInt(spillerRad.dataset.spiller);
    if (_touchFraBane !== null && !(tilBane === _touchFraBane && tilSpiller === _touchFraIdx)) {
      _byttSpillere(_touchFraBane, _touchFraIdx, tilBane, tilSpiller);
      _touchFraBane = null;
      return;
    }
  }

  // Sjekk om vi slapp på en bane-container (flytt til den banen)
  const baneContainer = maal.closest('[data-bane-container]');
  if (baneContainer) {
    const tilBane = parseInt(baneContainer.dataset.baneContainer);
    if (_touchFraBane !== null && tilBane !== _touchFraBane) {
      const spiller = _redigerBaner[_touchFraBane].spillere.splice(_touchFraIdx, 1)[0];
      _redigerBaner[tilBane].spillere.push(spiller);
      _oppdaterRedigerVisning();
      _touchFraBane = null;
      return;
    }
  }

  _touchFraBane = null;
}

document.addEventListener('touchmove', _touchMove, { passive: false });
document.addEventListener('touchend',  _touchEnd);

function _byttSpillere(fraBane, fraSpiller, tilBane, tilSpiller) {
  if (fraBane === tilBane && fraSpiller === tilSpiller) return;
  const fra = _redigerBaner[fraBane].spillere;
  const til = _redigerBaner[tilBane].spillere;

  if (fraBane === tilBane) {
    // Bytt rekkefølge innen samme bane
    [fra[fraSpiller], fra[tilSpiller]] = [fra[tilSpiller], fra[fraSpiller]];
  } else {
    // Bytt spillere mellom to baner
    const temp = fra[fraSpiller];
    fra[fraSpiller] = til[tilSpiller];
    til[tilSpiller] = temp;
  }
  _oppdaterRedigerVisning();
}

// ── Velg bane fra dropdown ────────────────────────────────────────────────────
window._flyttSpiller = function(fraBane, fraSpiller, tilBane) {
  tilBane = parseInt(tilBane, 10);
  if (fraBane === tilBane) return;
  const spiller = _redigerBaner[fraBane].spillere.splice(fraSpiller, 1)[0];
  _redigerBaner[tilBane].spillere.push(spiller);
  _oppdaterRedigerVisning();
};

// ── Lagre til Firestore ───────────────────────────────────────────────────────
window._lagreRedigerBaner = async function() {
  const feilEl = document.getElementById('rediger-feil');

  // Valider at alle baner har 4 eller 5 spillere (eller 2 for singel)
  const ugyldig = _redigerBaner.find(b => {
    const n = b.spillere?.length ?? 0;
    if (b.erSingel) return n !== 2;
    return n !== 4 && n !== 5;
  });
  if (ugyldig) {
    if (feilEl) feilEl.textContent = `Bane ${ugyldig.baneNr} har feil antall spillere.`;
    return;
  }
  if (feilEl) feilEl.textContent = '';

  const lagreBtn = document.querySelector('#modal-rediger-baner .knapp-gronn');
  if (lagreBtn) { lagreBtn.disabled = true; lagreBtn.textContent = 'Lagrer…'; }

  // Sjekk om spillersammensetningen faktisk er endret — om ikke, trenger vi
  // ikke slette og skrive kamp-dokumentene på nytt. Dette bevarer registrerte poeng
  // når admin kun justerer poengscoren via poeng-velgeren.
  const spillereSomFor = JSON.stringify(
    (app.baneOversikt ?? []).map(b => ({
      baneNr: b.baneNr,
      ids: (b.spillere ?? []).map(s => s.id).sort(),
    }))
  );
  const spillerNaa = JSON.stringify(
    (_redigerBaner ?? []).map(b => ({
      baneNr: b.baneNr,
      ids: (b.spillere ?? []).map(s => s.id).sort(),
    }))
  );
  const spillereEndret = spillereSomFor !== spillerNaa;

  try {
    const batch = writeBatch(db);

    if (spillereEndret) {
      // Spillersammensetning er endret — slett gamle kamper og skriv nye
      const eksisterendeSnap = await getDocs(query(
        collection(db, SAM.KAMPER),
        where('treningId', '==', app.treningId),
        where('rundeNr',   '==', app.runde),
      ));
      eksisterendeSnap.docs.forEach(d => batch.delete(d.ref));
    }

    // Skriv nye kamper kun hvis spillersammensetningen er endret
    if (spillereEndret) _redigerBaner.forEach(bane => {
      const n = bane.spillere?.length ?? 0;
      const erSingel  = bane.erSingel === true || n === 2;
      const erDobbel6 = app.er6SpillerFormat && bane.erDobbel === true;

      if (erSingel && n === 2) {
        batch.set(doc(collection(db, SAM.KAMPER)), {
          treningId: app.treningId,
          baneNr:    `bane${bane.baneNr}`,
          rundeNr:   app.runde,
          kampNr:    1,
          erSingel:  true,
          lag1_s1: bane.spillere[0].id,  lag1_s2: null,
          lag2_s1: bane.spillere[1].id,  lag2_s2: null,
          lag1_s1_navn: bane.spillere[0].navn, lag1_s2_navn: null,
          lag2_s1_navn: bane.spillere[1].navn, lag2_s2_navn: null,
          lag1Poeng: null, lag2Poeng: null, ferdig: false,
        });
      } else {
        const parter = erDobbel6 ? PARTER_6_DOBBEL : getParter(n);
        parter.forEach(par => {
          const dokData = {
            treningId: app.treningId,
            baneNr:    `bane${bane.baneNr}`,
            rundeNr:   app.runde,
            kampNr:    par.nr,
            erSingel:  false,
            lag1_s1: bane.spillere[par.lag1[0]].id,  lag1_s2: bane.spillere[par.lag1[1]].id,
            lag2_s1: bane.spillere[par.lag2[0]].id,  lag2_s2: bane.spillere[par.lag2[1]].id,
            lag1_s1_navn: bane.spillere[par.lag1[0]].navn, lag1_s2_navn: bane.spillere[par.lag1[1]].navn,
            lag2_s1_navn: bane.spillere[par.lag2[0]].navn, lag2_s2_navn: bane.spillere[par.lag2[1]].navn,
            lag1Poeng: null, lag2Poeng: null, ferdig: false,
          };
          if (par.hviler != null && bane.spillere[par.hviler]) {
            dokData.hviler_id   = bane.spillere[par.hviler].id;
            dokData.hviler_navn = bane.spillere[par.hviler].navn;
          }
          batch.set(doc(collection(db, SAM.KAMPER)), dokData);
        });
      }
    }); // slutt if (spillereEndret) forEach

    // Oppdater maksPoeng basert på admin-valgt poengverdi og antall spillere per bane.
    // Hvis det finnes både 4- og 5-spillerbaner: behold 3/5-justeringen for 5-spillerbaner.
    // Hvis alle baner er 5-spillerbaner (eller alle 4): bruk valgt verdi direkte.
    const mp   = _redigerMaksPoeng ?? app.poengPerKamp ?? 15;
    const har4 = _redigerBaner.some(b => (b.spillere?.length ?? 0) === 4);
    const har5 = _redigerBaner.some(b => (b.spillere?.length ?? 0) === 5);
    _redigerBaner.forEach(b => {
      const n = b.spillere?.length ?? 0;
      if (n === 4) {
        b.maksPoeng = mp;
      } else if (n === 5) {
        // Kun juster ned hvis det faktisk finnes 4-spillerbaner på samme økt
        b.maksPoeng = (har4 && har5) ? Math.round(mp * 3 / 5) : mp;
      } else if (n === 2 || b.erSingel === true) {
        // 6-spiller singelbane — samme poengmål som admin har valgt
        b.maksPoeng = mp;
      }
    });

    // Oppdater baneOversikt i treningsdokumentet
    batch.update(doc(db, SAM.TRENINGER, app.treningId), {
      baneOversikt:         _redigerBaner,
      sisteAktivitetDato:   serverTimestamp(),
    });

    await batch.commit();

    app.baneOversikt = _redigerBaner;
    kampStatusCache  = {};
    _lukkRedigerModal();
    visBaner();
    visMelding('Banefordeling oppdatert ✓');
  } catch (e) {
    console.error('[redigerBaner]', e);
    if (feilEl) feilEl.textContent = 'Lagring feilet: ' + (e?.message ?? e);
    if (lagreBtn) { lagreBtn.disabled = false; lagreBtn.textContent = '💾 Lagre ny banefordeling'; }
  }
};

// ════════════════════════════════════════════════════════
// ADMINISTRER DELTAKERE — modal for å legge til / fjerne spillere
// ════════════════════════════════════════════════════════

export function visDeltakerModal() {
  if (!app.treningId) return;
  window.krevAdmin('Administrer deltakere', 'Kun administrator kan endre deltakere.', _visModalInnhold);
}
window.visDeltakerModal = visDeltakerModal;

function _visModalInnhold() {
  const eksisterende = document.getElementById('modal-deltaker-admin');
  if (eksisterende) eksisterende.remove();

  const modal = document.createElement('div');
  modal.id = 'modal-deltaker-admin';
  modal.className = 'modal-bakgrunn';
  modal.style.cssText = 'display:flex';
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  modal.innerHTML = `
    <div class="modal" style="max-height:85vh;display:flex;flex-direction:column;border-radius:22px 22px 0 0">
      <div class="modal-tittel" style="flex-shrink:0">👥 Administrer deltakere</div>
      <div style="flex:1;overflow-y:auto;padding-bottom:8px" id="deltaker-modal-innhold"></div>
      <div style="flex-shrink:0;padding-top:8px">
        <button class="knapp knapp-omriss" style="width:100%" onclick="document.getElementById('modal-deltaker-admin').remove()">Lukk</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  _oppdaterDeltakerModalInnhold();
}

function _oppdaterDeltakerModalInnhold() {
  const el = document.getElementById('deltaker-modal-innhold');
  if (!el) return;

  const ekskl       = app.ekskluderteIds ?? new Set();
  const alleIBaner  = (app.baneOversikt ?? []).flatMap(b => b.spillere ?? []);
  const paVenteliste = app.venteliste ?? [];

  // Spillere som er aktivt i rotasjonen (bane eller venteliste, men ikke ekskludert)
  const idsIOkt = new Set([
    ...alleIBaner.map(s => s.id),
    ...paVenteliste.map(s => s.id),
  ]);
  // Utenfor = ikke på bane og ikke på venteliste (ekskluderte vises under bane-seksjonen)
  const utenfor = (app.spillere ?? []).filter(s => !idsIOkt.has(s.id));

  let html = '';

  // ── Aktive på baner ──────────────────────────────────
  if (alleIBaner.length > 0) {
    html += `<div class="seksjon-etikett" style="margin-top:4px">På bane nå</div>`;
    (app.baneOversikt ?? []).forEach(bane => {
      (bane.spillere ?? []).forEach(s => {
        const skalFjernes = ekskl.has(s.id);
        html += _deltakerRad(s, skalFjernes
          ? `<span style="color:var(--orange);font-size:13px">Tas ut etter runden</span>`
          : `<span style="color:var(--muted2);font-size:13px">Bane ${bane.baneNr}</span>`,
          skalFjernes
            ? `<button class="knapp knapp-omriss knapp-liten" style="font-size:13px;padding:5px 10px" onclick="_angre('${s.id}')">Angre</button>`
            : `<button class="knapp knapp-liten" style="background:rgba(220,38,38,.15);color:var(--red2);border:1px solid rgba(220,38,38,.3);font-size:13px;padding:5px 10px" onclick="_apneRedigerMedSpillerFjernet('${s.id}')">Ta ut nå</button>`
        );
      });
    });
  }

  // ── Venteliste ───────────────────────────────────────
  if (paVenteliste.length > 0) {
    html += `<div class="seksjon-etikett" style="margin-top:12px">Venteliste</div>`;
    paVenteliste.forEach(s => {
      const skalFjernes = ekskl.has(s.id);
      html += _deltakerRad(s,
        `<span style="color:var(--muted2);font-size:13px">Venteliste</span>`,
        `<button class="knapp knapp-liten" style="background:rgba(220,38,38,.15);color:var(--red2);border:1px solid rgba(220,38,38,.3);font-size:13px;padding:5px 10px" onclick="_fjernFraOkt('${s.id}')">Fjern</button>`
      );
    });
  }

  // ── Ikke med i økt ───────────────────────────────────
  if (utenfor.length > 0) {
    html += `<div class="seksjon-etikett" style="margin-top:12px">Ikke med — legg til</div>`;
    utenfor.forEach(s => {
      html += _deltakerRad(s,
        `<span style="color:var(--muted2);font-size:13px">⭐ ${s.rating ?? STARTRATING}</span>`,
        `<button class="knapp knapp-gronn knapp-liten" style="font-size:13px;padding:5px 10px" onclick="_apneRedigerMedSpillerLagtTil('${s.id}')">+ Legg til nå</button>`
      );
    });
  }

  // ── Legg til ny eller eksisterende spiller ──────────
  html += `<div class="seksjon-etikett" style="margin-top:12px">Legg til spiller</div>
  <div style="padding:8px 0">
    <div style="display:flex;gap:8px;margin-bottom:6px">
      <input id="deltaker-sok" type="text" placeholder="Søk på navn…"
        style="flex:1;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--navy3);color:var(--white);font-size:16px;font-family:inherit"
        oninput="_deltakerSok(this.value)" autocomplete="off"/>
    </div>
    <div id="deltaker-sok-resultat"></div>
    <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
      <input id="deltaker-ny-navn" type="text" placeholder="Nytt navn (ikke registrert)"
        style="flex:1;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--navy3);color:var(--white);font-size:16px;font-family:inherit"
        autocomplete="off"/>
      <button class="knapp knapp-gronn" style="padding:10px 14px;font-size:15px;white-space:nowrap"
        onclick="_leggTilNySpillerIOkt()">+ Ny</button>
    </div>
  </div>`;

  el.innerHTML = html;

  // Fyll søkeresultat med utenfor-liste som standard
  _deltakerSok('');}

function _deltakerSok(q) {
  const el = document.getElementById('deltaker-sok-resultat');
  if (!el) return;
  const ekskl       = app.ekskluderteIds ?? new Set();
  const alleIBaner  = (app.baneOversikt ?? []).flatMap(b => b.spillere ?? []);
  const paVenteliste = app.venteliste ?? [];
  const idsIOkt = new Set([
    ...alleIBaner.map(s => s.id),
    ...paVenteliste.map(s => s.id),
  ]);
  const qLow = (q ?? '').toLowerCase().trim();
  const treff = (app.spillere ?? [])
    .filter(s => !idsIOkt.has(s.id))
    .filter(s => !qLow || (s.navn ?? '').toLowerCase().includes(qLow));

  if (!treff.length) {
    el.innerHTML = qLow
      ? `<div style="padding:6px 0;font-size:14px;color:var(--muted2)">Ingen treff — bruk «Ny»-feltet for å legge til.</div>`
      : `<div style="padding:6px 0;font-size:14px;color:var(--muted2)">Alle registrerte spillere er allerede med i økten.</div>`;
    return;
  }
  el.innerHTML = treff.map(s =>
    `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:16px;color:var(--white)">${escHtml(s.navn ?? 'Ukjent')}</span>
      <button class="knapp knapp-gronn knapp-liten" style="font-size:13px;padding:5px 10px"
        onclick="_apneRedigerMedSpillerLagtTil('${s.id}')">+ Legg til nå</button>
    </div>`
  ).join('');
}
window._deltakerSok = _deltakerSok;

function _deltakerRad(s, subHTML, knappHTML) {
  const ini = (s.navn ?? '?').split(' ').map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';
  return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
    <div style="width:36px;height:36px;border-radius:50%;background:rgba(96,165,250,.15);color:#60a5fa;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0">${escHtml(ini)}</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:16px;font-weight:500;color:var(--white)">${escHtml(s.navn ?? 'Ukjent')}</div>
      ${subHTML}
    </div>
    ${knappHTML}
  </div>`;
}

window._leggTilIOkt = async function(spillerId) {
  await window.leggTilSpillerIOkt(spillerId);
  _oppdaterDeltakerModalInnhold();
};

window._fjernFraOkt = async function(spillerId) {
  await window.fjernSpillerFraOkt(spillerId);
  _oppdaterDeltakerModalInnhold();
};

window._angre = async function(spillerId) {
  app.ekskluderteIds?.delete(spillerId);
  const spiller = (app.spillere ?? []).find(s => s.id === spillerId);
  if (spiller) visMelding(`${spiller.navn} er tilbake i rotasjonen.`);
  // Lagre til Firestore
  if (db && app.treningId) {
    try {
      await updateDoc(doc(db, SAM.TRENINGER, app.treningId), {
        ekskluderteIds: [...(app.ekskluderteIds ?? new Set())],
      });
    } catch (e) { console.warn('[angre]', e?.message); }
  }
  _oppdaterDeltakerModalInnhold();
};

window._leggTilNySpillerIOkt = async function() {
  const inp  = document.getElementById('deltaker-ny-navn');
  const navn = (inp?.value ?? '').trim();
  if (!navn) { visMelding('Skriv inn et navn.', 'advarsel'); return; }
  if (navn.length > 50) { visMelding('Navnet er for langt.', 'advarsel'); return; }

  // Hent aktivKlubbId via window (satt av app.js)
  const klubbId = _getAktivKlubbId();
  if (!db || !klubbId) { visMelding('Ikke tilkoblet.', 'feil'); return; }

  try {
    const ref = await addDoc(collection(db, SAM.SPILLERE), {
      navn, rating: STARTRATING, klubbId, opprettetDato: serverTimestamp(),
    });
    // Legg til lokalt i app.spillere
    app.spillere.push({ id: ref.id, navn, rating: STARTRATING });
    if (inp) inp.value = '';
    // Åpne rediger-modal med ny spiller lagt til med en gang
    _apneRedigerMedSpillerLagtTil(ref.id);
  } catch (e) {
    visMelding('Feil ved opprettelse: ' + (e?.message ?? e), 'feil');
  }
};
