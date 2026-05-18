// ════════════════════════════════════════════════════════
// konstanter.js — Domenekonstanter
// Alle applikasjonskonstanter samlet på ett sted.
// firebase.js re-eksporterer herfra for bakoverkompatibilitet.
// ════════════════════════════════════════════════════════

export const STARTRATING = 1000;

// Standard americano-rotasjon for 4 spillere (3 kamper)
export const PARTER = [
  { nr: 1, lag1: [0, 1], lag2: [2, 3] },
  { nr: 2, lag1: [0, 2], lag2: [1, 3] },
  { nr: 3, lag1: [0, 3], lag2: [1, 2] },
];

// Rotasjon for 5 spillere — én spiller hviler per kamp (5 kamper)
export const PARTER_5 = [
  { nr: 1, lag1: [0, 1], lag2: [2, 3], hviler: 4 },
  { nr: 2, lag1: [0, 2], lag2: [1, 4], hviler: 3 },
  { nr: 3, lag1: [0, 3], lag2: [2, 4], hviler: 1 },
  { nr: 4, lag1: [0, 4], lag2: [1, 3], hviler: 2 },
  { nr: 5, lag1: [1, 2], lag2: [3, 4], hviler: 0 },
];

// 6-spiller spesialformat: dobbelbane har kun én kamp
export const PARTER_6_DOBBEL = [
  { nr: 1, lag1: [0, 1], lag2: [2, 3], singel: false },
];

// 6-spiller spesialformat: singelbane har én kamp (1 vs 1)
export const PARTER_6_SINGEL = [
  { nr: 1, lag1: [0], lag2: [1], singel: true },
];


// Admin avslutter manuelt — ingen automatisk grense på antall runder.
// Verdien 99 brukes direkte i trening.js som intern «ingen grense»-markør.

// ════════════════════════════════════════════════════════
// MIX & MATCH — FAST 7-SPILLERS ROTASJON
//
// Matematisk optimal rotasjon for 7 spillere på 1 bane.
// Indeksene refererer til posisjoner 0–6 i en tilfeldig
// blandet spillerliste som tildeles ved øktstart.
//
// Per runde: 4 aktive (posisjonene i lag1+lag2), 3 hviler.
// Over 7 runder: alle spiller nøyaktig 4 kamper og hviler 3.
// Ingen partnerpar gjentas innad i én rotasjon.
// Ved gjentakelse (runde 8 = runde 1 osv.) er fordelingen
// fortsatt perfekt balansert over 14 runder.
// ════════════════════════════════════════════════════════
// Matematisk optimal rotasjon for 7 spillere på 1 bane.
// Garantier (verifisert med uttømmende søk):
//   • Alle hviler nøyaktig 3 ganger over 7 runder
//   • Ingen hviler mer enn 1 runde på rad (teoretisk optimum)
//   • Ingen partnerpar gjentas innad i én rotasjon
//   • Alle spiller nøyaktig 4 kamper
export const MIX_7_ROTASJON = [
  { lag1: [3, 6], lag2: [2, 5], hviler: [0, 1, 4] }, // runde 1
  { lag1: [0, 6], lag2: [1, 4], hviler: [2, 3, 5] }, // runde 2
  { lag1: [2, 4], lag2: [3, 5], hviler: [0, 1, 6] }, // runde 3
  { lag1: [0, 2], lag2: [1, 6], hviler: [3, 4, 5] }, // runde 4
  { lag1: [1, 3], lag2: [4, 5], hviler: [0, 2, 6] }, // runde 5
  { lag1: [0, 5], lag2: [2, 6], hviler: [1, 3, 4] }, // runde 6
  { lag1: [3, 4], lag2: [0, 1], hviler: [2, 5, 6] }, // runde 7
];

// Rotasjonsmodus for Mix & Match
export const MIX_ROTASJON_DYNAMISK = 'dynamisk';
export const MIX_ROTASJON_FAST     = 'fast';
