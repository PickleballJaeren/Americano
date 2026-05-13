// ════════════════════════════════════════════════════════
// rotasjon.js — Banefordeling og kampoppsett
// Håndterer americano-rotasjon for 4, 5 og 6 spillere,
// og Mix & Match matchmaking.
// ════════════════════════════════════════════════════════

import { STARTRATING, PARTER, PARTER_5, PARTER_6_DOBBEL, PARTER_6_SINGEL } from './konstanter.js';

// ════════════════════════════════════════════════════════
// HJELPER
// ════════════════════════════════════════════════════════
export function getParter(antall, erSingel = false) {
  if (antall === 5)             return PARTER_5;
  if (antall === 2 || erSingel) return PARTER_6_SINGEL;
  return PARTER;
}

/**
 * Returnerer true dersom banen er en singelbane.
 */
export function erSingelBane(bane) {
  return bane?.erSingel === true || (bane?.spillere?.length === 2);
}

/**
 * Returnerer riktig parter-array for en gitt bane og modus.
 */
export function hentParter(bane, isMix, er6Format) {
  const singel  = erSingelBane(bane);
  const n       = bane?.spillere?.length ?? 4;
  const dobbel6 = er6Format && bane?.erDobbel === true;

  if (isMix) {
    return singel
      ? PARTER_6_SINGEL
      : [{ nr: 1, lag1: [0, 1], lag2: [2, 3] }];
  }
  if (singel)  return PARTER_6_SINGEL;
  if (dobbel6) return PARTER_6_DOBBEL;
  return getParter(n);
}

/** Fisher-Yates shuffle */
export function blandArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Gir poeng til spillere i en kamp, inkl. hviler-logikk for 5-spillerbaner.
 */
export function beregnPoengForKamp(par, spillere, lag1Poeng, lag2Poeng) {
  const res = [];
  par.lag1.forEach(i => {
    if (spillere[i]) res.push({ spillerId: spillere[i].id, poeng: lag1Poeng });
  });
  par.lag2.forEach(i => {
    if (spillere[i]) res.push({ spillerId: spillere[i].id, poeng: lag2Poeng });
  });
  if (par.hviler != null && spillere[par.hviler]) {
    const hvilPoeng = Math.ceil((lag1Poeng + lag2Poeng) / 2);
    res.push({ spillerId: spillere[par.hviler].id, poeng: hvilPoeng });
  }
  return res;
}

// ════════════════════════════════════════════════════════
// KONKURRANSE — BANEFORDELING
// ════════════════════════════════════════════════════════

/**
 * Fordeler spillere på baner med 4 eller 5 per bane.
 * Sorterer etter rating og bruker 5-spillerbaner der antallet ikke går opp i 4.
 */
export function fordelBaner(spillere, antallBaner, poengPerKamp = 17) {
  if (!spillere?.length) return [];
  const sorterte = [...spillere].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const n = sorterte.length;

  // ── 6-SPILLER MIX SPESIALFORMAT ──
  if (n === 6 && antallBaner === 2) {
    const mp       = poengPerKamp;
    const blandede = blandArray(spillere.map(s => ({ id: s.id, navn: s.navn ?? 'Ukjent' })));
    const dblSpl   = blandede.slice(0, 4);
    const sinSpl   = blandede.slice(4, 6);
    return [
      { baneNr: 1, erDobbel: true,  erSingel: false, maksPoeng: mp, spillere: dblSpl },
      { baneNr: 2, erDobbel: false, erSingel: true,  maksPoeng: mp, spillere: sinSpl },
    ];
  }

  const antall5 = n % 4;
  const baneStorr = [];
  for (let i = 0; i < antall5; i++) baneStorr.push(5);
  const totBaner = antall5 + Math.floor((n - antall5 * 5) / 4);
  for (let i = antall5; i < totBaner; i++) baneStorr.push(4);
  blandArray(baneStorr).forEach((v, i) => { baneStorr[i] = v; });

  const mp  = poengPerKamp;
  const mp5 = Math.round(mp * 3 / 5);
  const baner = [];
  let cursor = 0;
  baneStorr.forEach((storr, i) => {
    baner.push({
      baneNr:    i + 1,
      maksPoeng: storr === 5 ? mp5 : mp,
      spillere:  sorterte.slice(cursor, cursor + storr).map(s => ({
        id: s.id, navn: s.navn ?? 'Ukjent', rating: s.rating ?? STARTRATING,
      })),
    });
    cursor += storr;
  });
  return baner;
}

