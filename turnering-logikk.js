// ════════════════════════════════════════════════════════
// turnering-logikk.js — Ren turneringslogikk
// Ingen Firebase-avhengigheter, ingen async/await.
// Alle funksjoner er rene beregninger som kan testes isolert.
//
// Importeres av turnering.js og turnering-ui.js.
// ════════════════════════════════════════════════════════

import { blandArray } from './rotasjon.js';

// ════════════════════════════════════════════════════════
// KONSTANTER
// ════════════════════════════════════════════════════════
export const T_STATUS = {
  SETUP:           'setup',
  GROUP_PLAY:      'group_play',
  PLAYOFF_SEEDING: 'playoff_seeding',
  PLAYOFFS:        'playoffs',
  FINISHED:        'finished',
};

export const SEEDING_MODUS = {
  STANDARD: 'standard',
  TREKNING:  'trekning',
  KRYSS:     'kryss',
};

export const STANDARD_KAMPFORMAT = {
  type:          'single',
  points_to_win: 11,
  win_by:        2,
  max_points:    15,
};

/** Bygg kampformat-objekt fra poeng-valg. */
export function lagKampformat(type, points_to_win) {
  const max_points = points_to_win === 15 ? 18 : 15;
  return { type, points_to_win, win_by: 2, max_points };
}

// ════════════════════════════════════════════════════════
// VALIDERING AV RESULTAT
// ════════════════════════════════════════════════════════
export function validerResultat(p1, p2, format) {
  const f = { ...STANDARD_KAMPFORMAT, ...(format ?? {}) };
  const { points_to_win, win_by, max_points } = f;

  if (isNaN(p1) || isNaN(p2) || p1 < 0 || p2 < 0)
    return { ok: false, feil: 'Poeng må være positive tall.' };

  const vinner = Math.max(p1, p2);
  const taper  = Math.min(p1, p2);
  const diff   = vinner - taper;

  if (vinner > max_points)
    return { ok: false, feil: `Maks ${max_points} poeng for vinner.` };
  if (vinner < points_to_win)
    return { ok: false, feil: `Vinner trenger minst ${points_to_win} poeng.` };

  // Cap-situasjon: begge nådde max_points-1 (f.eks. 14–14 ved til-15)
  if (taper === max_points - 1) {
    if (vinner !== max_points)
      return { ok: false, feil: `Ved ${taper}–${taper} må vinner ha nøyaktig ${max_points}.` };
    return { ok: true };
  }

  // Deuce-situasjon: taper har nådd points_to_win-1 eller mer
  if (taper >= points_to_win - 1) {
    if (diff !== win_by)
      return { ok: false, feil: `Etter ${taper}–${taper} må vinner lede med nøyaktig ${win_by} (f.eks. ${taper + win_by}–${taper}).` };
    return { ok: true };
  }

  // Normalt spill
  if (vinner !== points_to_win)
    return { ok: false, feil: `Ugyldig resultat: kampen avsluttes ved ${points_to_win} når motstanderen ikke har nådd ${points_to_win - 1}.` };
  if (diff < win_by)
    return { ok: false, feil: `Vinn med minst ${win_by} poeng.` };

  return { ok: true };
}

// ════════════════════════════════════════════════════════
// HENT KAMPFORMAT FOR RUNDE
// ════════════════════════════════════════════════════════
export function hentFormatForRunde(rundeNavn, konfig, kampFormat = null) {
  if (kampFormat) return kampFormat;

  const finale      = ['1. plass', '3. plass', '5. plass', '7. plass', '9. plass', '17. plass', 'Finale'];
  const semifinale  = ['Semifinale'];
  const kvartfinale = ['Kvartfinale', 'Åttedelsfinale', 'Plass 5–8'];

  if (finale.includes(rundeNavn))      return konfig?.kampformatFinale      ?? lagKampformat('single', 15);
  if (semifinale.includes(rundeNavn))  return konfig?.kampformatSemifinale  ?? STANDARD_KAMPFORMAT;
  if (kvartfinale.includes(rundeNavn)) return konfig?.kampformatKvartfinale ?? STANDARD_KAMPFORMAT;
  return STANDARD_KAMPFORMAT;
}

// ════════════════════════════════════════════════════════
// PULJEOPPSETT — slange-seeding
// ════════════════════════════════════════════════════════
export function genererPuljer(lag, antallPuljer) {
  if (!lag?.length) throw new Error('Ingen lag å fordele.');
  if (antallPuljer < 2 || antallPuljer > 4) throw new Error('Antall puljer må være 2–4.');
  if (lag.length < antallPuljer * 2) throw new Error(`Trenger minst ${antallPuljer * 2} lag for ${antallPuljer} puljer.`);

  const puljer = Array.from({ length: antallPuljer }, (_, i) => ({
    id:     `pulje_${i + 1}`,
    navn:   `Pulje ${String.fromCharCode(65 + i)}`,
    lagIds: [],
  }));

  let retning = 1;
  let pIdx    = 0;
  for (const l of lag) {
    puljer[pIdx].lagIds.push(l.id);
    pIdx += retning;
    if (pIdx >= antallPuljer) { pIdx = antallPuljer - 1; retning = -1; }
    else if (pIdx < 0)        { pIdx = 0;                retning =  1; }
  }

  return puljer;
}

// ════════════════════════════════════════════════════════
// ROUND ROBIN — kampgenerering (Berger-tabell)
// ════════════════════════════════════════════════════════
export function genererRoundRobin(lagIds) {
  const n      = lagIds.length;
  const kamper = [];
  let kampNr   = 1;

  if (n < 2) return kamper;

  const liste = [...lagIds];
  if (n % 2 !== 0) liste.push('BYE');
  const m = liste.length;

  for (let runde = 0; runde < m - 1; runde++) {
    for (let i = 0; i < m / 2; i++) {
      const h = liste[i];
      const b = liste[m - 1 - i];
      if (h !== 'BYE' && b !== 'BYE') {
        kamper.push({
          id:        `rr_${kampNr}`,
          kampNr:    kampNr++,
          runde:     runde + 1,
          lag1Id:    h,
          lag2Id:    b,
          lag1Poeng: null,
          lag2Poeng: null,
          ferdig:    false,
          walkover:  false,
        });
      }
    }
    const siste = liste.pop();
    liste.splice(1, 0, siste);
  }

  return kamper;
}

// ════════════════════════════════════════════════════════
// 4 PULJER / 6 BANER — Global rotasjon
//
// Rotasjonsskjema (hvilke puljer spiller i hvilken global runde):
//   Runde 1: A(intern 1), B(intern 1), C(intern 1) — D har pause
//   Runde 2: D(intern 1), A(intern 2), B(intern 2) — C har pause
//   Runde 3: C(intern 2), D(intern 2), A(intern 3) — B har pause
//   Runde 4: B(intern 3), C(intern 3), D(intern 3) — A har pause
//
// Innen en runde fordeles 2 kamper fra hver aktive pulje på 2 baner.
// Banefordeling per global runde (fast):
//   Runde 1: Bane 1-2 = Pulje A, Bane 3-4 = Pulje B, Bane 5-6 = Pulje C
//   Runde 2: Bane 1-2 = Pulje D, Bane 3-4 = Pulje A, Bane 5-6 = Pulje B
//   Runde 3: Bane 1-2 = Pulje C, Bane 3-4 = Pulje D, Bane 5-6 = Pulje A
//   Runde 4: Bane 1-2 = Pulje B, Bane 3-4 = Pulje C, Bane 5-6 = Pulje D
// ════════════════════════════════════════════════════════

