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
  // 'konkurranse' | 'mix' | 'mix-ab'
  spillModus:        'konkurranse',
  // Aktiv turnering — settes av turnering-ui.js
  aktivTurnering:    null,
  // Spillere tatt ut av rotasjonen midt i økten (Set av spillerId-strenger)
  ekskluderteIds:    new Set(),
  // Mix & Match rotasjonsmodus: 'dynamisk' | 'fast'
  // 'fast' bruker MIX_7_ROTASJON fra konstanter.js (kun for 7 spl, 1 bane)
  mixRotasjonsModus:   'dynamisk',
  // Tilfeldig tildelt spillerrekkefølge for fast rotasjon [id, id, id, id, id, id, id]
  // Posisjon 0 = A, 1 = B, ... 6 = G i rotasjonstabellen
  mixRotasjonSpillere: [],
  // Mix A/B — spillerfordeling per gruppe (arrays av spillerId-strenger)
  mixAbGruppeA:      [],
  mixAbGruppeB:      [],
  // Mix A/B — antall baner per gruppe (settes i oppsett)
  mixAbBanerA:       1,
  kvalFase:          'innledning',
  kvalGruppeA:       [],
  kvalGruppeB:       [],
  kvalToppgruppe:    [],
  kvalBunngruppe:    [],
  kvalSluttfaseStartRunde: null,
};

/** Returnerer true når gjeldende økt kjøres i Mix & Match-modus (inkl. Mix A/B). */
export const erMix   = () => app.spillModus === 'mix' || app.spillModus === 'mix-ab';
/** Returnerer true kun for Mix A/B-modus. */
export const erMixAB = () => app.spillModus === 'mix-ab';
export const erKval  = () => app.spillModus === 'kvalifisering';