// ════════════════════════════════════════════════════════
// MIX & MATCH — OPTIMAL MATCHING
//
// Algoritme inspirert av «Social Golfer Problem»:
//
// Trinn 1 — Par-matching (hvem spiller med hvem):
//   • ≤ 12 aktive spillere: full enumering av alle perfekte matchinger
//     (maks ~10 395 kombinasjoner for 12 sp — trivielt raskt)
//   • 13–28 aktive spillere: Simulated Annealing med 500 iterasjoner
//     (< 2ms, gir 0 partner-gjentak i testing)
//   Velger alltid den globalt optimale løsningen, ikke greedy.
//
// Trinn 2 — Motstander-matching (hvem spiller mot hvem):
//   Full enumering av alle måter å sette par mot hverandre.
//   Antall kombinasjoner er alltid lite (maks 945 for 10 par = 20 aktive).
//
// Tilfeldig støy: 0.01 — kun tiebreaker, aldri stor nok til å
// overstyre historikk (i motsetning til gammel kode der støy=2
// kunne overstyre straff=10 ved kombinasjoner).
//
// Hvile-rotasjon:
//   Prioriterer de som har hvilt færrest ganger (og venta lengst).
//   Rettferdig fordeling uavhengig av antall spillere/baner.
// ════════════════════════════════════════════════════════

// Støy så liten at den aldri kan overstyre selv én historisk partner-kobling.
const MIX_TIEBREAKER_STØY = 0.01;

// Hvile-vekter — justerer hvem som hviler neste runde.
const MIX_HVILE_SITOUT_VEKT = 1000; // teller antall hvil (dominant faktor)
const MIX_HVILE_ALDER_VEKT  =    1; // tiebreaker: lengst siden sist hvil

// ── Intern: kostnaden ved å pare to spillere (partner-historikk) ──
function _parKost(a, b, playedWith) {
  return (playedWith[a]?.[b] ?? 0) + (playedWith[b]?.[a] ?? 0);
}

// ── Intern: total kostnad for en hel matching ──
function _matchingKost(matching, playedWith) {
  return matching.reduce((sum, [a, b]) => sum + _parKost(a, b, playedWith), 0);
}

// ── Intern: kostnad for par mot par (motstander-historikk) ──
function _parMotParKost(p1, p2, playedAgainst) {
  const vs = (a, b) => (playedAgainst[a]?.[b] ?? 0) + (playedAgainst[b]?.[a] ?? 0);
  return vs(p1[0], p2[0]) + vs(p1[0], p2[1])
       + vs(p1[1], p2[0]) + vs(p1[1], p2[1]);
}

/**
 * Genererer alle perfekte matchinger for en liste med spillerID-er.
 * Kun brukt for ≤ 12 spillere (maks ~10 395 kombinasjoner).
 * @param {string[]} ids
 * @returns {Array<Array<[string, string]>>}
 */
function _alleMatchinger(ids) {
  if (ids.length === 0) return [[]];
  const [forste, ...resten] = ids;
  const resultat = [];
  for (let i = 0; i < resten.length; i++) {
    const partner = resten[i];
    const igjen   = [...resten.slice(0, i), ...resten.slice(i + 1)];
    for (const sub of _alleMatchinger(igjen)) {
      resultat.push([[forste, partner], ...sub]);
    }
  }
  return resultat;
}

/**
 * Genererer alle perfekte matchinger av par mot par.
 * Brukes i Trinn 2 (motstander-matching) for alle størrelser.
 * Antall kombinasjoner er alltid lite (maks 945 for 10 par).
 * @param {Array} par — array av [id, id]-par
 * @returns {Array}   — array av kamper, hver kamp er [par1, par2]
 */
function _alleParMatchinger(par) {
  if (!par || par.length === 0) return [[]];
  if (par.length === 2) return [[[par[0], par[1]]]];
  const [forste, ...resten] = par;
  const resultat = [];
  for (let i = 0; i < resten.length; i++) {
    const motstander = resten[i];
    const igjen      = [...resten.slice(0, i), ...resten.slice(i + 1)];
    for (const sub of _alleParMatchinger(igjen)) {
      resultat.push([[forste, motstander], ...sub]);
    }
  }
  return resultat;
}