/**
 * Berger-tabell for 4 lag — returnerer 3 runder med [h, b] par.
 * Runde 1: [0v3, 1v2], Runde 2: [0v2, 3v1], Runde 3: [0v1, 2v3]
 */
function _berger4(lagIds) {
  const [a, b, c, d] = lagIds;
  return [
    [[a, d], [b, c]],  // intern runde 1
    [[a, c], [d, b]],  // intern runde 2
    [[a, b], [c, d]],  // intern runde 3
  ];
}

/**
 * Lager kamper for 4 puljer på 6 baner med global runde og fast bane.
 * Returnerer oppdaterte puljer med kamper satt på riktig global runde og baneNr.
 *
 * @param {Array} puljer — fra genererPuljer(), må ha nøyaktig 4 puljer à 4 lag
 * @returns {Array} puljer med kamper
 */
export function genererKamperMed4Puljer6Baner(puljer) {
  if (puljer.length !== 4) throw new Error('Denne funksjonen krever nøyaktig 4 puljer.');

  const [pA, pB, pC, pD] = puljer;

  // Berger-kamper per pulje (3 interne runder, 2 kamper per runde)
  const kampA = _berger4(pA.lagIds);
  const kampB = _berger4(pB.lagIds);
  const kampC = _berger4(pC.lagIds);
  const kampD = _berger4(pD.lagIds);

  // Rotasjonsplan: [globalRunde, [pulje-kamper, startBane], ...]
  // Hver pulje bidrar med 2 kamper (intern runde) til en global runde
  // [globalRunde, puljekamper (intern runde idx 0-2), startBane (1,3,5)]
  const plan = [
    // Global runde 1: A(intern 0), B(intern 0), C(intern 0) — bane 1,3,5
    { gr: 1, slots: [{ kamper: kampA[0], startBane: 1 }, { kamper: kampB[0], startBane: 3 }, { kamper: kampC[0], startBane: 5 }] },
    // Global runde 2: D(intern 0), A(intern 1), B(intern 1) — bane 1,3,5
    { gr: 2, slots: [{ kamper: kampD[0], startBane: 1 }, { kamper: kampA[1], startBane: 3 }, { kamper: kampB[1], startBane: 5 }] },
    // Global runde 3: C(intern 1), D(intern 1), A(intern 2) — bane 1,3,5
    { gr: 3, slots: [{ kamper: kampC[1], startBane: 1 }, { kamper: kampD[1], startBane: 3 }, { kamper: kampA[2], startBane: 5 }] },
    // Global runde 4: B(intern 2), C(intern 2), D(intern 2) — bane 1,3,5
    { gr: 4, slots: [{ kamper: kampB[2], startBane: 1 }, { kamper: kampC[2], startBane: 3 }, { kamper: kampD[2], startBane: 5 }] },
  ];

  // Bygg kamper for hver pulje med global runde og baneNr
  // Parallelt: kampA[0] → global runde 1, kampA[1] → global runde 2, osv.
  const puljekamper = { [pA.id]: [], [pB.id]: [], [pC.id]: [], [pD.id]: [] };

  // Map pulje-id til berger-array
  const bergerMap = { [pA.id]: kampA, [pB.id]: kampB, [pC.id]: kampC, [pD.id]: kampD };

  let kampNr = 1;
  for (const { gr, slots } of plan) {
    for (const { kamper: internKamper, startBane } of slots) {
      internKamper.forEach(([h, b], i) => {
        // Finn hvilken pulje disse lagene tilhører
        const puljeId = puljer.find(p => p.lagIds.includes(h))?.id;
        if (!puljeId) return;
        puljekamper[puljeId].push({
          id:        `rr_${kampNr}`,
          kampNr:    kampNr++,
          runde:     gr,
          baneNr:    startBane + i,
          lag1Id:    h,
          lag2Id:    b,
          lag1Poeng: null,
          lag2Poeng: null,
          ferdig:    false,
          walkover:  false,
        });
      });
    }
  }

  return puljer.map(p => ({ ...p, kamper: puljekamper[p.id] ?? [] }));
}

// ════════════════════════════════════════════════════════
// 3 PULJER / 6 BANER — Global rotasjon
//
// 3 puljer à 5 lag, 5 runder, 2 kamper per pulje per runde = 6 baner
// Banefordeling (fast):
//   Pulje A: Bane 1–2 alltid
//   Pulje B: Bane 3–4 alltid
//   Pulje C: Bane 5–6 alltid
// Ingen pause — alle puljer spiller alle runder.
// ════════════════════════════════════════════════════════

function _berger5(lagIds) {
  const liste = [...lagIds, 'BYE'];
  const m = liste.length;
  const runder = [];
  for (let r = 0; r < m - 1; r++) {
    const kamper = [];
    for (let i = 0; i < m / 2; i++) {
      const h = liste[i];
      const b = liste[m - 1 - i];
      if (h !== 'BYE' && b !== 'BYE') kamper.push([h, b]);
    }
    runder.push(kamper);
    const siste = liste.pop();
    liste.splice(1, 0, siste);
  }
  return runder;
}

export function genererKamperMed3Puljer6Baner(puljer) {
  if (puljer.length !== 3) throw new Error('Denne funksjonen krever nøyaktig 3 puljer.');

  const [pA, pB, pC] = puljer;
  const kampA = _berger5(pA.lagIds);
  const kampB = _berger5(pB.lagIds);
  const kampC = _berger5(pC.lagIds);

  const baneStart  = { [pA.id]: 1, [pB.id]: 3, [pC.id]: 5 };
  const bergerMap  = { [pA.id]: kampA, [pB.id]: kampB, [pC.id]: kampC };
  const puljekamper = { [pA.id]: [], [pB.id]: [], [pC.id]: [] };
  let kampNr = 1;

  for (let gr = 1; gr <= 5; gr++) {
    for (const p of [pA, pB, pC]) {
      const internKamper = bergerMap[p.id][gr - 1];
      const startBane    = baneStart[p.id];
      internKamper.forEach(([h, b], i) => {
        puljekamper[p.id].push({
          id:        `rr_${kampNr}`,
          kampNr:    kampNr++,
          runde:     gr,
          baneNr:    startBane + i,
          lag1Id:    h,
          lag2Id:    b,
          lag1Poeng: null,
          lag2Poeng: null,
          ferdig:    false,
          walkover:  false,
        });
      });
    }
  }

  return puljer.map(p => ({ ...p, kamper: puljekamper[p.id] ?? [] }));
}


// ════════════════════════════════════════════════════════
// 2 PULJER / 6 BANER — Global rotasjon
//
// 2 puljer à 6 lag, 5 runder, 3 kamper per pulje per runde = 6 baner
// Banefordeling (fast):
//   Pulje A: Bane 1–3 alltid
//   Pulje B: Bane 4–6 alltid
// Ingen pause — begge puljer spiller alle runder.
// ════════════════════════════════════════════════════════

function _berger6(lagIds) {
  const liste = [...lagIds];
  const m = liste.length; // 6
  const runder = [];
  for (let r = 0; r < m - 1; r++) {
    const kamper = [];
    for (let i = 0; i < m / 2; i++) {
      kamper.push([liste[i], liste[m - 1 - i]]);
    }
    runder.push(kamper);
    const siste = liste.pop();
    liste.splice(1, 0, siste);
  }
  return runder; // 5 runder, 3 kamper per runde
}

