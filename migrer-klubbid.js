// ════════════════════════════════════════════════════════
// migrer-klubbid.js — ENGANGS-MIGRERING
//
// Bakgrunn: kamper/ratingHistorikk/resultater-dokumenter har historisk
// IKKE hatt et klubbId-felt. Etter fiksen i trening.js/baner.js skrives
// klubbId på alle NYE dokumenter, men gamle dokumenter mangler feltet
// fortsatt. De nye, klubb-filtrerte spørringene i hall-of-fame.js og
// ledertavle.js vil derfor ikke finne dem før dette scriptet er kjørt.
//
// Kjør ÉN gang (via migrer-klubbid.html), etter at koden med
// klubbId-fiksen er deployet. Trygt å kjøre flere ganger — dokumenter
// som allerede har klubbId hoppes over.
//
// Hva den gjør:
//   1. Leser alle treninger → bygger treningId → klubbId-oppslag
//      (treninger har alltid hatt klubbId).
//   2. For KAMPER, HISTORIKK og RESULTATER: leser alle dokumenter,
//      finner de som mangler klubbId men har en treningId vi kjenner
//      klubben til, og batch-oppdaterer dem.
// ════════════════════════════════════════════════════════

import { db, SAM, collection, getDocs, writeBatch } from './firebase.js';
import { lagBatchHjelper } from './batch-helpers.js';

function logg(tekst) {
  console.log(tekst);
  const el = document.getElementById('migrer-logg');
  if (el) el.textContent += tekst + '\n';
}

export async function kjørMigrering() {
  if (!db) { logg('❌ Ingen Firestore-tilkobling.'); return; }

  logg('── Steg 1: Leser treninger for å bygge treningId → klubbId-oppslag ──');
  const treningSnap = await getDocs(collection(db, SAM.TRENINGER));
  const treningTilKlubb = {};
  treningSnap.docs.forEach(d => {
    const klubbId = d.data().klubbId;
    if (klubbId) treningTilKlubb[d.id] = klubbId;
  });
  logg(`Fant ${treningSnap.size} treninger, ${Object.keys(treningTilKlubb).length} med klubbId.`);

  const samlinger = [
    { navn: 'kamper',    sam: SAM.KAMPER },
    { navn: 'historikk', sam: SAM.HISTORIKK },
    { navn: 'resultater', sam: SAM.RESULTATER },
  ];

  for (const { navn, sam } of samlinger) {
    logg(`\n── Steg 2: Migrerer ${navn} ──`);
    const snap = await getDocs(collection(db, sam));
    logg(`Leste ${snap.size} dokumenter fra ${navn}.`);

    const bh = lagBatchHjelper(db);
    let oppdatert = 0, hoppetOver = 0, ukjent = 0;

    for (const d of snap.docs) {
      const data = d.data();
      if (data.klubbId) { hoppetOver++; continue; }
      const klubbId = treningTilKlubb[data.treningId];
      if (!klubbId) { ukjent++; continue; }
      await bh.oppdater(d.ref, { klubbId });
      oppdatert++;
    }
    await bh.kommit();

    logg(`✓ ${navn}: ${oppdatert} oppdatert, ${hoppetOver} hadde allerede klubbId, ${ukjent} kunne ikke kobles til en klubb (ukjent/slettet treningId).`);
  }

  logg('\n── Ferdig ──');
  logg('Du kan nå deploye de klubbfiltrerte spørringene (allerede gjort i denne fiksen) og fjerne migrer-klubbid.html/.js fra prosjektet.');
}
window.kjørMigrering = kjørMigrering;
