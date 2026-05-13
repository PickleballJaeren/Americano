// ════════════════════════════════════════════════════════
// state.js — Delt applikasjonstilstand
// Én enkelt sannhetskilde for alle moduler.
// Import: import { app } from './state.js';
// ════════════════════════════════════════════════════════

export const app = {
  spillere:          [],
  valgtIds:          new Set(),
  antallBaner:       3,
  poengPerKamp:      15,
  maksRunder:        4,
  runde:             1,
  treningId:         null,
  baneOversikt:      [],
  venteliste:        [],
  rangerteBaner:     [],
  ratingEndringer:   [],
  aktivBane:         null,
  lyttere:           [],
  er6SpillerFormat:  false,
  // 'americano' | 'best_of_3'
  scoringsFormat:    'americano',
  // true når økt er aktiv og baner vises
  _oektAktiv:        false,
  // 'konkurranse' | 'mix'
  spillModus:        'konkurranse',
  // Aktiv turnering — settes av turnering-ui.js
  aktivTurnering:    null,
  // Spillere tatt ut av rotasjonen midt i økten (Set av spillerId-strenger)
  ekskluderteIds:    new Set(),
};

/** Returnerer true når gjeldende økt kjøres i Mix & Match-modus. */
export const erMix = () => app.spillModus === 'mix';