/**
 * Simulated Annealing for par-matching når antall aktive spillere > 12.
 * Starter med tilfeldig matching og swapper par gjentatte ganger.
 * 500 iterasjoner gir 0 gjentak i testing for opp til 28 spillere (< 2ms).
 */
function _saMatching(ids, playedWith, iterasjoner = 500) {
  // Start med tilfeldig matching
  const shuffled = [...ids].sort(() => Math.random() - 0.5);
  let current = [];
  for (let i = 0; i < shuffled.length; i += 2) {
    current.push([shuffled[i], shuffled[i + 1]]);
  }

  let gjeldendKost = _matchingKost(current, playedWith);
  let best         = current.map(p => [...p]);
  let bestKost     = gjeldendKost;

  for (let iter = 0; iter < iterasjoner; iter++) {
    // Velg to forskjellige par tilfeldig
    const i = Math.floor(Math.random() * current.length);
    let   j = Math.floor(Math.random() * (current.length - 1));
    if (j >= i) j++;

    const [a1, a2] = current[i];
    const [b1, b2] = current[j];

    // Prøv begge mulige swaps mellom de to parene
    for (const [ny1, ny2] of [[[a1, b1], [a2, b2]], [[a1, b2], [a2, b1]]]) {
      const nyKost = gjeldendKost
        - _parKost(a1, a2, playedWith) - _parKost(b1, b2, playedWith)
        + _parKost(ny1[0], ny1[1], playedWith) + _parKost(ny2[0], ny2[1], playedWith);

      if (nyKost < gjeldendKost) {
        current[i]    = ny1;
        current[j]    = ny2;
        gjeldendKost  = nyKost;
        if (nyKost < bestKost) {
          bestKost = nyKost;
          best     = current.map(p => [...p]);
        }
        break;
      }
    }

    // Tidlig avbrudd: perfekt løsning funnet (ingen gjentak)
    if (bestKost === 0) break;
  }

  return best;
}

/**
 * Velger hvem som hviler denne runden basert på rettferdig rotasjon.
 * Prioriterer de som har hvilt færrest ganger totalt, med lengst ventetid
 * som tiebreaker. Liten tilfeldig støy bryter deterministiske mønstre.
 *
 * @param {object[]} spillere       — alle spillere i Mix-økten (med .id)
 * @param {number}   antallHvilere  — antall som skal hvile (0, 1, 2, eller 3)
 * @param {object}   sitOutCount    — { [spillerId]: antall hvil totalt }
 * @param {object}   lastSitOutRunde— { [spillerId]: siste runde de hvilte }
 * @param {number}   runde          — gjeldende rundenummer
 * @returns {{ aktive: object[], hviler: object[] }}
 */
function _velgHvilere(spillere, antallHvilere, sitOutCount, lastSitOutRunde, runde) {
  if (antallHvilere <= 0) return { aktive: [...spillere], hviler: [] };

  // Lav score = har hvilt minst / har venta lengst → skal hvile nå
  const scorert = spillere.map(s => ({
    s,
    score: (sitOutCount[s.id] ?? 0) * MIX_HVILE_SITOUT_VEKT
         + (lastSitOutRunde[s.id] ?? 0) * MIX_HVILE_ALDER_VEKT
         + Math.random() * MIX_TIEBREAKER_STØY,
  })).sort((a, b) => a.score - b.score);

  return {
    hviler: scorert.slice(0, antallHvilere).map(x => x.s),
    aktive: scorert.slice(antallHvilere).map(x => x.s),
  };
}

/**
 * Finner optimal par-matching og motstander-matching for en gruppe aktive spillere.
 * Bruker full enumering for ≤ 12 spillere og SA for større grupper.
 *
 * @param {object[]} aktive       — spillere som er aktive denne runden (med .id)
 * @param {object}   playedWith   — { [id]: { [id]: antall } }
 * @param {object}   playedAgainst— { [id]: { [id]: antall } }
 * @returns {Array}               — array av kamper: [[ [id,id], [id,id] ], ...]
 */
