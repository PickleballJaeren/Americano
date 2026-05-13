// ════════════════════════════════════════════════════════
// batch-helpers.js — Delt Firestore batch-hjelper
//
// Firestore tillater maks 500 operasjoner per batch.
// Denne hjelperen holder automatisk styr på antallet
// og splitter i nye batcher når grensen nås.
//
// Bruk:
//   import { lagBatchHjelper } from './batch-helpers.js';
//   const bh = lagBatchHjelper(db);
//   await bh.slett(ref);
//   await bh.oppdater(ref, { felt: verdi });
//   await bh.kommit();   // flush gjenværende operasjoner
// ════════════════════════════════════════════════════════

import { writeBatch } from './firebase.js';

const BATCH_MAKS = 400; // Firestore-grense er 500 — bruker 400 for sikkerhet

/**
 * Lager en selvfylt batch-hjelper.
 * Alle operasjoner legges i gjeldende batch og flushes automatisk
 * når BATCH_MAKS nås. Kall alltid kommit() til slutt for å
 * sende gjenværende operasjoner.
 *
 * @param {Firestore} db — Firestore-instansen
 * @returns {{ slett, oppdater, sett, kommit }}
 */
export function lagBatchHjelper(db) {
  let batch  = writeBatch(db);
  let teller = 0;

  async function _flush() {
    if (teller > 0) {
      await batch.commit();
      batch  = writeBatch(db);
      teller = 0;
    }
  }

  async function _leggTil(operasjon) {
    operasjon(batch);
    teller++;
    if (teller >= BATCH_MAKS) await _flush();
  }

  return {
    /** Sletter ett dokument. */
    async slett(ref) {
      await _leggTil(b => b.delete(ref));
    },

    /** Oppdaterer felt i ett dokument (merge-semantikk). */
    async oppdater(ref, data) {
      await _leggTil(b => b.update(ref, data));
    },

    /** Skriver (overskriver) ett dokument. */
    async sett(ref, data) {
      await _leggTil(b => b.set(ref, data));
    },

    /** Sender alle gjenværende operasjoner. Kall alltid til slutt. */
    async kommit() {
      await _flush();
    },
  };
}