export function genererKamperMed2Puljer6Baner(puljer) {
  if (puljer.length !== 2) throw new Error('Denne funksjonen krever nøyaktig 2 puljer.');

  const [pA, pB] = puljer;
  const kampA = _berger6(pA.lagIds);
  const kampB = _berger6(pB.lagIds);

  const baneStart  = { [pA.id]: 1, [pB.id]: 4 };
  const bergerMap  = { [pA.id]: kampA, [pB.id]: kampB };
  const puljekamper = { [pA.id]: [], [pB.id]: [] };
  let kampNr = 1;

  for (let gr = 1; gr <= 5; gr++) {
    for (const p of [pA, pB]) {
      const internKamper = bergerMap[p.id][gr - 1];
      const startBane    = baneStart[p.id];
      internKamper.forEach(([h, b], i) => {
        puljekamper[p.id].push({
          id:        `rr_${kampNr}`,
          kampNr:    kampNr++,
          runde:     gr,
          baneNr:    startBane + i,
          lag1Id:    h,
          lag2Id:    b,
          lag1Poeng: null,
          lag2Poeng: null,
          ferdig:    false,
          walkover:  false,
        });
      });
    }
  }

  return puljer.map(p => ({ ...p, kamper: puljekamper[p.id] ?? [] }));
}

// Rekkefølge: seire → innbyrdes → poengdifferanse → scorede poeng
// ════════════════════════════════════════════════════════
export function beregnPuljetabell(pulje, alleLag) {
  const lagMap = Object.fromEntries(alleLag.map(l => [l.id, l]));
  const stats  = {};

  for (const id of pulje.lagIds) {
    stats[id] = { lagId: id, seire: 0, tap: 0, pf: 0, pm: 0, pd: 0, kamper: 0 };
  }

  for (const k of (pulje.kamper ?? [])) {
    if (!k.ferdig || k.lag1Poeng == null || k.lag2Poeng == null) continue;
    const s1 = stats[k.lag1Id];
    const s2 = stats[k.lag2Id];
    if (!s1 || !s2) continue;

    s1.pf += k.lag1Poeng; s1.pm += k.lag2Poeng;
    s2.pf += k.lag2Poeng; s2.pm += k.lag1Poeng;
    s1.kamper++; s2.kamper++;

    if (k.lag1Poeng > k.lag2Poeng) { s1.seire++; s2.tap++; }
    else                            { s2.seire++; s1.tap++; }
  }

  for (const s of Object.values(stats)) {
    s.pd = s.pf - s.pm;
  }

  return _sorterPuljeTabell(Object.values(stats), pulje.kamper ?? []);
}

function _sorterPuljeTabell(lagListe, kamper) {
  const grov = [...lagListe].sort((a, b) => b.seire - a.seire);
  const resultat = [];
  let i = 0;
  while (i < grov.length) {
    let j = i + 1;
    while (j < grov.length && grov[j].seire === grov[i].seire) j++;
    const gruppe = grov.slice(i, j);
    if (gruppe.length === 1) {
      gruppe[0].tiebreakType = null;
      resultat.push(gruppe[0]);
    } else {
      // Sirkeloppgjør: bruk PD kun i kampene mellom de involverte lagene
      const ids = new Set(gruppe.map(l => l.lagId));
      const sortert = [...gruppe].sort((a, b) => {
        const sirkelA = _sirkelPd(a.lagId, ids, kamper);
        const sirkelB = _sirkelPd(b.lagId, ids, kamper);
        if (sirkelB !== sirkelA) return sirkelB - sirkelA;
        if (b.pd !== a.pd) return b.pd - a.pd;
        return b.pf - a.pf;
      });
      sortert.forEach(l => { l.tiebreakType = 'poengdiff'; });
      resultat.push(...sortert);
    }
    i = j;
  }
  return resultat;
}

/**
 * Beregner poengdifferansen for et lag kun i kampene mot de andre
 * lagene i samme sirkel-gruppe (like seire).
 */
function _sirkelPd(lagId, gruppeIds, kamper) {
  let pd = 0;
  for (const k of kamper) {
    if (!k.ferdig) continue;
    if (k.lag1Id === lagId && gruppeIds.has(k.lag2Id)) pd += k.lag1Poeng - k.lag2Poeng;
    if (k.lag2Id === lagId && gruppeIds.has(k.lag1Id)) pd += k.lag2Poeng - k.lag1Poeng;
  }
  return pd;
}

function _sammenlignPaaTvers(a, b) {
  if (b.seire !== a.seire) return b.seire - a.seire;
  if (b.pd    !== a.pd)    return b.pd    - a.pd;
  return b.pf - a.pf;
}

// ════════════════════════════════════════════════════════
// KVALIFISERING TIL SLUTTSPILL
// Returnerer { A: lagId[], B: lagId[], C: lagId[], ... }
// ════════════════════════════════════════════════════════
export function kvalifiserTilSluttspill(turneringMedTabeller) {
  const { puljer, konfig } = turneringMedTabeller;
  const antallPuljer = puljer.length;

  const tabeller = puljer.map(p =>
    beregnPuljetabell(p, turneringMedTabeller.lag)
  );

  let aKandidater = [];

  if (antallPuljer === 2) {
    tabeller.forEach((t, pi) => t.slice(0, 4).forEach((l, ri) =>
      aKandidater.push({ ...l, puljeIdx: pi, puljeRang: ri + 1 })
    ));
  } else if (antallPuljer === 3) {
    tabeller.forEach((t, pi) => t.slice(0, 2).forEach((l, ri) =>
      aKandidater.push({ ...l, puljeIdx: pi, puljeRang: ri + 1 })
    ));
    const tredjepl = tabeller.map((t, pi) => t[2] ? { ...t[2], puljeIdx: pi, puljeRang: 3 } : null)
      .filter(Boolean).sort(_sammenlignPaaTvers);
    aKandidater.push(...tredjepl.slice(0, 2));
  } else if (antallPuljer === 4) {
    tabeller.forEach((t, pi) => t.slice(0, 2).forEach((l, ri) =>
      aKandidater.push({ ...l, puljeIdx: pi, puljeRang: ri + 1 })
    ));
  }

  aKandidater = aKandidater.slice(0, 8);
  const aIds  = aKandidater.map(l => l.lagId);

  const gjenvarende = tabeller.flat()
    .filter(l => !aIds.includes(l.lagId))
    .sort(_sammenlignPaaTvers);

  const bIds = gjenvarende.slice(0,  8).map(l => l.lagId);
  const cIds = gjenvarende.slice(8, 24).map(l => l.lagId);

  return { A: aIds, B: bIds, C: cIds, aMeta: aKandidater, tabeller, antallPuljer };
}

// ════════════════════════════════════════════════════════
// BRACKET-MOTOR
// ════════════════════════════════════════════════════════

/** Bestemmer startnivå basert på antall lag. */
export function startnivaa(antallLag) {
  if (antallLag <= 2)  return 'finale';
  if (antallLag <= 4)  return 'semifinale';
  if (antallLag <= 8)  return 'kvartfinale';
  return 'aattedelsfinale';
}

