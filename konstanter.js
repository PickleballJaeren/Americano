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