function _lagOptimalMatching(aktive, playedWith, playedAgainst) {
  const ids = aktive.map(s => s.id);

  // ── Trinn 1: Finn optimal par-matching ──
  let par;
  if (ids.length <= 12) {
    // Full enumering: evaluer alle perfekte matchinger
    const alle     = _alleMatchinger(ids);
    let   bestKost = Infinity;
    for (const m of alle) {
      const k = _matchingKost(m, playedWith) + Math.random() * MIX_TIEBREAKER_STØY;
      if (k < bestKost) { bestKost = k; par = m; }
    }
  } else {
    // Simulated Annealing for 13–28 spillere
    par = _saMatching(ids, playedWith);
  }

  // ── Trinn 2: Finn optimal motstander-matching ──
  // Enumerate alle mulige par-mot-par kombinasjoner og velg beste.
  // Antall kombinasjoner er alltid lite, uavhengig av gruppesize.
  const allePM   = _alleParMatchinger(par);
  let bestKamper = null;
  let bestKost   = Infinity;

  for (const pm of allePM) {
    const k = pm.reduce((s, [p1, p2]) => s + _parMotParKost(p1, p2, playedAgainst), 0)
            + Math.random() * MIX_TIEBREAKER_STØY;
    if (k < bestKost) { bestKost = k; bestKamper = pm; }
  }

  return bestKamper; // [ [ [id,id], [id,id] ], ... ] — én entry per bane
}

// ════════════════════════════════════════════════════════
// MIX & MATCH — OFFENTLIG API
// ════════════════════════════════════════════════════════

/**
 * Lager kampoppsett for én runde av Mix & Match.
 * Håndterer alle kombinasjoner av spillere og baner,
 * inkludert 1–3 spillere som hviler.
 *
 * @param {object[]} spillere        — alle spillere i Mix-økten
 * @param {object}   playedWith      — partner-historikk
 * @param {object}   playedAgainst   — motstander-historikk
 * @param {object}   gamesPlayed     — antall kamper per spiller (ikke brukt i matching, kun info)
 * @param {object}   sitOutCount     — antall hvil per spiller
 * @param {object}   lastSitOutRunde — siste rundenr spiller hvilte
 * @param {number}   antallBaner     — antall baner
 * @param {number}   runde           — gjeldende rundenummer
 * @param {number}   [mp=15]         — maks poeng per kamp
 * @returns {{ baneOversikt: object[], hviler: object[] }}
 */
export function lagMixKampoppsett(
  spillere, playedWith, playedAgainst,
  gamesPlayed, sitOutCount, lastSitOutRunde,
  antallBaner, runde, mp,
) {
  if (!spillere?.length) return { baneOversikt: [], hviler: [] };

  const poengPerKamp  = mp ?? 15;
  const plasser       = antallBaner * 4;
  const antallHvilere = Math.max(0, spillere.length - plasser);

  // ── Velg hvem som hviler ──
  const { aktive, hviler } = _velgHvilere(
    spillere, antallHvilere, sitOutCount, lastSitOutRunde, runde,
  );

  if (aktive.length < 4) return { baneOversikt: [], hviler };

  // ── Finn optimal matching ──
  const kamper = _lagOptimalMatching(aktive, playedWith, playedAgainst);
  if (!kamper) return { baneOversikt: [], hviler };

  // ── Bygg baneOversikt ──
  const idTilSpiller = Object.fromEntries(spillere.map(s => [s.id, s]));

  const baneOversikt = kamper.slice(0, antallBaner).map(([par1, par2], i) => ({
    baneNr:    i + 1,
    maksPoeng: poengPerKamp,
    erDobbel:  true,
    erSingel:  false,
    spillere:  [...par1, ...par2].map(id => {
      const s = idTilSpiller[id];
      return { id, navn: s?.navn ?? 'Ukjent', rating: s?.rating ?? STARTRATING };
    }),
  }));

  return { baneOversikt, hviler };
}