/** Genererer A-bracket (plass 1–8). */
function _lagKamp(id, lag1Id, lag2Id, winnerTo, loserTo, runde) {
  return {
    id, runde,
    lag1Id:    lag1Id ?? null,
    lag2Id:    lag2Id ?? null,
    lag1Poeng: null,
    lag2Poeng: null,
    ferdig:    false,
    walkover:  false,
    winnerId:  null,
    taperId:   null,
    winner_to: winnerTo ?? null,
    loser_to:  loserTo  ?? null,
    format:    null,
  };
}

export function genererABracket(seededeIds, konfig, parOverstyr = null) {
  const n      = seededeIds.length;
  const kamper = [];

  if (n <= 0) return kamper;

  const plasseringPaa = konfig?.plasseringskamperA !== false;

  if (n === 2) {
    kamper.push(_lagKamp('A_FIN', seededeIds[0], seededeIds[1], null, null, '1. plass'));
    return kamper;
  }

  if (n <= 4) {
    kamper.push(_lagKamp('A_SF1', seededeIds[0], seededeIds[3] ?? null, 'A_FIN', plasseringPaa ? 'A_BRO' : null, 'Semifinale'));
    kamper.push(_lagKamp('A_SF2', seededeIds[1], seededeIds[2] ?? null, 'A_FIN', plasseringPaa ? 'A_BRO' : null, 'Semifinale'));
    kamper.push(_lagKamp('A_FIN',  null, null, null, null, '1. plass'));
    if (plasseringPaa) kamper.push(_lagKamp('A_BRO', null, null, null, null, '3. plass'));
    return kamper;
  }

  // 5 lag: seed 1 får bye til SF1, seed 2 vs 5 og seed 3 vs 4 i QF
  if (n === 5) {
    kamper.push(_lagKamp('A_QF1', seededeIds[1], seededeIds[4], 'A_SF2', plasseringPaa ? 'A_P5_SF1' : null, 'Kvartfinale'));
    kamper.push(_lagKamp('A_QF2', seededeIds[2], seededeIds[3], 'A_SF2', plasseringPaa ? 'A_P5_SF1' : null, 'Kvartfinale'));
    // Seed 1 går direkte til SF1
    kamper.push(_lagKamp('A_SF1', seededeIds[0], null, 'A_FIN', plasseringPaa ? 'A_BRO' : null, 'Semifinale'));
    kamper.push(_lagKamp('A_SF2', null, null, 'A_FIN', plasseringPaa ? 'A_BRO' : null, 'Semifinale'));
    kamper.push(_lagKamp('A_FIN', null, null, null, null, '1. plass'));
    if (plasseringPaa) {
      kamper.push(_lagKamp('A_BRO', null, null, null, null, '3. plass'));
      kamper.push(_lagKamp('A_P5_SF1', null, null, 'A_P5_FIN', null, 'Plass 5–8'));
      kamper.push(_lagKamp('A_P5_FIN', null, null, null, null, '5. plass'));
    }
    return kamper;
  }

  // 6 lag: seed 1 og seed 2 får bye til semifinale,
  // seed 3 vs 6 og seed 4 vs 5 spiller kvartfinale
  if (n === 6) {
    // QF: seed 3 vs 6, seed 4 vs 5
    // Tapere møtes direkte i kamp om 5. plass (kun 2 QF-tapere)
    kamper.push(_lagKamp('A_QF1', seededeIds[2], seededeIds[5], 'A_SF1', plasseringPaa ? 'A_P5_FIN' : null, 'Kvartfinale'));
    kamper.push(_lagKamp('A_QF2', seededeIds[3], seededeIds[4], 'A_SF2', plasseringPaa ? 'A_P5_FIN' : null, 'Kvartfinale'));
    // Seed 1 og seed 2 får bye direkte til semifinale
    kamper.push(_lagKamp('A_SF1', seededeIds[0], null, 'A_FIN', plasseringPaa ? 'A_BRO' : null, 'Semifinale'));
    kamper.push(_lagKamp('A_SF2', seededeIds[1], null, 'A_FIN', plasseringPaa ? 'A_BRO' : null, 'Semifinale'));
    kamper.push(_lagKamp('A_FIN', null, null, null, null, '1. plass'));
    if (plasseringPaa) {
      kamper.push(_lagKamp('A_BRO',    null, null, null, null, '3. plass'));
      // Kun 2 QF-tapere → direkte kamp om 5. plass (ingen Plass 5-8 semifinaler)
      kamper.push(_lagKamp('A_P5_FIN', null, null, null, null, '5. plass'));
    }
    return kamper;
  }

  // 7 lag: seed 1 får bye til SF2, seed 2-7 spiller 3 QF-kamper.
  // 3 QF-tapere: seed1-taper fra QF3 får bye til 5.plass-finalen,
  // QF1- og QF2-taperne spiller semifinale om 5. plass.
  if (n === 7) {
    kamper.push(_lagKamp('A_QF1', seededeIds[1], seededeIds[6], 'A_SF1', plasseringPaa ? 'A_P5_SF1' : null, 'Kvartfinale'));
    kamper.push(_lagKamp('A_QF2', seededeIds[2], seededeIds[5], 'A_SF1', plasseringPaa ? 'A_P5_SF1' : null, 'Kvartfinale'));
    kamper.push(_lagKamp('A_QF3', seededeIds[3], seededeIds[4], 'A_SF2', plasseringPaa ? 'A_P5_FIN' : null, 'Kvartfinale'));
    // Seed 1 går direkte til SF2
    kamper.push(_lagKamp('A_SF1', null, null, 'A_FIN', plasseringPaa ? 'A_BRO' : null, 'Semifinale'));
    kamper.push(_lagKamp('A_SF2', seededeIds[0], null, 'A_FIN', plasseringPaa ? 'A_BRO' : null, 'Semifinale'));
    kamper.push(_lagKamp('A_FIN', null, null, null, null, '1. plass'));
    if (plasseringPaa) {
      kamper.push(_lagKamp('A_BRO',    null, null, null, null, '3. plass'));
      // QF1- og QF2-tapere spiller om 5. plass, QF3-taper har bye
      kamper.push(_lagKamp('A_P5_SF1', null, null, 'A_P5_FIN', null, 'Plass 5–6'));
      kamper.push(_lagKamp('A_P5_FIN', null, null, null, null, '5. plass'));
    }
    return kamper;
  }

  // 8 lag: standard kvartfinale, ingen bye
  // Seed 1 vs 8, seed 2 vs 7, seed 3 vs 6, seed 4 vs 5
  // SF1: vinnere av QF1 og QF2, SF2: vinnere av QF3 og QF4
  kamper.push(_lagKamp('A_QF1', seededeIds[0], seededeIds[7], 'A_SF1', plasseringPaa ? 'A_P5_SF1' : null, 'Kvartfinale'));
  kamper.push(_lagKamp('A_QF2', seededeIds[3], seededeIds[4], 'A_SF1', plasseringPaa ? 'A_P5_SF1' : null, 'Kvartfinale'));
  kamper.push(_lagKamp('A_QF3', seededeIds[1], seededeIds[6], 'A_SF2', plasseringPaa ? 'A_P5_SF2' : null, 'Kvartfinale'));
  kamper.push(_lagKamp('A_QF4', seededeIds[2], seededeIds[5], 'A_SF2', plasseringPaa ? 'A_P5_SF2' : null, 'Kvartfinale'));

  kamper.push(_lagKamp('A_SF1', null, null, 'A_FIN', 'A_BRO', 'Semifinale'));
  kamper.push(_lagKamp('A_SF2', null, null, 'A_FIN', 'A_BRO', 'Semifinale'));
  kamper.push(_lagKamp('A_FIN', null, null, null, null, '1. plass'));
  kamper.push(_lagKamp('A_BRO', null, null, null, null, '3. plass'));

  if (plasseringPaa) {
    kamper.push(_lagKamp('A_P5_SF1', null, null, 'A_P5_FIN', 'A_P7_FIN', 'Plass 5–8'));
    kamper.push(_lagKamp('A_P5_SF2', null, null, 'A_P5_FIN', 'A_P7_FIN', 'Plass 5–8'));
    kamper.push(_lagKamp('A_P5_FIN', null, null, null, null, '5. plass'));
    kamper.push(_lagKamp('A_P7_FIN', null, null, null, null, '7. plass'));
  }

  return kamper;
}

