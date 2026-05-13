// ════════════════════════════════════════════════════════
// lyttere.js — alle onSnapshot-abonnementer
// ════════════════════════════════════════════════════════
import {
  db, SAM,
  collection, doc,
  query, where, orderBy, onSnapshot,
} from './firebase.js';
import { app } from './state.js';
import { visFBFeil } from './ui.js';

// ── Interne referanser til avmeldingsfunksjoner ──────────
let spillerLytterAvmeld = null;
let kampLytterAvmeld    = null;

// ════════════════════════════════════════════════════════
// SPILLER-LYTTER
// Kalles fra app.js etter klubbvalg.
// callbacks: { onSpillere(spillere) }
// ════════════════════════════════════════════════════════
export function lyttPaaSpillere(aktivKlubbId, callbacks = {}) {
  if (!db) return;
  if (!aktivKlubbId) {
    app.spillere = [];
    callbacks.onSpillere?.([]);
    return;
  }
  if (spillerLytterAvmeld) { try { spillerLytterAvmeld(); } catch (_) {} }
  document.getElementById('spiller-laster').style.display = 'flex';

  spillerLytterAvmeld = onSnapshot(
    query(collection(db, SAM.SPILLERE), where('klubbId', '==', aktivKlubbId), orderBy('rating', 'desc')),
    (snap) => {
      document.getElementById('spiller-laster').style.display = 'none';
      app.spillere = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callbacks.onSpillere?.(app.spillere);
    },
    (feil) => {
      document.getElementById('spiller-laster').style.display = 'none';
      visFBFeil('Feil ved lasting av spillere: ' + (feil?.message ?? feil));
    }
  );

  return spillerLytterAvmeld;
}

// ════════════════════════════════════════════════════════
// KAMP-LYTTER
// Separat slik at den kan restartes ved ny runde.
// callbacks: { onKamper(kamper), onKampStatusReset() }
// ════════════════════════════════════════════════════════
export function startKampLytter(callbacks = {}) {
  if (!db || !app.treningId) return;
  if (kampLytterAvmeld) { try { kampLytterAvmeld(); } catch (_) {} kampLytterAvmeld = null; }

  callbacks.onKampStatusReset?.();

  kampLytterAvmeld = onSnapshot(
    query(
      collection(db, SAM.KAMPER),
      where('treningId', '==', app.treningId),
      where('rundeNr',   '==', app.runde),
    ),
    snap => {
      callbacks.onKamper?.(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    },
    feil => visFBFeil('Lyttefeil (kamper): ' + (feil?.message ?? feil))
  );

  return kampLytterAvmeld;
}

// ════════════════════════════════════════════════════════
// ØKT-LYTTER + KAMP-LYTTER
// callbacks: {
//   onOktOppdatert(data),
//   onNyRunde(),
//   onOktAvsluttet(),
//   onKamper(kamper),
//   onKampStatusReset(),
// }
// ════════════════════════════════════════════════════════
export function startLyttere(callbacks = {}) {
  if (!db || !app.treningId) return;

  // Nullstill lokal skjerm-tilstand ved oppstart
  app._adminSkjerm = 'baner';

  const l1 = onSnapshot(
    doc(db, SAM.TRENINGER, app.treningId),
    snap => {
      if (!snap.exists()) {
        // Treningsdokumentet er slettet (avbryt økt) — naviger alle enheter bort til hjem
        callbacks.onOktAvbrutt?.();
        return;
      }
      const data = snap.data() ?? {};

      // Les forrige runde FRA FIRESTORE — ikke fra app.runde som kan være utdatert
      const forrigeRunde   = app._forrigeFirestoreRunde ?? data.gjeldendRunde ?? 1;
      const nyRunde        = data.gjeldendRunde ?? forrigeRunde;


      app._forrigeFirestoreRunde = nyRunde;

      app.runde        = nyRunde;
      app.baneOversikt = data.baneOversikt  ?? [];
      app.venteliste   = data.venteliste    ?? [];

      callbacks.onOktOppdatert?.(data);

      // Økt avsluttet av admin — naviger alle til sluttresultat
      if (data.status === 'avsluttet') {
        if (app.treningId) sessionStorage.setItem('aktivTreningId', app.treningId);
        stoppLyttere();
        callbacks.onOktAvsluttet?.();
        return;
      }

      // Ny runde startet av admin — restart kamp-lytter og naviger til baneoversikten.
      // Kall også onAdminSkjermEndret('baner') eksplisitt slik at tilskuere som sitter
      // på resultatskjermen navigeres tilbake til baneoversikten.
      if (nyRunde > forrigeRunde && forrigeRunde !== 0) {
        app._adminSkjerm = 'baner';  // nullstill slik at neste resultatvisning trigges
        startKampLytter(callbacks);
        callbacks.onNyRunde?.();
        callbacks.onAdminSkjermEndret?.('baner');
        return;
      }

      // Synkroniser deltakere til admin sin skjerm via adminSkjerm-feltet.
      // Tilstandsfelt — alltid konsistent, ingen race condition.
      const adminSkjerm   = data.adminSkjerm ?? 'baner';
      const forrigeSkjerm = app._adminSkjerm ?? 'baner';
      app._adminSkjerm    = adminSkjerm;

      if (adminSkjerm !== forrigeSkjerm) {
        callbacks.onAdminSkjermEndret?.(adminSkjerm);
      }
    },
    feil => visFBFeil('Lyttefeil (økt): ' + (feil?.message ?? feil))
  );

  app.lyttere.push(l1);
  startKampLytter(callbacks);  // start kamp-lytter for gjeldende runde
}

// ════════════════════════════════════════════════════════
// ØKT-OPPSTARTSLYTTER
// Lytter på aktive treninger for klubben mens tilskuer
// er i appen uten aktiv økt. Når admin oppretter en økt,
// kalles onNyOktFunnet(treningId) automatisk.
// Stoppes så snart en økt er funnet (eller ved klubbbytte).
// ════════════════════════════════════════════════════════
let oktOppstartsLytterAvmeld = null;

export function startOktOppstartsLytter(aktivKlubbId, callbacks = {}) {
  if (!db || !aktivKlubbId) return;
  stoppOktOppstartsLytter();

  oktOppstartsLytterAvmeld = onSnapshot(
    query(
      collection(db, 'treninger'),
      where('status', '==', 'aktiv'),
      where('klubbId', '==', aktivKlubbId)
    ),
    (snap) => {
      if (snap.empty) return;
      const treningDoc = snap.docs[0];
      // Stopp lytteren — vi har funnet en økt, gjenoppretting tar over
      stoppOktOppstartsLytter();
      callbacks.onNyOktFunnet?.(treningDoc.id);
    },
    (feil) => {
      console.warn('[OktOppstartsLytter]', feil?.message ?? feil);
    }
  );
}

export function stoppOktOppstartsLytter() {
  if (oktOppstartsLytterAvmeld) {
    try { oktOppstartsLytterAvmeld(); } catch (_) {}
    oktOppstartsLytterAvmeld = null;
  }
}

export function stoppLyttere() {
  app.lyttere.forEach(l => { try { l(); } catch (_) {} });
  app.lyttere = [];
  if (kampLytterAvmeld)   { try { kampLytterAvmeld(); }   catch (_) {} kampLytterAvmeld = null; }
  if (spillerLytterAvmeld) { try { spillerLytterAvmeld(); } catch (_) {} spillerLytterAvmeld = null; }
}
