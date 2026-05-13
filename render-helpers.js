// ════════════════════════════════════════════════════════
// render-helpers.js — Delte HTML-renderings-funksjoner
// Brukes av arkiv.js, turnering-ui.js og eventuelt andre
// moduler som trenger å vise kampresultater.
//
// Import-eksempel:
//   import { renderKampRad, renderKampRadDetalj, renderMetaChip } from './render-helpers.js';
// ════════════════════════════════════════════════════════

import { escHtml } from './ui.js';

// ════════════════════════════════════════════════════════
// INITIALER
// ════════════════════════════════════════════════════════

/**
 * Lager 1–2-bokstavers initialer fra et fullt navn.
 * Brukes i avatarer over hele appen.
 * @param {string} navn
 * @returns {string}  — f.eks. "BH" eller "?"
 */
export function lagInitialer(navn) {
  return (navn ?? '?')
    .split(' ')
    .map(w => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';
}

// ════════════════════════════════════════════════════════
// META-CHIPS
// ════════════════════════════════════════════════════════

/**
 * Rendrer én meta-chip (baner, runder, spillere, osv.).
 * @param {string} ikon   — Emoji eller tekst
 * @param {string} tekst  — Chip-label
 * @returns {string} HTML
 */
export function renderMetaChip(ikon, tekst) {
  return `<div class="meta-chip">
    <span class="meta-chip-ikon">${ikon}</span>${escHtml(String(tekst))}
  </div>`;
}

/**
 * Rendrer en rekke meta-chips fra en liste av { ikon, tekst }-objekter.
 * @param {Array<{ikon: string, tekst: string}>} chips
 * @returns {string} HTML
 */
export function renderMetaChips(chips) {
  return chips.map(c => renderMetaChip(c.ikon, c.tekst)).join('');
}

// ════════════════════════════════════════════════════════
// KAMPRAD — enkel variant (brukes i turnerings- og øktarkiv)
// ════════════════════════════════════════════════════════

/**
 * Rendrer én kamp-rad med lagnavn og poengresultat.
 * Brukes i puljestabeller (arkiv og turnering-ui).
 *
 * @param {string}  lag1Navn
 * @param {string}  lag2Navn
 * @param {number}  lag1Poeng
 * @param {number}  lag2Poeng
 * @param {string}  [ekstraStyle]  — valgfri CSS for wrapper-div, f.eks. "margin-bottom:6px"
 * @returns {string} HTML
 */
export function renderKampRad(lag1Navn, lag2Navn, lag1Poeng, lag2Poeng, ekstraStyle = 'margin-bottom:6px') {
  const v1 = lag1Poeng > lag2Poeng;
  return `<div class="kamp-rad" style="${ekstraStyle}">
    <div style="flex:1">
      <div class="kamp-lag-${v1 ? 'vinner' : 'taper'}" style="font-size:16px">${escHtml(lag1Navn)}</div>
      <div class="kamp-lag-${v1 ? 'taper' : 'vinner'}" style="font-size:16px">${escHtml(lag2Navn)}</div>
    </div>
    <div class="poeng-kolonne">
      <span>${lag1Poeng}</span><span>${lag2Poeng}</span>
    </div>
  </div>`;
}

// ════════════════════════════════════════════════════════
// KAMPRAD — detaljert variant (brukes i økt-detalj i arkiv)
// ════════════════════════════════════════════════════════

/**
 * Rendrer én kamp-rad med kampnummer, spillernavn, hviler-info og poengresultat.
 * Brukes i økt-detalj-visningen i arkiv.js.
 *
 * @param {object} kamp — Firestore kamp-dokument
 * @returns {string} HTML
 */
export function renderKampRadDetalj(kamp) {
  const l1Navn = `${escHtml(kamp.lag1_s1_navn ?? '?')} + ${escHtml(kamp.lag1_s2_navn ?? '?')}`;
  const l2Navn = `${escHtml(kamp.lag2_s1_navn ?? '?')} + ${escHtml(kamp.lag2_s2_navn ?? '?')}`;
  const l1Vant = kamp.lag1Poeng > kamp.lag2Poeng;
  const l2Vant = kamp.lag2Poeng > kamp.lag1Poeng;

  const hvilerHTML = kamp.hviler_navn
    ? `<div style="font-size:13px;color:var(--orange);margin-top:4px">
        💤 ${escHtml(kamp.hviler_navn)} hvilte — fikk ${kamp.hvilerPoeng ?? '?'} poeng
       </div>`
    : '';

  return `<div class="kamp-rad" style="padding:10px 16px">
    <div class="kamp-nummer" style="font-size:13px">K${kamp.kampNr}</div>
    <div style="flex:1;min-width:0">
      <div class="kamp-lag-${l1Vant ? 'vinner' : 'taper'}" style="font-size:15px">${l1Navn}</div>
      <div style="font-size:13px;color:var(--muted);margin:2px 0">mot</div>
      <div class="kamp-lag-${l2Vant ? 'vinner' : 'taper'}" style="font-size:15px">${l2Navn}</div>
      ${hvilerHTML}
    </div>
    <div class="poeng-kolonne" style="font-size:20px;font-weight:700;flex-shrink:0">
      ${kamp.lag1Poeng}–${kamp.lag2Poeng}
    </div>
  </div>`;
}

// ════════════════════════════════════════════════════════
// TOM TILSTAND
// ════════════════════════════════════════════════════════

/**
 * Rendrer en tom-tilstand-melding.
 * @param {string}  tekst
 * @param {boolean} [stor=false]  — større padding for hele-skjerm-tomtilstand
 * @returns {string} HTML
 */
export function renderTomTilstand(tekst, stor = false) {
  return `<div class="${stor ? 'tom-tilstand' : 'tom-tilstand-liten'}">${escHtml(tekst)}</div>`;
}