/**
 * Genererer B/C-bracket.
 * Bronsekamp (11./19. plass) inkluderes kun om konfig.plasseringskamperBC === true.
 *
 * Støttede størrelser:
 *   2 lag   → finale
 *   3–4 lag → semifinale + finale [+ bronsekamp]
 *   5 lag   → 1 QF + semifinale + finale [+ bronsekamp]
 *   6 lag   → 2 QF + semifinale + finale [+ bronsekamp]
 *   7 lag   → bye til seed 1, 3 QF + semifinale + finale [+ bronsekamp]
 *   8 lag   → 4 QF + semifinale + finale [+ bronsekamp]
 */
export function genererBCBracket(lagIds, nivaa, startPlass, konfig = null) {
  const n         = lagIds.length;
  const prefix    = nivaa;
  const kamper    = [];
  const bronse    = startPlass + 2;
  const medBronse = konfig?.plasseringskamperBC === true;

  if (n < 2) return kamper;

  // 2 lag — bare finale
  if (n === 2) {
    kamper.push(_lagKamp(`${prefix}_FIN`, lagIds[0], lagIds[1], null, null, `${startPlass}. plass`));
    return kamper;
  }

  // 3 lag — seed 1 bye til finale, seed 2 vs 3 i semifinale
  if (n === 3) {
    const s = lagIds;
    kamper.push(_lagKamp(`${prefix}_SF1`, s[1], s[2], `${prefix}_FIN`, null, 'Semifinale'));
    // Seed 1 har bye og går direkte til finalen
    kamper.push(_lagKamp(`${prefix}_FIN`, s[0], null, null, null, `${startPlass}. plass`));
    return kamper;
  }

  // 4 lag — semifinale + finale + [bronse]
  if (n === 4) {
    const s = lagIds;
    kamper.push(_lagKamp(`${prefix}_SF1`, s[0], s[3], `${prefix}_FIN`, medBronse ? `${prefix}_BRO` : null, 'Semifinale'));
    kamper.push(_lagKamp(`${prefix}_SF2`, s[1], s[2], `${prefix}_FIN`, medBronse ? `${prefix}_BRO` : null, 'Semifinale'));
    kamper.push(_lagKamp(`${prefix}_FIN`, null, null, null, null, `${startPlass}. plass`));
    if (medBronse) kamper.push(_lagKamp(`${prefix}_BRO`, null, null, null, null, `${bronse}. plass`));
    return kamper;
  }

  // 5 lag — seed1 bye til SF1, seed4v5 i QF
  if (n === 5) {
    const s = lagIds;
    kamper.push(_lagKamp(`${prefix}_QF1`, s[3], s[4], `${prefix}_SF1`, medBronse ? `${prefix}_P13_FIN` : null, 'Kvartfinale'));
    kamper.push(_lagKamp(`${prefix}_SF1`, s[0], null,  `${prefix}_FIN`, medBronse ? `${prefix}_BRO` : null, 'Semifinale'));
    kamper.push(_lagKamp(`${prefix}_SF2`, s[1], s[2],  `${prefix}_FIN`, medBronse ? `${prefix}_BRO` : null, 'Semifinale'));
    kamper.push(_lagKamp(`${prefix}_FIN`, null, null, null, null, `${startPlass}. plass`));
    if (medBronse) {
      kamper.push(_lagKamp(`${prefix}_BRO`,     null, null, null, null, `${bronse}. plass`));
      kamper.push(_lagKamp(`${prefix}_P13_FIN`, null, null, null, null, `${startPlass + 4}. plass`));
    }
    return kamper;
  }

  // 6 lag — seed1+2 bye til SF, seed3v6 og seed4v5 i QF
  if (n === 6) {
    const s = lagIds;
    kamper.push(_lagKamp(`${prefix}_QF1`, s[2], s[5], `${prefix}_SF1`, medBronse ? `${prefix}_P13_FIN` : null, 'Kvartfinale'));
    kamper.push(_lagKamp(`${prefix}_QF2`, s[3], s[4], `${prefix}_SF2`, medBronse ? `${prefix}_P13_FIN` : null, 'Kvartfinale'));
    kamper.push(_lagKamp(`${prefix}_SF1`, s[0], null,  `${prefix}_FIN`, medBronse ? `${prefix}_BRO` : null, 'Semifinale'));
    kamper.push(_lagKamp(`${prefix}_SF2`, s[1], null,  `${prefix}_FIN`, medBronse ? `${prefix}_BRO` : null, 'Semifinale'));
    kamper.push(_lagKamp(`${prefix}_FIN`, null, null, null, null, `${startPlass}. plass`));
    if (medBronse) {
      kamper.push(_lagKamp(`${prefix}_BRO`,     null, null, null, null, `${bronse}. plass`));
      kamper.push(_lagKamp(`${prefix}_P13_FIN`, null, null, null, null, `${startPlass + 4}. plass`));
    }
    return kamper;
  }

  // 7 lag — seed1 bye til SF1, seed2v7/seed3v6/seed4v5 i QF
  // QF-tapere: B_QF1-taper er sterkest (tapte mot seed2), får 1-kamp fordel
  // B_P13_SF:  QF2-taper vs QF3-taper → vinner til B_P13_FIN
  // B_P13_FIN: QF1-taper vs B_P13_SF-vinner → 13. plass, taper 14. plass
  // B_P13_SF-taper → 15. plass direkte
  if (n === 7) {
    const s = lagIds;
    kamper.push(_lagKamp(`${prefix}_QF1`, s[1], s[6], `${prefix}_SF1`, medBronse ? `${prefix}_P13_FIN` : null, 'Kvartfinale'));
    kamper.push(_lagKamp(`${prefix}_QF2`, s[2], s[5], `${prefix}_SF2`, medBronse ? `${prefix}_P13_SF`  : null, 'Kvartfinale'));
    kamper.push(_lagKamp(`${prefix}_QF3`, s[3], s[4], `${prefix}_SF2`, medBronse ? `${prefix}_P13_SF`  : null, 'Kvartfinale'));
    kamper.push(_lagKamp(`${prefix}_SF1`, s[0], null,  `${prefix}_FIN`, medBronse ? `${prefix}_BRO` : null, 'Semifinale'));
    kamper.push(_lagKamp(`${prefix}_SF2`, null, null,  `${prefix}_FIN`, medBronse ? `${prefix}_BRO` : null, 'Semifinale'));
    kamper.push(_lagKamp(`${prefix}_FIN`, null, null, null, null, `${startPlass}. plass`));
    if (medBronse) {
      kamper.push(_lagKamp(`${prefix}_BRO`,     null, null, null, null, `${bronse}. plass`));
      kamper.push(_lagKamp(`${prefix}_P13_SF`,  null, null, `${prefix}_P13_FIN`, null, `${startPlass + 4}. plass`));
      kamper.push(_lagKamp(`${prefix}_P13_FIN`, null, null, null, null, `${startPlass + 4}. plass`));
    }
    return kamper;
  }

  // 8 lag — standard kvartfinale
  // QF-tapere: 4 lag → B_P13_SF1 og B_P13_SF2 → B_P13_FIN (13./14.) og B_P15_FIN (15./16.)
  const s = lagIds;
  kamper.push(_lagKamp(`${prefix}_QF1`, s[0], s[7], `${prefix}_SF1`, medBronse ? `${prefix}_P13_SF1` : null, 'Kvartfinale'));
  kamper.push(_lagKamp(`${prefix}_QF2`, s[3], s[4], `${prefix}_SF1`, medBronse ? `${prefix}_P13_SF1` : null, 'Kvartfinale'));
  kamper.push(_lagKamp(`${prefix}_QF3`, s[1], s[6], `${prefix}_SF2`, medBronse ? `${prefix}_P13_SF2` : null, 'Kvartfinale'));
  kamper.push(_lagKamp(`${prefix}_QF4`, s[2], s[5], `${prefix}_SF2`, medBronse ? `${prefix}_P13_SF2` : null, 'Kvartfinale'));
  kamper.push(_lagKamp(`${prefix}_SF1`, null, null, `${prefix}_FIN`, medBronse ? `${prefix}_BRO` : null, 'Semifinale'));
  kamper.push(_lagKamp(`${prefix}_SF2`, null, null, `${prefix}_FIN`, medBronse ? `${prefix}_BRO` : null, 'Semifinale'));
  kamper.push(_lagKamp(`${prefix}_FIN`, null, null, null, null, `${startPlass}. plass`));
  if (medBronse) {
    kamper.push(_lagKamp(`${prefix}_BRO`,      null, null, null, null, `${bronse}. plass`));
    kamper.push(_lagKamp(`${prefix}_P13_SF1`,  null, null, `${prefix}_P13_FIN`, `${prefix}_P15_FIN`, `${startPlass + 4}. plass`));
    kamper.push(_lagKamp(`${prefix}_P13_SF2`,  null, null, `${prefix}_P13_FIN`, `${prefix}_P15_FIN`, `${startPlass + 4}. plass`));
    kamper.push(_lagKamp(`${prefix}_P13_FIN`,  null, null, null, null, `${startPlass + 4}. plass`));
    kamper.push(_lagKamp(`${prefix}_P15_FIN`,  null, null, null, null, `${startPlass + 6}. plass`));
  }
  return kamper;
}


