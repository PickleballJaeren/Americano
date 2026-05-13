// ════════════════════════════════════════════════════════
// turnering.js — Firestore-operasjoner for turneringer
// All beregningslogikk ligger i turnering-logikk.js.
// ════════════════════════════════════════════════════════

import {
  db,
  collection, doc, addDoc, updateDoc, getDoc, getDocs,
  query, where, orderBy, serverTimestamp, writeBatch,
} from './firebase.js';
import { app } from './state.js';
import { visMelding, visFBFeil } from './ui.js';
import {
  T_STATUS,
  SEEDING_MODUS,
  STANDARD_KAMPFORMAT,
  lagKampformat,
  validerResultat,
  hentFormatForRunde,
  genererPuljer,
  genererRoundRobin,
  genererKamperMed4Puljer6Baner,
  genererKamperMed3Puljer6Baner,
  genererKamperMed2Puljer6Baner,
  beregnPuljetabell,
  kvalifiserTilSluttspill,
  startnivaa,
  genererABracket,
  genererBCBracket,
  seedALag,
  beregnEndeligRangering,
  beregnFremgang,
  beregnBestOf3,
  validerGame,
} from './turnering-logikk.js';

// Re-eksporter logikk-funksjoner slik at eksisterende import-setninger
// i turnering-ui.js og arkiv.js ikke trenger å endres.
export {
  T_STATUS,
  SEEDING_MODUS,
  STANDARD_KAMPFORMAT,
  lagKampformat,
  validerResultat,
  hentFormatForRunde,
  genererPuljer,
  genererRoundRobin,
  genererKamperMed4Puljer6Baner,
  genererKamperMed3Puljer6Baner,
  genererKamperMed2Puljer6Baner,
  beregnPuljetabell,
  kvalifiserTilSluttspill,
  startnivaa,
  genererABracket,
  genererBCBracket,
  seedALag,
  beregnEndeligRangering,
  beregnFremgang,
  beregnBestOf3,
  validerGame,
};

// ── Avhengigheter injisert fra app.js ────────────────────
let _naviger         = () => {};
let _krevAdmin       = () => {};
let _getAktivKlubbId = () => null;

export function turneringInit(deps) {
  _naviger         = deps.naviger;
  _krevAdmin       = deps.krevAdmin;
  _getAktivKlubbId = deps.getAktivKlubbId;
}

// ════════════════════════════════════════════════════════
// FIRESTORE — SAMLINGER
// ════════════════════════════════════════════════════════
const TS = {
  TURNERINGER: 'turneringer',
  T_KAMPER:    'turneringKamper',
};

// ════════════════════════════════════════════════════════
// OPPRETTING
// ════════════════════════════════════════════════════════
export async function opprettTurnering(konfig) {
  const klubbId = _getAktivKlubbId();
  if (!klubbId) throw new Error('Ingen aktiv klubb.');

  const {
    navn                  = 'Ny turnering',
    antallPuljer          = 2,
    antallBaner           = 6,
    seedingModus          = SEEDING_MODUS.STANDARD,
    plasseringskamperA    = true,
    plasseringskamperBC   = false,
    kampformatPulje       = { ...STANDARD_KAMPFORMAT },
    kampformatKvartfinale = { ...STANDARD_KAMPFORMAT },
    kampformatSemifinale  = { ...STANDARD_KAMPFORMAT },
    kampformatFinale      = lagKampformat('single', 15),
  } = konfig;

  const doc_ = await addDoc(collection(db, TS.TURNERINGER), {
    klubbId,
    navn,
    antallBaner,
    status:     T_STATUS.SETUP,
    opprettet:  serverTimestamp(),
    lag:        [],
    puljer:     [],
    sluttspill: { A: null, B: null, C: null },
    konfig: {
      antallPuljer,
      antallBaner,
      seedingModus,
      plasseringskamperA,
      plasseringskamperBC,
      kampformatPulje,
      kampformatKvartfinale,
      kampformatSemifinale,
      kampformatFinale,
    },
  });

  app.turnering = {
    id: doc_.id, status: T_STATUS.SETUP,
    lag: [], puljer: [], sluttspill: { A: null, B: null, C: null }, konfig,
  };
  return doc_.id;
}