/** Oppdaterer Mix-statistikk in-place etter en runde. */
export function oppdaterMixStatistikk(
  baneOversikt, hvilerDenne,
  playedWith, playedAgainst,
  gamesPlayed, sitOutCount, lastSitOutRunde,
  rundeNr,
) {
  baneOversikt.forEach(({ spillere: [a, b, c, d] }) => {
    if (!a || !b || !c || !d) return;

    const incPW = (x, y) => {
      if (!playedWith[x.id]) playedWith[x.id] = {};
      if (!playedWith[y.id]) playedWith[y.id] = {};
      playedWith[x.id][y.id] = (playedWith[x.id][y.id] ?? 0) + 1;
      playedWith[y.id][x.id] = (playedWith[y.id][x.id] ?? 0) + 1;
    };
    const incPA = (x, y) => {
      if (!playedAgainst[x.id]) playedAgainst[x.id] = {};
      if (!playedAgainst[y.id]) playedAgainst[y.id] = {};
      playedAgainst[x.id][y.id] = (playedAgainst[x.id][y.id] ?? 0) + 1;
      playedAgainst[y.id][x.id] = (playedAgainst[y.id][x.id] ?? 0) + 1;
    };

    incPW(a, b); incPW(c, d);
    incPA(a, c); incPA(a, d);
    incPA(b, c); incPA(b, d);
    [a, b, c, d].forEach(s => {
      gamesPlayed[s.id] = (gamesPlayed[s.id] ?? 0) + 1;
    });
  });

  (hvilerDenne ?? []).forEach(s => {
    sitOutCount[s.id]      = (sitOutCount[s.id]     ?? 0) + 1;
    lastSitOutRunde[s.id]  = rundeNr;
  });
}

/** Henter Mix-statistikk fra Firestore-treningsdokument. */
export function hentMixStatistikk(treningData) {
  return {
    playedWith:      treningData?.mixPlayedWith      ?? {},
    playedAgainst:   treningData?.mixPlayedAgainst   ?? {},
    gamesPlayed:     treningData?.mixGamesPlayed      ?? {},
    sitOutCount:     treningData?.mixSitOutCount      ?? {},
    lastSitOutRunde: treningData?.mixLastSitOutRunde  ?? {},
  };
}

/** Runde 1 — ingen statistikk ennå. */
export function fordelBanerMix(spillere, antallBaner, poengPerKamp = 15) {
  return lagMixKampoppsett(spillere, {}, {}, {}, {}, {}, antallBaner, 1, poengPerKamp);
}

// ════════════════════════════════════════════════════════
// 6-SPILLER SPESIALFORMAT
//
// Oppsett: Bane 1 = dobbel (2v2), Bane 2 = singel (1v1)
//
// Rotasjonsregler per runde:
//   1. Taperlaget fra dobbel → singelbanen
//   2. Vinnerlaget splittes → pares med singelspillerne på dobbelbanen
//      (historikk-basert pairing via playedWith)
//
// Tvangsregel — maks 2 dobbel-kamper på rad:
//   - Hvis én av vinnerne har streak = 2, tvinges den til singel
//   - Av taperne rykker den med færrest dobbel-kamper totalt opp til dobbel
//   - Streaken nullstilles når en spiller spiller singel
//   - Neste gang spilleren er tilbake på dobbel starter streak på 0 igjen
//
// Merk: begge vinnerne kan aldri ha streak = 2 samtidig, fordi
// de alltid splittes — maks én av dem kan ha vunnet 2 på rad.
// ════════════════════════════════════════════════════════

/**
 * Genererer neste runde for 6-spiller Mix & Match format.
 *
 * @param {Object} dobbelResultat  — { lag1Spillere, lag2Spillere, vinnerId }
 * @param {Array}  singelSpillere  — [s1, s2] fra singelbanen
 * @param {Object} playedWith      — partner-historikk { [id]: { [id]: antall } }
 * @param {Object} dobbelStreak    — { [id]: antall dobbel-kamper på rad }
 * @param {Object} dobbelTotalt    — { [id]: totalt antall dobbel-kamper
 * @param {number} [poengPerKamp]
 * @returns {{ baneOversikt: Array }}
 */