// ════════════════════════════════════════════════════════
// SEEDING
// ════════════════════════════════════════════════════════
export function seedALag(kvalifiserteIds, puljer, modus, kval = null) {
  if (modus === SEEDING_MODUS.TREKNING) return _trekkSeeding(kvalifiserteIds, puljer);
  if (modus === SEEDING_MODUS.KRYSS)    return _kryssSeeding(kval, puljer);
  return _standardSeeding(kvalifiserteIds, puljer);
}

function _standardSeeding(ids, puljer) {
  const seeded = [...ids];
  for (let i = 0; i < 4; i++) {
    const motstanderIdx = 7 - i;
    if (_samePulje(seeded[i], seeded[motstanderIdx], puljer)) {
      for (let j = motstanderIdx - 1; j > i; j--) {
        if (!_samePulje(seeded[i], seeded[j], puljer)) {
          [seeded[motstanderIdx], seeded[j]] = [seeded[j], seeded[motstanderIdx]];
          break;
        }
      }
    }
  }
  return seeded;
}

function _kryssSeeding(kval, puljer) {
  if (!kval) return [];
  const { aMeta, antallPuljer } = kval;
  if (antallPuljer === 2) return _kryssSeeding2Puljer(aMeta, puljer);
  if (antallPuljer === 3) return _kryssSeeding3Puljer(aMeta, puljer);
  if (antallPuljer === 4) return _kryssSeeding4Puljer(aMeta, puljer);
  return aMeta.map(l => l.lagId);
}

function _kryssSeeding2Puljer(meta, puljer) {
  const grp = _grupperPerPulje(meta);
  const [p0, p1] = [grp[0] ?? [], grp[1] ?? []];

  // Ren kryss-seeding: A1=seed1, B1=seed2, A2=seed3, B2=seed4 osv.
  // Ingen sammenligning på tvers — puljerang bestemmer seeding.
  // Garanterer at A1 og B1 ikke møtes før finalen.
  const maxRang = Math.max(p0.length, p1.length);
  const par = [];
  for (let rang = 1; rang <= maxRang; rang++) {
    const fraA = _velg(p0, rang);
    const fraB = _velg(p1, rang);
    if (fraA) par.push(fraA);
    if (fraB) par.push(fraB);
  }
  return par;
}

/**
 * Beregner justerte statistikker for alle lag på tvers av puljer.
 * Streker resultatet mot det svakeste laget i puljer som har ett
 * ekstra lag, slik at alle lag sammenlignes på like mange kamper.
 *
 * Forutsetning: maks 1 ekstra lag per pulje.
 *
 * @param {Array[]} grupper — array av pulje-arrays fra _grupperPerPulje
 * @param {Array}   puljer  — Firestore-puljeobjekter med kamper
 * @returns {Object} map { lagId → justert statistikk }
 */
function _justerForUjevnePuljer(grupper, puljer) {
  const justertStats = {};
  const minStorrelse = Math.min(...grupper.map(g => g.length));

  for (const gruppe of grupper) {
    if (gruppe.length === minStorrelse) {
      // Pulje er på referansestørrelse — ingen justering
      for (const lag of gruppe) justertStats[lag.lagId] = lag;
      continue;
    }

    // Pulje har ett ekstra lag — stryk kampen mot det svakeste (siste i tabellen)
    const svakasteId = gruppe[gruppe.length - 1]?.lagId;
    const puljeObj   = puljer.find(p => p.lagIds?.includes(svakasteId));

    for (const lagMeta of gruppe) {
      const id = lagMeta.lagId;
      if (id === svakasteId) continue; // svakeste strøkes fra sammenligning

      const kamp = (puljeObj?.kamper ?? []).find(k =>
        k.ferdig &&
        ((k.lag1Id === id && k.lag2Id === svakasteId) ||
         (k.lag2Id === id && k.lag1Id === svakasteId))
      );

      if (!kamp) {
        justertStats[id] = lagMeta;
        continue;
      }

      const erLag1 = kamp.lag1Id === id;
      const mineP  = erLag1 ? kamp.lag1Poeng : kamp.lag2Poeng;
      const deresP = erLag1 ? kamp.lag2Poeng : kamp.lag1Poeng;

      justertStats[id] = {
        ...lagMeta,
        seire: lagMeta.seire - (mineP > deresP ? 1 : 0),
        pf:    lagMeta.pf    - mineP,
        pm:    (lagMeta.pm ?? 0) - deresP,
        pd:    lagMeta.pd    - (mineP - deresP),
      };
    }
  }

  return justertStats;
}