// ════════════════════════════════════════════════════════
// HENT
// ════════════════════════════════════════════════════════
export async function hentTurnering(turneringId) {
  const snap = await getDoc(doc(db, TS.TURNERINGER, turneringId));
  if (!snap.exists()) throw new Error('Turnering ikke funnet.');
  return { id: snap.id, ...snap.data() };
}

export async function hentAktiveTurneringer() {
  const klubbId = _getAktivKlubbId();
  if (!klubbId || !db) return [];
  try {
    const snap = await getDocs(
      query(collection(db, TS.TURNERINGER),
        where('klubbId', '==', klubbId),
        where('status', '!=', T_STATUS.FINISHED),
        orderBy('status'),
        orderBy('opprettet', 'desc')
      )
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('[Turnering] hentAktiveTurneringer:', e?.message);
    return [];
  }
}

export async function hentAlleTurneringer() {
  const klubbId = _getAktivKlubbId();
  if (!klubbId || !db) return [];
  try {
    const snap = await getDocs(
      query(collection(db, TS.TURNERINGER),
        where('klubbId', '==', klubbId),
        where('status', '!=', 'slettet'),
        orderBy('status'),
        orderBy('opprettet', 'desc')
      )
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('[Turnering] hentAlleTurneringer:', e?.message);
    return [];
  }
}

// ════════════════════════════════════════════════════════
// KJENTE SPILLERE — til turneringsregistrering
// Henter spillere fra ratinglisten og fra alle tidligere
// turneringer (spiller1/spiller2 på lag), slår sammen og
// dedupliserer på navn (case-insensitiv).
// ════════════════════════════════════════════════════════
export async function hentKjenteSpillere() {
  const klubbId = _getAktivKlubbId();
  if (!klubbId || !db) return [];

  const navnSet  = new Set();
  const spillere = [];

  const leggTil = (navn) => {
    const key = navn?.trim().toLowerCase();
    if (!key || navnSet.has(key)) return;
    navnSet.add(key);
    spillere.push(navn.trim());
  };

  try {
    // 1. Ratingliste (players-samlingen)
    const ratSnap = await getDocs(
      query(collection(db, 'players'),
        where('klubbId', '==', klubbId)
      )
    );
    ratSnap.docs.forEach(d => {
      const data = d.data();
      if (data.navn) leggTil(data.navn);
    });
  } catch (e) {
    console.warn('[hentKjenteSpillere] ratingliste:', e?.message);
  }

  try {
    // 2. Alle turneringer — hent spiller1/spiller2 fra lag
    const tSnap = await getDocs(
      query(collection(db, TS.TURNERINGER),
        where('klubbId', '==', klubbId),
        where('status', '!=', 'slettet'),
        orderBy('status'),
        orderBy('opprettet', 'desc')
      )
    );
    tSnap.docs.forEach(d => {
      const lag = d.data().lag ?? [];
      lag.forEach(l => {
        if (l.spiller1) leggTil(l.spiller1);
        if (l.spiller2) leggTil(l.spiller2);
        // Fallback: split navn på ' / ' for eldre data
        if (!l.spiller1 && l.navn?.includes(' / ')) {
          const [s1, s2] = l.navn.split(' / ');
          leggTil(s1); leggTil(s2);
        }
      });
    });
  } catch (e) {
    console.warn('[hentKjenteSpillere] turneringer:', e?.message);
  }

  return spillere.sort((a, b) => a.localeCompare(b, 'no'));
}

export async function leggTilLag(turneringId, spiller1, spiller2) {
  const s1 = spiller1?.trim();
  const s2 = spiller2?.trim();
  if (!s1) throw new Error('Spiller 1 kan ikke være tomt.');
  if (!s2) throw new Error('Spiller 2 kan ikke være tomt.');
  const t = await hentTurnering(turneringId);
  if (t.status !== T_STATUS.SETUP) throw new Error('Kan kun endre lag i oppsettfasen.');
  if (t.lag.length >= 32) throw new Error('Maks 32 lag per turnering.');

  const nyttLag = {
    id:       `lag_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    navn:     `${s1} / ${s2}`,
    spiller1: s1,
    spiller2: s2,
    seed:     t.lag.length + 1,
  };
  await updateDoc(doc(db, TS.TURNERINGER, turneringId), { lag: [...t.lag, nyttLag] });
  return nyttLag;
}

export async function fjernLag(turneringId, lagId) {
  const t = await hentTurnering(turneringId);
  if (t.status !== T_STATUS.SETUP) throw new Error('Kan kun endre lag i oppsettfasen.');
  const nyeLag = t.lag.filter(l => l.id !== lagId)
    .map((l, i) => ({ ...l, seed: i + 1 }));
  await updateDoc(doc(db, TS.TURNERINGER, turneringId), { lag: nyeLag });
}

export async function oppdaterLagNavn(turneringId, lagId, spiller1, spiller2) {
  const s1 = spiller1?.trim();
  const s2 = spiller2?.trim();
  if (!s1) throw new Error('Spiller 1 kan ikke være tomt.');
  if (!s2) throw new Error('Spiller 2 kan ikke være tomt.');
  const t = await hentTurnering(turneringId);
  if (t.status !== T_STATUS.SETUP) throw new Error('Kan kun endre lag i oppsettfasen.');
  const nyeLag = t.lag.map(l => l.id === lagId
    ? { ...l, navn: `${s1} / ${s2}`, spiller1: s1, spiller2: s2 }
    : l
  );
  await updateDoc(doc(db, TS.TURNERINGER, turneringId), { lag: nyeLag });
}

export async function flyttLag(turneringId, lagId, tilPuljeId) {
  const t = await hentTurnering(turneringId);
  if (t.status !== T_STATUS.SETUP && t.status !== T_STATUS.GROUP_PLAY) {
    throw new Error('Kan kun flytte lag før eller under puljespill.');
  }

  // Flytt laget mellom puljene
  let nyePuljer = t.puljer
    .map(p => ({ ...p, lagIds: p.lagIds.filter(id => id !== lagId) }))
    .map(p => p.id === tilPuljeId ? { ...p, lagIds: [...p.lagIds, lagId] } : p);

  // Under puljespill: regenerer kamper for berørte puljer
  if (t.status === T_STATUS.GROUP_PLAY) {
    nyePuljer = nyePuljer.map(p => {
      const opprinnelig = t.puljer.find(op => op.id === p.id);
      const endret = JSON.stringify(opprinnelig?.lagIds?.slice().sort()) !== JSON.stringify(p.lagIds.slice().sort());
      if (!endret) return p;
      // Regenerer kamper med round-robin for endret pulje
      const { genererRoundRobin } = window._turneringLogikk ?? {};
      const nyeKamper = genererRoundRobinLokal(p.lagIds);
      return { ...p, kamper: nyeKamper };
    });
  }

  await updateDoc(doc(db, TS.TURNERINGER, turneringId), { puljer: nyePuljer });
}

/** Lokal round-robin generator (brukes ved lag-flytting i GROUP_PLAY) */
function genererRoundRobinLokal(lagIds) {
  const n = lagIds.length;
  const kamper = [];
  let kampNr = 1;
  if (n < 2) return kamper;
  const liste = [...lagIds];
  if (n % 2 !== 0) liste.push('BYE');
  const m = liste.length;
  for (let runde = 0; runde < m - 1; runde++) {
    for (let i = 0; i < m / 2; i++) {
      const h = liste[i], b = liste[m - 1 - i];
      if (h !== 'BYE' && b !== 'BYE') {
        kamper.push({
          id: `rr_${Date.now()}_${kampNr}`,
          kampNr: kampNr++,
          runde: runde + 1,
          lag1Id: h, lag2Id: b,
          lag1Poeng: null, lag2Poeng: null,
          ferdig: false, walkover: false,
        });
      }
    }
    const siste = liste.pop();
    liste.splice(1, 0, siste);
  }
  return kamper;
}

// ════════════════════════════════════════════════════════
// PULJESPILL
// ════════════════════════════════════════════════════════
export async function lagrePuljer(turneringId, puljer) {
  await updateDoc(doc(db, TS.TURNERINGER, turneringId), { puljer });
}

export async function startPuljespill(turneringId) {
  const t = await hentTurnering(turneringId);
  if (t.status !== T_STATUS.SETUP) throw new Error('Turneringen er allerede startet.');
  if (!t.puljer?.length) throw new Error('Generer puljer først.');
  if (!t.lag?.length) throw new Error('Ingen lag registrert.');

  const puljeMedKamper = (() => {
    const antallPuljer = t.puljer.length;
    const antallBaner  = t.antallBaner ?? t.konfig?.antallBaner ?? 6;
    // Bruk global rotasjon for 4 puljer / 6 baner
    if (antallPuljer === 4 && antallBaner === 6) {
      return genererKamperMed4Puljer6Baner(t.puljer);
    }
    // Bruk global rotasjon for 3 puljer / 6 baner
    if (antallPuljer === 3 && antallBaner === 6) {
      return genererKamperMed3Puljer6Baner(t.puljer);
    }
    // Bruk global rotasjon for 2 puljer / 6 baner
    if (antallPuljer === 2 && antallBaner === 6) {
      return genererKamperMed2Puljer6Baner(t.puljer);
    }
    // Standard round-robin ellers
    return t.puljer.map(p => ({
      ...p,
      kamper: genererRoundRobin(p.lagIds),
    }));
  })();

  const batch = writeBatch(db);
  batch.update(doc(db, TS.TURNERINGER, turneringId), {
    puljer:    puljeMedKamper,
    status:    T_STATUS.GROUP_PLAY,
    startDato: serverTimestamp(),
  });
  await batch.commit();

  visMelding('Puljespill startet!');
  return puljeMedKamper;
}

export async function registrerPuljeresultat(turneringId, puljeId, kampId, lag1Poeng, lag2Poeng, games = null) {
  const t = await hentTurnering(turneringId);
  if (t.status !== T_STATUS.GROUP_PLAY) throw new Error('Puljespill er ikke aktivt.');

  const format = t.konfig?.kampformatPulje ?? STANDARD_KAMPFORMAT;

  if (format.type === 'best_of_3' && games?.length) {
    for (let i = 0; i < games.length; i++) {
      const val = validerResultat(games[i].l1, games[i].l2, format);
      if (!val.ok) throw new Error(`Game ${i + 1}: ${val.feil}`);
    }
  } else {
    const valider = validerResultat(lag1Poeng, lag2Poeng, format);
    if (!valider.ok) throw new Error(valider.feil);
  }

  // Oppdater kampresultat
  let nyePuljer = t.puljer.map(p => p.id !== puljeId ? p : ({
    ...p,
    kamper: (p.kamper ?? []).map(k => k.id !== kampId ? k : {
      ...k,
      lag1Poeng,
      lag2Poeng,
      ferdig: true,
      ...(games ? { games } : {}),
    }),
  }));

  await updateDoc(doc(db, TS.TURNERINGER, turneringId), { puljer: nyePuljer });
}

export async function registrerWalkover(turneringId, puljeId, kampId, vinnerId) {
  const t = await hentTurnering(turneringId);
  const nyePuljer = t.puljer.map(p => p.id !== puljeId ? p : {
    ...p,
    kamper: (p.kamper ?? []).map(k => {
      if (k.id !== kampId) return k;
      const vinner1 = k.lag1Id === vinnerId;
      return {
        ...k,
        lag1Poeng: vinner1 ? 11 : 0,
        lag2Poeng: vinner1 ? 0  : 11,
        ferdig:    true,
        walkover:  true,
        taperId:   vinner1 ? k.lag2Id : k.lag1Id,
      };
    }),
  });
  await updateDoc(doc(db, TS.TURNERINGER, turneringId), { puljer: nyePuljer });
}

// ════════════════════════════════════════════════════════
// SLUTTSPILL
// ════════════════════════════════════════════════════════
export async function startSluttspill(turneringId) {
  const t = await hentTurnering(turneringId);
  if (t.status !== T_STATUS.PLAYOFF_SEEDING && t.status !== T_STATUS.GROUP_PLAY) {
    throw new Error('Turneringen er ikke klar for sluttspill.');
  }

  const kval      = kvalifiserTilSluttspill(t);
  const modus     = t.konfig?.seedingModus ?? SEEDING_MODUS.STANDARD;
  const seededeA  = seedALag(kval.A, t.puljer, modus, kval);
  const erKryss   = modus === SEEDING_MODUS.KRYSS;
  const parOverstyr = erKryss && seededeA.length === 8 ? seededeA : null;

  const aBracket = genererABracket(kval.A, t.konfig, parOverstyr);
  const bBracket = kval.B.length >= 2 ? genererBCBracket(kval.B, 'B', 9,  t.konfig) : [];
  const cBracket = kval.C.length >= 2 ? genererBCBracket(kval.C, 'C', 17, t.konfig) : [];

  const sluttspill = {
    A: { lagIds: kval.A, seeding: erKryss ? parOverstyr : seededeA, kamper: aBracket },
    B: { lagIds: kval.B, kamper: bBracket },
    C: { lagIds: kval.C, kamper: cBracket },
  };

  await updateDoc(doc(db, TS.TURNERINGER, turneringId), {
    sluttspill,
    status:      T_STATUS.PLAYOFFS,
    kvalifisert: { A: kval.A, B: kval.B, C: kval.C },
  });

  visMelding('Sluttspill startet!');
  return sluttspill;
}

export async function registrerSluttspillResultat(turneringId, nivaa, kampId, lag1Poeng, lag2Poeng, games = null) {
  const t = await hentTurnering(turneringId);
  if (t.status !== T_STATUS.PLAYOFFS) throw new Error('Sluttspill er ikke aktivt.');

  const bracket = [...(t.sluttspill[nivaa]?.kamper ?? [])];
  const kampIdx = bracket.findIndex(k => k.id === kampId);
  if (kampIdx < 0) throw new Error('Kamp ikke funnet.');

  const kamp   = bracket[kampIdx];
  const format = hentFormatForRunde(kamp.runde, t.konfig, kamp.format ?? null);

  if (format.type === 'best_of_3' && games?.length) {
    for (let i = 0; i < games.length; i++) {
      const val = validerResultat(games[i].l1, games[i].l2, format);
      if (!val.ok) throw new Error('Game ' + (i + 1) + ': ' + val.feil);
    }
  } else {
    const val = validerResultat(lag1Poeng, lag2Poeng, format);
    if (!val.ok) throw new Error(val.feil);
  }

  const vinnerId = lag1Poeng > lag2Poeng ? kamp.lag1Id : kamp.lag2Id;
  const taperId  = lag1Poeng > lag2Poeng ? kamp.lag2Id : kamp.lag1Id;

  bracket[kampIdx] = { ...kamp, lag1Poeng, lag2Poeng, ferdig: true, vinnerId, taperId, ...(games ? { games } : {}) };

  // Automatisk progresjon — flytt lag til neste kamp
  if (kamp.winner_to) {
    const nIdx = bracket.findIndex(k => k.id === kamp.winner_to);
    if (nIdx >= 0) {
      const neste = bracket[nIdx];
      bracket[nIdx] = {
        ...neste,
        lag1Id: neste.lag1Id === null ? vinnerId : neste.lag1Id,
        lag2Id: neste.lag1Id !== null && neste.lag2Id === null ? vinnerId : neste.lag2Id,
      };
    }
  }

  if (kamp.loser_to) {
    const nIdx = bracket.findIndex(k => k.id === kamp.loser_to);
    if (nIdx >= 0) {
      const neste = bracket[nIdx];
      bracket[nIdx] = {
        ...neste,
        lag1Id: neste.lag1Id === null ? taperId : neste.lag1Id,
        lag2Id: neste.lag1Id !== null && neste.lag2Id === null ? taperId : neste.lag2Id,
      };
    }
  }

  const nyttSluttspill = {
    ...t.sluttspill,
    [nivaa]: { ...t.sluttspill[nivaa], kamper: bracket },
  };

  await updateDoc(doc(db, TS.TURNERINGER, turneringId), { sluttspill: nyttSluttspill });
  return nyttSluttspill;
}

export async function oppdaterKampformat(turneringId, nivaa, kampId, format) {
  const t      = await hentTurnering(turneringId);
  const kamper = [...(t.sluttspill?.[nivaa]?.kamper ?? [])];
  const idx    = kamper.findIndex(k => k.id === kampId);
  if (idx < 0) throw new Error('Kamp ikke funnet.');
  kamper[idx] = { ...kamper[idx], format };
  await updateDoc(doc(db, TS.TURNERINGER, turneringId), {
    [`sluttspill.${nivaa}.kamper`]: kamper,
  });
}

export async function nullstillNedstrømsKamper(turneringId, nivaa, kampId) {
  const t      = await hentTurnering(turneringId);
  const kamper = [...(t.sluttspill?.[nivaa]?.kamper ?? [])];
  const kamp   = kamper.find(k => k.id === kampId);
  if (!kamp) throw new Error('Kamp ikke funnet.');

  const nullstillIds = new Set();
  const samleNedstrøms = (id) => {
    const k = kamper.find(k => k.id === id);
    if (!k) return;
    nullstillIds.add(id);
    if (k.winner_to) samleNedstrøms(k.winner_to);
    if (k.loser_to)  samleNedstrøms(k.loser_to);
  };
  if (kamp.winner_to) samleNedstrøms(kamp.winner_to);
  if (kamp.loser_to)  samleNedstrøms(kamp.loser_to);

  const nyeKamper = kamper.map(k => {
    if (!nullstillIds.has(k.id)) return k;
    const forrigeFerdigKamp = kamper.find(fk =>
      fk.ferdig && fk.id !== kampId &&
      (fk.winner_to === k.id || fk.loser_to === k.id)
    );
    return {
      ...k,
      lag1Id:    forrigeFerdigKamp ? k.lag1Id : null,
      lag2Id:    forrigeFerdigKamp ? k.lag2Id : null,
      lag1Poeng: null,
      lag2Poeng: null,
      ferdig:    false,
      vinnerId:  null,
      taperId:   null,
    };
  });

  const redigertIdx = nyeKamper.findIndex(k => k.id === kampId);
  if (redigertIdx >= 0) {
    nyeKamper[redigertIdx] = {
      ...nyeKamper[redigertIdx],
      lag1Poeng: null, lag2Poeng: null,
      ferdig: false, vinnerId: null, taperId: null,
    };
  }

  await updateDoc(doc(db, TS.TURNERINGER, turneringId), {
    [`sluttspill.${nivaa}.kamper`]: nyeKamper,
  });
}

// ════════════════════════════════════════════════════════
// KONFIG
// ════════════════════════════════════════════════════════
export async function oppdaterTurneringKonfig(turneringId, oppdatering) {
  const t = await hentTurnering(turneringId);
  if (t.status !== T_STATUS.SETUP) throw new Error('Kan kun endre konfig i oppsettfasen.');
  const { navn, antallBaner, ...konfig } = oppdatering;
  const felt = { konfig: { ...t.konfig, ...konfig } };
  if (navn)        felt.navn        = navn;
  if (antallBaner) { felt.antallBaner = antallBaner; felt.konfig.antallBaner = antallBaner; }
  await updateDoc(doc(db, TS.TURNERINGER, turneringId), felt);
}

// ════════════════════════════════════════════════════════
// AVSLUTT / SLETT
// ════════════════════════════════════════════════════════
export async function avsluttTurnering(turneringId) {
  const t = await hentTurnering(turneringId);

  const rangering    = beregnEndeligRangering(t);

  const rangeringRen = rangering
    .map(r => ({ plass: r.plass, lagId: r.lag?.id ?? r.lag?.lagId ?? null, navn: r.lag?.navn ?? '?' }))
    .filter(r => r.lagId);

  await updateDoc(doc(db, TS.TURNERINGER, turneringId), {
    status:    T_STATUS.FINISHED,
    avsluttet: serverTimestamp(),
    rangering: rangeringRen,
  });
  visMelding('Turnering avsluttet!');
  return rangeringRen;
}

export async function slettTurnering(turneringId) {
  await updateDoc(doc(db, TS.TURNERINGER, turneringId), {
    status:  'slettet',
    slettet: serverTimestamp(),
  });
}