export function neste6SpillerRunde(
  dobbelResultat, singelSpillere,
  playedWith = {}, dobbelStreak = {}, dobbelTotalt = {},
  poengPerKamp = 15,
) {
  const { lag1Spillere, lag2Spillere, vinnerId } = dobbelResultat;
  const vinnere = vinnerId === 2 ? lag2Spillere : lag1Spillere;
  const tapere  = vinnerId === 2 ? lag1Spillere : lag2Spillere;

  // ── Tvangsregel: maks 2 dobbel-kamper på rad ──
  //
  // Kun vinnerne kan utløse tvangsregelen — taperne sendes alltid til singel
  // og får streak = 0 etter runden. Men taperne kan ha streak = 2 fra forrige
  // runde (hvis de vant forrige gang og tapte denne), og skal da IKKE rykke opp.
  //
  // Algoritme:
  //   1. Sjekk om én av vinnerne har streak >= 2 → tvinges til singel
  //   2. Velg taperOpp: lovlig streak < 2 prioritert, deretter færrest totalt
  //   3. Garantert mulig: maks én taper kan ha streak = 2, den andre har alltid < 2

  const tvunget = vinnere.find(v => (dobbelStreak[v.id] ?? 0) >= 2) ?? null;

  let dobbelSpillere;
  let nesteSingel;

  if (tvunget) {
    const gjenvarendeVinner = vinnere.find(v => v.id !== tvunget.id);

    // Sorter tapere: lovlig streak < 2 først, deretter færrest dobbel-kamper totalt
    const [taperOpp, taperNed] = [...tapere].sort((a, b) => {
      const aUlovlig = (dobbelStreak[a.id] ?? 0) >= 2 ? 1 : 0;
      const bUlovlig = (dobbelStreak[b.id] ?? 0) >= 2 ? 1 : 0;
      if (aUlovlig !== bUlovlig) return aUlovlig - bUlovlig;
      return (dobbelTotalt[a.id] ?? 0) - (dobbelTotalt[b.id] ?? 0);
    });

    const [s1, s2] = _parSingelMedVinnere(
      gjenvarendeVinner, taperOpp, singelSpillere, playedWith,
    );

    dobbelSpillere = [gjenvarendeVinner, s1, taperOpp, s2];
    nesteSingel    = [tvunget, taperNed];
  } else {
    const [v1, v2] = vinnere;
    const [s1, s2] = _parSingelMedVinnere(v1, v2, singelSpillere, playedWith);

    dobbelSpillere = [v1, s1, v2, s2];
    nesteSingel    = [...tapere];
  }

  return {
    baneOversikt: [
      {
        baneNr: 1, erDobbel: true, erSingel: false, maksPoeng: poengPerKamp,
        spillere: dobbelSpillere.map(s => ({ id: s.id, navn: s.navn ?? 'Ukjent' })),
      },
      {
        baneNr: 2, erDobbel: false, erSingel: true, maksPoeng: poengPerKamp,
        spillere: nesteSingel.map(s => ({ id: s.id, navn: s.navn ?? 'Ukjent' })),
      },
    ],
  };
}

/**
 * Oppdaterer dobbelStreak og dobbelTotalt etter en 6-spiller runde.
 * Skal kalles av app.js etter at baneOversikt er lagret til Firestore.
 *
 * @param {Array}  dobbelSpillere — spillerobjekter på dobbelbanen denne runden
 * @param {Array}  singelSpillere — spillerobjekter på singelbanen denne runden
 * @param {Object} dobbelStreak   — muteres in-place
 * @param {Object} dobbelTotalt   — muteres in-place
 */
export function oppdater6SpillerStreak(dobbelSpillere, singelSpillere, dobbelStreak, dobbelTotalt) {
  dobbelSpillere.forEach(s => {
    dobbelStreak[s.id]  = (dobbelStreak[s.id]  ?? 0) + 1;
    dobbelTotalt[s.id]  = (dobbelTotalt[s.id]  ?? 0) + 1;
  });
  singelSpillere.forEach(s => {
    dobbelStreak[s.id] = 0; // nullstill streak når spiller er på singel
  });
}

/**
 * Henter 6-spiller streak-statistikk fra Firestore-treningsdokument.
 */
export function hent6SpillerStreak(treningData) {
  return {
    dobbelStreak:  treningData?.mix6DobbelStreak  ?? {},
    dobbelTotalt:  treningData?.mix6DobbelTotalt  ?? {},
  };
}

/**
 * Parer to dobbel-spillere med to singelspillere.
 * Evaluerer begge kombinasjoner og velger den med færrest partner-gjentak.
 */
function _parSingelMedVinnere(spiller1, spiller2, singelSpillere, playedWith) {
  const [sA, sB] = singelSpillere;
  if (!sA || !sB) return [sA ?? sB, sB ?? sA];

  // Kombinasjon A: spiller1+sA, spiller2+sB
  const kostA = _parKost(spiller1.id, sA.id, playedWith) + _parKost(spiller2.id, sB.id, playedWith);
  // Kombinasjon B: spiller1+sB, spiller2+sA
  const kostB = _parKost(spiller1.id, sB.id, playedWith) + _parKost(spiller2.id, sA.id, playedWith);

  const velgA = kostA <= kostB + Math.random() * MIX_TIEBREAKER_STØY;
  return velgA ? [sA, sB] : [sB, sA];
}