function _kryssSeeding3Puljer(meta, puljer) {
  const grp = _grupperPerPulje(meta);
  const justertStats = _justerForUjevnePuljer(grp, puljer);

  // Bruk justerte statistikker i stedet for rå meta-data
  const justerMeta = m => justertStats[m.lagId] ?? m;

  const vinnere    = meta.filter(l => l.puljeRang === 1).map(justerMeta).sort(_sammenlignPaaTvers);
  const andrePlass = meta.filter(l => l.puljeRang === 2).map(justerMeta).sort(_sammenlignPaaTvers);
  const tredjepl   = meta.filter(l => l.puljeRang === 3).map(justerMeta).sort(_sammenlignPaaTvers);

  const tilgjVinnere = [...vinnere];
  const tilgj3       = [tredjepl[0], tredjepl[1]].filter(Boolean);
  const qfPar        = [];

  for (const t of tilgj3) {
    const idx = tilgjVinnere.findIndex(v => !_samePulje(v.lagId, t.lagId, puljer));
    if (idx >= 0) {
      qfPar.push([tilgjVinnere[idx].lagId, t.lagId]);
      tilgjVinnere.splice(idx, 1);
    }
  }

  const gjenvarendeVinner = tilgjVinnere[0];
  const nr2Sortert        = [...andrePlass];
  const svakNr2Idx        = nr2Sortert.reverse().findIndex(
    n => !_samePulje(gjenvarendeVinner?.lagId, n.lagId, puljer)
  );
  const svakNr2Real = nr2Sortert[svakNr2Idx >= 0 ? svakNr2Idx : 0];
  nr2Sortert.reverse();

  if (gjenvarendeVinner && svakNr2Real) {
    qfPar.push([gjenvarendeVinner.lagId, svakNr2Real.lagId]);
  }

  const brukte  = new Set(qfPar.flat());
  const restNr2 = andrePlass.filter(n => !brukte.has(n.lagId));
  if (restNr2[0] && restNr2[1]) qfPar.push([restNr2[0].lagId, restNr2[1].lagId]);

  const par = qfPar.flat();
  while (par.length < 8) par.push(null);
  return par;
}

function _kryssSeeding4Puljer(meta, puljer) {
  const grp = _grupperPerPulje(meta);
  const justertStats = _justerForUjevnePuljer(grp, puljer);
  const velgJustert = (puljeLag, rang) => {
    const lag = puljeLag.find(l => l.puljeRang === rang);
    return lag ? (justertStats[lag.lagId]?.lagId ?? lag.lagId) : null;
  };
  const [pA, pB, pC, pD] = [grp[0] ?? [], grp[1] ?? [], grp[2] ?? [], grp[3] ?? []];
  const par = [
    velgJustert(pA, 1), velgJustert(pB, 2),
    velgJustert(pC, 1), velgJustert(pD, 2),
    velgJustert(pB, 1), velgJustert(pA, 2),
    velgJustert(pD, 1), velgJustert(pC, 2),
  ];
  return _justerSammePulje(par, puljer);
}

function _grupperPerPulje(meta) {
  const grp = {};
  for (const l of meta) {
    if (!grp[l.puljeIdx]) grp[l.puljeIdx] = [];
    grp[l.puljeIdx].push(l);
  }
  Object.values(grp).forEach(g => g.sort((a, b) => a.puljeRang - b.puljeRang));
  return Object.values(grp);
}

function _velg(puljeLag, rang) {
  return puljeLag.find(l => l.puljeRang === rang)?.lagId ?? null;
}

function _justerSammePulje(par, puljer) {
  for (let qf = 0; qf < 4; qf++) {
    const h = par[qf * 2], b = par[qf * 2 + 1];
    if (h && b && _samePulje(h, b, puljer)) {
      const neste = (qf + 1) % 4;
      [par[qf * 2 + 1], par[neste * 2 + 1]] = [par[neste * 2 + 1], par[qf * 2 + 1]];
    }
  }
  return par;
}

function _trekkSeeding(ids, puljer) {
  const vinnere = ids.filter(id => _erPuljeVinner(id, puljer));
  const resten  = ids.filter(id => !_erPuljeVinner(id, puljer));
  return [
    ..._trekkMedRestriksjon(blandArray(vinnere), puljer),
    ..._trekkMedRestriksjon(blandArray(resten),  puljer),
  ];
}

function _trekkMedRestriksjon(lagIds, puljer) {
  const resultat = [...lagIds];
  for (let forsok = 0; forsok < 20; forsok++) {
    let ok = true;
    for (let i = 0; i < resultat.length - 1; i++) {
      if (_samePulje(resultat[i], resultat[i+1], puljer)) {
        ok = false;
        const j = Math.floor(Math.random() * resultat.length);
        [resultat[i+1], resultat[j]] = [resultat[j], resultat[i+1]];
      }
    }
    if (ok) break;
  }
  return resultat;
}

function _samePulje(id1, id2, puljer) {
  for (const p of (puljer ?? [])) {
    if (p.lagIds.includes(id1) && p.lagIds.includes(id2)) return true;
  }
  return false;
}

function _erPuljeVinner(lagId, puljer) {
  return puljer?.some(p => p.lagIds[0] === lagId) ?? false;
}

// ════════════════════════════════════════════════════════
// ENDELIG RANGERING
// ════════════════════════════════════════════════════════
export function beregnEndeligRangering(turnering) {
  const { sluttspill, lag } = turnering;
  const lagMap = {};
  for (const l of (lag ?? [])) {
    if (l.id)    lagMap[l.id]    = l;
    if (l.lagId) lagMap[l.lagId] = l;
  }
  const plasseringer = [];

  if (sluttspill?.A?.kamper?.length) {
    const a = sluttspill.A.kamper;
    _hentVinnerFraKamp(a, 'A_FIN',     1,  lagMap, plasseringer);
    _hentTaperFraKamp( a, 'A_FIN',     2,  lagMap, plasseringer);
    _hentVinnerFraKamp(a, 'A_BRO',     3,  lagMap, plasseringer);
    _hentTaperFraKamp( a, 'A_BRO',     4,  lagMap, plasseringer);
    _hentVinnerFraKamp(a, 'A_P5_FIN',  5,  lagMap, plasseringer);
    _hentTaperFraKamp( a, 'A_P5_FIN',  6,  lagMap, plasseringer);
    _hentVinnerFraKamp(a, 'A_P7_FIN',  7,  lagMap, plasseringer);
    _hentTaperFraKamp( a, 'A_P7_FIN',  8,  lagMap, plasseringer);
  }

  if (sluttspill?.B?.kamper?.length) {
    const b          = sluttspill.B.kamper;
    const harBBro    = b.some(k => k.id === 'B_BRO');
    const harB13SF   = b.some(k => k.id === 'B_P13_SF');
    const harB13SF1  = b.some(k => k.id === 'B_P13_SF1');
    const harB13FIN  = b.some(k => k.id === 'B_P13_FIN');
    const harB15FIN  = b.some(k => k.id === 'B_P15_FIN');

    _hentVinnerFraKamp(b, 'B_FIN', 9,  lagMap, plasseringer);
    _hentTaperFraKamp( b, 'B_FIN', 10, lagMap, plasseringer);

    if (harBBro) {
      _hentVinnerFraKamp(b, 'B_BRO', 11, lagMap, plasseringer);
      _hentTaperFraKamp( b, 'B_BRO', 12, lagMap, plasseringer);
    } else {
      _hentTapereFraRunde(b, ['B_SF1','B_SF2'], 11, lagMap, plasseringer);
    }

    if (harB13FIN && harB13SF) {
      // 7 lag: B_P13_SF-vinner → B_P13_FIN, B_P13_SF-taper → 15. plass direkte
      _hentVinnerFraKamp(b, 'B_P13_FIN', 13, lagMap, plasseringer);
      _hentTaperFraKamp( b, 'B_P13_FIN', 14, lagMap, plasseringer);
      _hentTaperFraKamp( b, 'B_P13_SF',  15, lagMap, plasseringer);
    } else if (harB13FIN && harB13SF1) {
      // 8 lag: SF1+SF2 → FIN (13./14.) og P15_FIN (15./16.)
      _hentVinnerFraKamp(b, 'B_P13_FIN', 13, lagMap, plasseringer);
      _hentTaperFraKamp( b, 'B_P13_FIN', 14, lagMap, plasseringer);
      if (harB15FIN) {
        _hentVinnerFraKamp(b, 'B_P15_FIN', 15, lagMap, plasseringer);
        _hentTaperFraKamp( b, 'B_P15_FIN', 16, lagMap, plasseringer);
      }
    } else if (harB13FIN) {
      // 5–6 lag: direkte finale om 13./14. plass
      _hentVinnerFraKamp(b, 'B_P13_FIN', 13, lagMap, plasseringer);
      _hentTaperFraKamp( b, 'B_P13_FIN', 14, lagMap, plasseringer);
    } else {
      // Ingen plasseringskamper — inkrementell rekkefølge
      _hentTapereFraRunde(b, ['B_QF1','B_QF2','B_QF3','B_QF4'], 13, lagMap, plasseringer);
    }
  }

  if (sluttspill?.C?.kamper?.length) {
    const c          = sluttspill.C.kamper;
    const harCBro    = c.some(k => k.id === 'C_BRO');
    const harC13SF   = c.some(k => k.id === 'C_P13_SF');
    const harC13SF1  = c.some(k => k.id === 'C_P13_SF1');
    const harC13FIN  = c.some(k => k.id === 'C_P13_FIN');
    const harC15FIN  = c.some(k => k.id === 'C_P15_FIN');

    _hentVinnerFraKamp(c, 'C_FIN', 17, lagMap, plasseringer);
    _hentTaperFraKamp( c, 'C_FIN', 18, lagMap, plasseringer);

    if (harCBro) {
      _hentVinnerFraKamp(c, 'C_BRO', 19, lagMap, plasseringer);
      _hentTaperFraKamp( c, 'C_BRO', 20, lagMap, plasseringer);
    } else {
      _hentTapereFraRunde(c, ['C_SF1','C_SF2'], 19, lagMap, plasseringer);
    }

    if (harC13FIN && harC13SF) {
      _hentVinnerFraKamp(c, 'C_P13_FIN', 21, lagMap, plasseringer);
      _hentTaperFraKamp( c, 'C_P13_FIN', 22, lagMap, plasseringer);
      _hentTaperFraKamp( c, 'C_P13_SF',  23, lagMap, plasseringer);
    } else if (harC13FIN && harC13SF1) {
      _hentVinnerFraKamp(c, 'C_P13_FIN', 21, lagMap, plasseringer);
      _hentTaperFraKamp( c, 'C_P13_FIN', 22, lagMap, plasseringer);
      if (harC15FIN) {
        _hentVinnerFraKamp(c, 'C_P15_FIN', 23, lagMap, plasseringer);
        _hentTaperFraKamp( c, 'C_P15_FIN', 24, lagMap, plasseringer);
      }
    } else if (harC13FIN) {
      _hentVinnerFraKamp(c, 'C_P13_FIN', 21, lagMap, plasseringer);
      _hentTaperFraKamp( c, 'C_P13_FIN', 22, lagMap, plasseringer);
    } else {
      _hentTapereFraRunde(c, ['C_QF1','C_QF2','C_QF3','C_QF4'], 21, lagMap, plasseringer);
    }
  }

  return plasseringer.sort((a, b) => a.plass - b.plass);
}

function _hentVinnerFraKamp(kamper, kampId, plass, lagMap, ut) {
  const k = kamper.find(k => k.id === kampId);
  if (!k?.ferdig) return;
  const id = k.vinnerId ?? k.winnerId
    ?? (k.lag1Poeng != null && k.lag2Poeng != null
        ? (k.lag1Poeng > k.lag2Poeng ? k.lag1Id : k.lag2Id)
        : null);
  if (id) { const lag = lagMap[id]; if (lag) ut.push({ plass, lag }); }
}

function _hentTaperFraKamp(kamper, kampId, plass, lagMap, ut) {
  const k = kamper.find(k => k.id === kampId);
  if (!k?.ferdig) return;
  const id = k.taperId ?? k.loserId
    ?? (k.lag1Poeng != null && k.lag2Poeng != null
        ? (k.lag1Poeng < k.lag2Poeng ? k.lag1Id : k.lag2Id)
        : null);
  if (id) { const lag = lagMap[id]; if (lag) ut.push({ plass, lag }); }
}

function _hentTapereFraRunde(kamper, kampIder, plass, lagMap, ut) {
  let teller = 0;
  for (const kampId of kampIder) {
    const k = kamper.find(k => k.id === kampId);
    if (!k?.ferdig) continue;
    const id = k.taperId ?? k.loserId
      ?? (k.lag1Poeng != null && k.lag2Poeng != null
          ? (k.lag1Poeng < k.lag2Poeng ? k.lag1Id : k.lag2Id)
          : null);
    if (id) {
      const lag = lagMap[id];
      if (lag) ut.push({ plass: plass + teller, lag });
      teller++;
    }
  }
}

// ════════════════════════════════════════════════════════
// FREMGANG-HJELPER
// ════════════════════════════════════════════════════════
export function beregnFremgang(puljer) {
  let totalt = 0, ferdig = 0;
  for (const p of (puljer ?? [])) {
    for (const k of (p.kamper ?? [])) {
      totalt++;
      if (k.ferdig) ferdig++;
    }
  }
  return { totalt, ferdig, prosent: totalt > 0 ? Math.round((ferdig / totalt) * 100) : 0 };
}

// ════════════════════════════════════════════════════════
// BEST AV 3 — LOGIKK
// ════════════════════════════════════════════════════════

/**
 * Beregner stilling og vinner for en best-av-3-kamp.
 * @param {Array<{l1: number, l2: number}>} games
 * @returns {{ lag1Seire, lag2Seire, ferdig, vinnerLag: 1|2|null }}
 */
export function beregnBestOf3(games) {
  let lag1Seire = 0;
  let lag2Seire = 0;

  for (const g of (games ?? [])) {
    if (g == null || g.l1 == null || g.l2 == null) continue;
    if (g.l1 > g.l2) lag1Seire++;
    else if (g.l2 > g.l1) lag2Seire++;
  }

  const ferdig    = lag1Seire >= 2 || lag2Seire >= 2;
  const vinnerLag = ferdig ? (lag1Seire >= 2 ? 1 : 2) : null;

  return { lag1Seire, lag2Seire, ferdig, vinnerLag };
}

/**
 * Validerer ett enkelt game i en best-av-3-kamp.
 * Gjenbruker validerResultat med game-formatet.
 * @param {number} l1
 * @param {number} l2
 * @param {object} format  — kampformat-objekt
 * @returns {{ ok: boolean, feil?: string }}
 */
export function validerGame(l1, l2, format) {
  return validerResultat(l1, l2, format);
}
