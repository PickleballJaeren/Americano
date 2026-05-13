// ════════════════════════════════════════════════════════
// ledertavle.js — Global ledertavle, sesongkåring,
//                 spillersammenligning og rating-redigering
// ════════════════════════════════════════════════════════
import {
  db, SAM, STARTRATING,
  collection, doc, getDocs, updateDoc,
  query, where, writeBatch,
} from './firebase.js';
import { app } from './state.js';
import {
  getNivaaKlasse, getNivaaRatingHTML,
  eloForventet,
} from './rating.js';
import { visMelding, visFBFeil, escHtml } from './ui.js';
import { lagInitialer } from './render-helpers.js';

// ── Avhengigheter injisert fra app.js ────────────────────
let _krevAdmin = () => {};

export function ledertavleInit(deps) {
  _krevAdmin = deps.krevAdmin;
}

// ════════════════════════════════════════════════════════
// GLOBAL LEDERTAVLE
// ════════════════════════════════════════════════════════
export function oppdaterGlobalLedertavle() {
  const laster = document.getElementById('global-laster');
  const liste  = document.getElementById('global-ledertavle');
  if (laster) laster.style.display = 'none';
  if (liste)  liste.innerHTML = '';
  try {
    const spillere = [...(app.spillere ?? [])].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    if (!spillere.length) {
      if (liste) liste.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted2);font-size:16px">Ingen spillere registrert ennå</div>';
      return;
    }
    if (liste) {
      liste.innerHTML = spillere.map((s, i) => {
        const plass = i + 1;
        const ini   = lagInitialer(s.navn);
        const nivaaKlLB = getNivaaKlasse(s.rating ?? STARTRATING);
        return `<div class="lb-rad ${nivaaKlLB}" style="cursor:pointer">
          <div class="lb-plass${plass <= 3 ? ' topp3' : ''}" onclick="apneGlobalProfil('${s.id}')">${plass}</div>
          <div class="lb-avatar" onclick="apneGlobalProfil('${s.id}')">${ini}</div>
          <div class="lb-navn" onclick="apneGlobalProfil('${s.id}')">${s.navn ?? 'Ukjent'}</div>
          <div style="text-align:right;flex-shrink:0;display:flex;align-items:center;gap:8px">
            ${getNivaaRatingHTML(s.rating ?? STARTRATING)}
            <button class="knapp-rediger-rating" onclick="startRedigerRating('${s.id}', ${s.rating ?? STARTRATING}, this)" title="Rediger rating" style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;color:var(--muted2);font-size:13px;cursor:pointer">✏️</button>
          </div>
        </div>`;
      }).join('');
    }

    // Fyll sammenlign-dropdowns
    const optioner = spillere.map(s =>
      `<option value="${s.id}">${escHtml(s.navn ?? 'Ukjent')} (${s.rating ?? STARTRATING})</option>`
    ).join('');
    ['sammenlign-s1','sammenlign-s2'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.innerHTML = '<option value="">— Velg spiller —</option>' + optioner;
      }
    });
    nullstillSammenligning();

    // Beregn sesongkåring asynkront
    beregnSesongsKaaring(spillere);

  } catch (e) {
    visFBFeil('Kunne ikke vise ledertavle: ' + (e?.message ?? e));
  }
}
window.oppdaterGlobalLedertavle = oppdaterGlobalLedertavle;

// ════════════════════════════════════════════════════════
// SESONGKÅRING — Formspilleren og Beste partner
// ════════════════════════════════════════════════════════
const SESONG_MIN_KAMPER = 10;

let _sesongCache = null;
const SESONG_TTL_MS = 2 * 60 * 1000;

async function beregnSesongsKaaring(spillereListe) {
  const sesongLaster = document.getElementById('sesong-laster');
  const sesongBoks   = document.getElementById('sesong-kaaring');

  if (_sesongCache && (Date.now() - _sesongCache.hentetMs) < SESONG_TTL_MS) {
    if (sesongBoks) { sesongBoks.innerHTML = _sesongCache.html; sesongBoks.style.display = 'block'; }
    if (sesongLaster) sesongLaster.style.display = 'none';
    return;
  }

  if (sesongLaster) sesongLaster.style.display = 'flex';
  if (sesongBoks)   sesongBoks.style.display   = 'none';

  try {
    const ratingMap = {};
    spillereListe.forEach(s => { ratingMap[s.id] = s.rating ?? STARTRATING; });
    const klubbSpillerIds = new Set(Object.keys(ratingMap));

    const snap = await getDocs(query(
      collection(db, SAM.KAMPER),
      where('ferdig', '==', true)
    ));
    const alleKamper = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(k =>
        k.lag1Poeng != null && k.lag2Poeng != null &&
        (klubbSpillerIds.has(k.lag1_s1) || klubbSpillerIds.has(k.lag1_s2) ||
         klubbSpillerIds.has(k.lag2_s1) || klubbSpillerIds.has(k.lag2_s2))
      );

    if (alleKamper.length === 0) {
      if (sesongLaster) sesongLaster.style.display = 'none';
      return;
    }

    const overMap = {};
    const sikkerId = id => id && ratingMap[id] !== undefined;

    for (const k of alleKamper) {
      const erSingel = !k.lag1_s2 && !k.lag2_s2;
      if (!sikkerId(k.lag1_s1) || !sikkerId(k.lag2_s1)) continue;
      if (!erSingel && (!sikkerId(k.lag1_s2) || !sikkerId(k.lag2_s2))) continue;

      const rA = erSingel
        ? ratingMap[k.lag1_s1]
        : (ratingMap[k.lag1_s1] + ratingMap[k.lag1_s2]) / 2;
      const rB = erSingel
        ? ratingMap[k.lag2_s1]
        : (ratingMap[k.lag2_s1] + ratingMap[k.lag2_s2]) / 2;

      const forventetA = eloForventet(rA, rB);
      const forventetB = 1 - forventetA;
      const faktiskA = k.lag1Poeng > k.lag2Poeng ? 1 : k.lag1Poeng < k.lag2Poeng ? 0 : 0.5;
      const faktiskB = 1 - faktiskA;

      const lag1 = [{ id: k.lag1_s1, navn: k.lag1_s1_navn }, erSingel ? null : { id: k.lag1_s2, navn: k.lag1_s2_navn }].filter(Boolean);
      const lag2 = [{ id: k.lag2_s1, navn: k.lag2_s1_navn }, erSingel ? null : { id: k.lag2_s2, navn: k.lag2_s2_navn }].filter(Boolean);

      const registrer = (lagSpillere, faktisk, forventet) => {
        lagSpillere.forEach(sp => {
          if (!sp.id) return;
          if (!overMap[sp.id]) overMap[sp.id] = { navn: sp.navn ?? 'Ukjent', bidragSum: 0, kamper: 0, partnerBidrag: {} };
          overMap[sp.id].bidragSum += (faktisk - forventet);
          overMap[sp.id].kamper++;
          const partner = lagSpillere.find(p => p.id !== sp.id);
          if (partner?.id) {
            if (!overMap[sp.id].partnerBidrag[partner.id]) {
              overMap[sp.id].partnerBidrag[partner.id] = { navn: partner.navn ?? 'Ukjent', bidragSum: 0, kamper: 0 };
            }
            overMap[sp.id].partnerBidrag[partner.id].bidragSum += (faktisk - forventet);
            overMap[sp.id].partnerBidrag[partner.id].kamper++;
          }
        });
      };

      registrer(lag1, faktiskA, forventetA);
      registrer(lag2, faktiskB, forventetB);
    }

    const kandidaterForm = Object.entries(overMap)
      .filter(([, v]) => v.kamper >= SESONG_MIN_KAMPER)
      .map(([id, v]) => ({
        id, navn: v.navn, kamper: v.kamper,
        overperf: v.bidragSum / v.kamper,
        overperfPst: Math.round((v.bidragSum / v.kamper) * 100),
      }))
      .sort((a, b) => b.overperf - a.overperf);

    const kandidaterPartner = Object.entries(overMap)
      .filter(([, v]) => v.kamper >= SESONG_MIN_KAMPER)
      .map(([id, v]) => {
        const partnere = Object.values(v.partnerBidrag).filter(p => p.kamper >= 2);
        if (partnere.length === 0) return null;
        const totalKamper  = partnere.reduce((s, p) => s + p.kamper, 0);
        const vektetBidrag = partnere.reduce((s, p) => s + p.bidragSum, 0);
        const snittOverperf = vektetBidrag / totalKamper;
        return {
          id, navn: v.navn, kamper: v.kamper,
          antallPartnere: partnere.length,
          overperf: snittOverperf,
          overperfPst: Math.round(snittOverperf * 100),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.overperf - a.overperf);

    if (sesongLaster) sesongLaster.style.display = 'none';

    const ingenData = '<div style="padding:10px 0;font-size:15px;color:var(--muted2)">Ikke nok kampdata ennå (min. ' + SESONG_MIN_KAMPER + ' kamper per spiller)</div>';

    const formEl = document.getElementById('sesong-formspiller');
    if (formEl) {
      if (kandidaterForm.length === 0) {
        formEl.innerHTML = ingenData;
      } else {
        formEl.innerHTML = kandidaterForm.slice(0, 3).map((s, i) => {
          const ini    = lagInitialer(s.navn);
          const farge  = s.overperfPst >= 0 ? 'var(--green2)' : 'var(--red2)';
          const tegn   = s.overperfPst >= 0 ? '+' : '';
          const kronet = i === 0;
          return `<div class="lb-rad" onclick="apneGlobalProfil('${s.id}')" style="cursor:pointer;${kronet ? 'background:rgba(234,179,8,0.04)' : ''}">
            <div class="lb-plass${kronet ? ' topp3' : ''}" style="font-size:${kronet ? '24' : '18'}px">${kronet ? '🔥' : i + 1}</div>
            <div class="lb-avatar" style="${kronet ? 'background:var(--yellow);color:#000' : ''}">${ini}</div>
            <div style="flex:1">
              <div style="font-size:${kronet ? '17' : '16'}px;font-weight:${kronet ? '600' : '400'}">${escHtml(s.navn)}</div>
              <div style="font-size:13px;color:var(--muted2);margin-top:2px">${s.kamper} kamper</div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:700;color:${farge}">${tegn}${s.overperfPst}%</div>
              <div style="font-size:12px;color:var(--muted2)">over forventet</div>
            </div>
          </div>`;
        }).join('');
      }
    }

    const partnerEl = document.getElementById('sesong-beste-partner');
    if (partnerEl) {
      if (kandidaterPartner.length === 0) {
        partnerEl.innerHTML = ingenData;
      } else {
        partnerEl.innerHTML = kandidaterPartner.slice(0, 3).map((s, i) => {
          const ini    = lagInitialer(s.navn);
          const farge  = s.overperfPst >= 0 ? 'var(--green2)' : 'var(--red2)';
          const tegn   = s.overperfPst >= 0 ? '+' : '';
          const kronet = i === 0;
          return `<div class="lb-rad" onclick="apneGlobalProfil('${s.id}')" style="cursor:pointer;${kronet ? 'background:rgba(59,130,246,0.05)' : ''}">
            <div class="lb-plass${kronet ? ' topp3' : ''}" style="font-size:${kronet ? '24' : '18'}px">${kronet ? '🤝' : i + 1}</div>
            <div class="lb-avatar" style="${kronet ? 'background:var(--accent2);color:#fff' : ''}">${ini}</div>
            <div style="flex:1">
              <div style="font-size:${kronet ? '17' : '16'}px;font-weight:${kronet ? '600' : '400'}">${escHtml(s.navn)}</div>
              <div style="font-size:13px;color:var(--muted2);margin-top:2px">${s.antallPartnere} partner${s.antallPartnere === 1 ? '' : 'e'} • ${s.kamper} kamper</div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:700;color:${farge}">${tegn}${s.overperfPst}%</div>
              <div style="font-size:12px;color:var(--muted2)">snitt løft</div>
            </div>
          </div>`;
        }).join('');
      }
    }

    if (sesongBoks) {
      sesongBoks.style.display = 'block';
      _sesongCache = { html: sesongBoks.innerHTML, hentetMs: Date.now() };
    }

  } catch (e) {
    console.warn('[Sesongkåring]', e?.message ?? e);
    if (sesongLaster) sesongLaster.style.display = 'none';
  }
}

// ════════════════════════════════════════════════════════
// SPILLERSAMMENLIGNING
// ════════════════════════════════════════════════════════
function beregnKampStatistikkEnkel(spillerId, kamper) {
  if (!kamper?.length) return { winRate: null, avgPoints: null, totalKamper: 0 };
  let seire = 0, totaltPoeng = 0, antallKamper = 0;
  for (const k of kamper) {
    if (!k.ferdig || k.lag1Poeng == null || k.lag2Poeng == null) continue;
    const erLag1 = k.lag1_s1 === spillerId || k.lag1_s2 === spillerId;
    const erLag2 = k.lag2_s1 === spillerId || k.lag2_s2 === spillerId;
    if (!erLag1 && !erLag2) continue;
    const egnePoeng = erLag1 ? k.lag1Poeng : k.lag2Poeng;
    const vant      = erLag1 ? k.lag1Poeng > k.lag2Poeng : k.lag2Poeng > k.lag1Poeng;
    totaltPoeng += egnePoeng;
    antallKamper++;
    if (vant) seire++;
  }
  if (antallKamper === 0) return { winRate: null, avgPoints: null, totalKamper: 0 };
  return {
    winRate:     Math.round((seire / antallKamper) * 100),
    avgPoints:   Math.round((totaltPoeng / antallKamper) * 10) / 10,
    totalKamper: antallKamper,
  };
}

export function nullstillSammenligning() {
  const s1 = document.getElementById('sammenlign-s1')?.value;
  const s2 = document.getElementById('sammenlign-s2')?.value;
  const knapp = document.getElementById('sammenlign-knapp');
  const res   = document.getElementById('sammenlign-resultat');
  if (knapp) knapp.disabled = !(s1 && s2 && s1 !== s2);
  if (res)   { res.style.display = 'none'; res.innerHTML = ''; }
}
window.nullstillSammenligning = nullstillSammenligning;

async function kjorSammenligning() {
  if (!db) return;
  const s1Id = document.getElementById('sammenlign-s1')?.value;
  const s2Id = document.getElementById('sammenlign-s2')?.value;
  if (!s1Id || !s2Id || s1Id === s2Id) return;

  const s1Navn = document.getElementById('sammenlign-s1').selectedOptions[0]?.text.split(' (')[0] ?? 'Spiller 1';
  const s2Navn = document.getElementById('sammenlign-s2').selectedOptions[0]?.text.split(' (')[0] ?? 'Spiller 2';

  const laster   = document.getElementById('sammenlign-laster');
  const resultat = document.getElementById('sammenlign-resultat');
  if (laster)   laster.style.display   = 'flex';
  if (resultat) resultat.style.display = 'none';

  try {
    const [a1, a2, a3, a4] = await Promise.all([
      getDocs(query(collection(db, SAM.KAMPER), where('lag1_s1', '==', s1Id), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag1_s2', '==', s1Id), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag2_s1', '==', s1Id), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag2_s2', '==', s1Id), where('ferdig', '==', true))),
    ]);
    const sett = new Map();
    for (const snap of [a1, a2, a3, a4]) snap.docs.forEach(d => sett.set(d.id, { id: d.id, ...d.data() }));
    const alleKamperS1 = [...sett.values()];

    const fellesKamper = alleKamperS1.filter(k => {
      const ids = [k.lag1_s1, k.lag1_s2, k.lag2_s1, k.lag2_s2];
      return ids.includes(s2Id);
    });

    const stat1 = beregnKampStatistikkEnkel(s1Id, alleKamperS1);

    const [b1, b2, b3, b4] = await Promise.all([
      getDocs(query(collection(db, SAM.KAMPER), where('lag1_s1', '==', s2Id), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag1_s2', '==', s2Id), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag2_s1', '==', s2Id), where('ferdig', '==', true))),
      getDocs(query(collection(db, SAM.KAMPER), where('lag2_s2', '==', s2Id), where('ferdig', '==', true))),
    ]);
    const sett2 = new Map();
    for (const snap of [b1, b2, b3, b4]) snap.docs.forEach(d => sett2.set(d.id, { id: d.id, ...d.data() }));
    const alleKamperS2 = [...sett2.values()];
    const stat2 = beregnKampStatistikkEnkel(s2Id, alleKamperS2);

    let sammenLag = 0, sammenSeire = 0, motHverandre = 0, s1VantMot = 0;
    for (const k of fellesKamper) {
      const s1PaaLag1 = k.lag1_s1 === s1Id || k.lag1_s2 === s1Id;
      const s2PaaLag1 = k.lag1_s1 === s2Id || k.lag1_s2 === s2Id;
      if (s1PaaLag1 === s2PaaLag1) {
        sammenLag++;
        const vant = s1PaaLag1 ? k.lag1Poeng > k.lag2Poeng : k.lag2Poeng > k.lag1Poeng;
        if (vant) sammenSeire++;
      } else {
        motHverandre++;
        const s1Vant = s1PaaLag1 ? k.lag1Poeng > k.lag2Poeng : k.lag2Poeng > k.lag1Poeng;
        if (s1Vant) s1VantMot++;
      }
    }

    if (laster) laster.style.display = 'none';

    const ini1 = lagInitialer(s1Navn);
    const ini2 = lagInitialer(s2Navn);
    const wrFarge = (wr) => wr === null ? 'var(--muted2)' : wr >= 60 ? 'var(--green2)' : wr >= 40 ? 'var(--yellow)' : 'var(--red2)';
    const wrTekst = (wr) => wr === null ? '—' : wr + '%';

    const rader = [
      { lbl: 'Winrate',       v1: wrTekst(stat1.winRate),  v2: wrTekst(stat2.winRate),  farge1: wrFarge(stat1.winRate),  farge2: wrFarge(stat2.winRate) },
      { lbl: 'Snittpoeng',    v1: stat1.avgPoints ?? '—',  v2: stat2.avgPoints ?? '—',  farge1: 'var(--white)',          farge2: 'var(--white)' },
      { lbl: 'Totalt kamper', v1: stat1.totalKamper,        v2: stat2.totalKamper,        farge1: 'var(--white)',          farge2: 'var(--white)' },
    ];

    let html = `
      <div style="display:flex;align-items:center;gap:8px;padding:14px 16px 10px;border-bottom:1px solid var(--border)">
        <div style="flex:1;display:flex;align-items:center;gap:8px">
          <div class="lb-avatar" style="background:var(--accent)">${ini1}</div>
          <div style="font-size:16px;font-weight:600">${escHtml(s1Navn)}</div>
        </div>
        <div style="font-family:'Bebas Neue',cursive;font-size:18px;color:var(--muted)">VS</div>
        <div style="flex:1;display:flex;align-items:center;justify-content:flex-end;gap:8px">
          <div style="font-size:16px;font-weight:600;text-align:right">${escHtml(s2Navn)}</div>
          <div class="lb-avatar" style="background:var(--orange)">${ini2}</div>
        </div>
      </div>
      <div style="padding:0 16px">
        ${rader.map(r => `
          <div style="display:flex;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
            <div style="flex:1;font-family:'DM Mono',monospace;font-size:17px;font-weight:600;color:${r.farge1}">${r.v1}</div>
            <div style="font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--muted2);text-align:center;flex:0 0 90px">${r.lbl}</div>
            <div style="flex:1;font-family:'DM Mono',monospace;font-size:17px;font-weight:600;color:${r.farge2};text-align:right">${r.v2}</div>
          </div>`).join('')}
      </div>`;

    if (fellesKamper.length === 0) {
      html += `<div style="padding:14px 16px;text-align:center;font-size:15px;color:var(--muted2)">Ingen felles kamper registrert ennå.</div>`;
    } else {
      html += `<div style="padding:12px 16px 4px">
        <div style="font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--accent2);font-weight:600;margin-bottom:10px">Direkte oppgjør</div>`;

      if (motHverandre > 0) {
        const s2VantMot = motHverandre - s1VantMot;
        const vinnerId  = s1VantMot > s2VantMot ? s1Navn : s2VantMot > s1VantMot ? s2Navn : null;
        const fargeS1   = s1VantMot > s2VantMot ? 'var(--green2)' : s1VantMot < s2VantMot ? 'var(--red2)' : 'var(--muted2)';
        const fargeS2   = s2VantMot > s1VantMot ? 'var(--green2)' : s2VantMot < s1VantMot ? 'var(--red2)' : 'var(--muted2)';
        html += `
          <div style="display:flex;align-items:center;background:#060e1c;border-radius:12px;padding:12px 14px;margin-bottom:8px">
            <div style="flex:1;font-family:'Bebas Neue',cursive;font-size:32px;color:${fargeS1}">${s1VantMot}</div>
            <div style="font-size:13px;text-align:center;color:var(--muted2);flex:0 0 80px">${motHverandre} kamper<br>mot hverandre</div>
            <div style="flex:1;font-family:'Bebas Neue',cursive;font-size:32px;color:${fargeS2};text-align:right">${s2VantMot}</div>
          </div>
          ${vinnerId ? `<div style="text-align:center;font-size:14px;color:var(--muted2);margin-bottom:8px">🏆 ${escHtml(vinnerId)} leder det direkte oppgjøret</div>` : '<div style="text-align:center;font-size:14px;color:var(--muted2);margin-bottom:8px">Likt i det direkte oppgjøret</div>'}`;
      }

      if (sammenLag > 0) {
        const sammenWR = Math.round((sammenSeire / sammenLag) * 100);
        const wrF = sammenWR >= 60 ? 'var(--green2)' : sammenWR >= 40 ? 'var(--yellow)' : 'var(--red2)';
        html += `
          <div style="display:flex;align-items:center;gap:12px;background:#060e1c;border-radius:12px;padding:12px 14px;margin-bottom:8px">
            <div style="font-size:22px">🤝</div>
            <div style="flex:1">
              <div style="font-size:15px;font-weight:600">Sammen som lag</div>
              <div style="font-size:13px;color:var(--muted2);margin-top:2px">${sammenLag} kamper — ${sammenSeire} seire</div>
            </div>
            <div style="font-family:'DM Mono',monospace;font-size:22px;font-weight:700;color:${wrF}">${sammenWR}%</div>
          </div>`;
      }
      html += '</div>';
    }

    if (resultat) { resultat.innerHTML = html; resultat.style.display = 'block'; }

  } catch (e) {
    console.error('[sammenlign]', e);
    if (laster) laster.style.display = 'none';
    visFBFeil('Feil ved sammenligning: ' + (e?.message ?? e));
  }
}
window.kjorSammenligning = kjorSammenligning;

// ════════════════════════════════════════════════════════
// NULLSTILL RATING (admin)
// ════════════════════════════════════════════════════════
export function visNullstillModal() {
  _krevAdmin(
    'Nullstill rating',
    'Kun administrator kan nullstille all rating og historikk.',
    () => { document.getElementById('modal-nullstill').style.display = 'flex'; }
  );
}
window.visNullstillModal = visNullstillModal;

export async function utforNullstill() {
  if (!db) { visMelding('Firebase ikke tilkoblet.', 'feil'); return; }

  const nullstillSingel = document.getElementById('nullstill-inkluder-singel')?.checked ?? false;

  document.getElementById('modal-nullstill').style.display = 'none';
  visMelding('Nullstiller… vennligst vent.', 'advarsel');

  try {
    const BATCH_MAKS = 400;
    let batch = writeBatch(db);
    let teller = 0;

    // Nullstill dobbel-rating — alltid. Nullstill singelRating om valgt.
    const spillerSnap = await getDocs(collection(db, SAM.SPILLERE));
    for (const d of spillerSnap.docs) {
      const oppdatering = { rating: STARTRATING };
      if (nullstillSingel) oppdatering.singelRating = null;
      batch.update(d.ref, oppdatering);
      teller++;
      if (teller >= BATCH_MAKS) { await batch.commit(); batch = writeBatch(db); teller = 0; }
    }
    if (teller > 0) await batch.commit();

    // Slett dobbel-historikk — alltid
    const histSnap = await getDocs(collection(db, SAM.HISTORIKK));
    batch = writeBatch(db); teller = 0;
    for (const d of histSnap.docs) {
      batch.delete(d.ref);
      teller++;
      if (teller >= BATCH_MAKS) { await batch.commit(); batch = writeBatch(db); teller = 0; }
    }
    if (teller > 0) await batch.commit();

    // Slett resultater — alltid
    const resSnap = await getDocs(collection(db, SAM.RESULTATER));
    batch = writeBatch(db); teller = 0;
    for (const d of resSnap.docs) {
      batch.delete(d.ref);
      teller++;
      if (teller >= BATCH_MAKS) { await batch.commit(); batch = writeBatch(db); teller = 0; }
    }
    if (teller > 0) await batch.commit();

    // Slett singel-historikk om valgt
    if (nullstillSingel) {
      const singelSnap = await getDocs(collection(db, SAM.SINGEL_HISTORIKK));
      batch = writeBatch(db); teller = 0;
      for (const d of singelSnap.docs) {
        batch.delete(d.ref);
        teller++;
        if (teller >= BATCH_MAKS) { await batch.commit(); batch = writeBatch(db); teller = 0; }
      }
      if (teller > 0) await batch.commit();
    }

    app.spillere = app.spillere.map(s => ({
      ...s,
      rating: STARTRATING,
      ...(nullstillSingel ? { singelRating: null } : {}),
    }));
    _sesongCache = null;
    visMelding(nullstillSingel ? 'Dobbel- og singelrating nullstilt!' : 'Dobbel-rating og historikk nullstilt!');
    oppdaterGlobalLedertavle();
  } catch (e) {
    visFBFeil('Feil ved nullstilling: ' + (e?.message ?? e));
  }
}
window.utforNullstill = utforNullstill;

// ════════════════════════════════════════════════════════
// REDIGER RATING (admin)
// ════════════════════════════════════════════════════════
export function startRedigerRating(spillerId, gjeldende, knapp) {
  _krevAdmin('Rediger rating', 'Kun administrator kan endre ratingpoeng.', () => {
    const wrapper = knapp.parentElement;
    const lbRad   = wrapper.parentElement; // <div class="lb-rad">
    knapp.style.display = 'none';

    // Bytt lb-rad til column-layout midlertidig
    lbRad.style.flexDirection = 'column';
    lbRad.style.alignItems    = 'stretch';

    // Redigeringsrad under spillerinfo
    const rad = document.createElement('div');
    rad.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0 4px;width:100%';

    const input = document.createElement('input');
    input.type      = 'text';
    input.inputMode = 'numeric';
    input.pattern   = '[0-9]*';
    input.value     = gjeldende;
    input.maxLength = 5;
    input.style.cssText = 'flex:1;min-width:0;max-width:120px;padding:7px 10px;border-radius:8px;border:1px solid var(--accent2);background:var(--navy3);color:var(--white);font-size:16px;font-family:inherit;text-align:center';
    input.onkeydown = (e) => {
      if (e.key === 'Enter')  lagreNyRating(spillerId, input, knapp, rad, lbRad);
      if (e.key === 'Escape') avbrytRedigerRating(input, knapp, rad, lbRad);
    };

    const lagreBtn = document.createElement('button');
    lagreBtn.textContent = '✓ Lagre';
    lagreBtn.style.cssText = 'background:var(--green2);border:none;border-radius:8px;padding:7px 18px;color:#000;font-size:15px;cursor:pointer;font-weight:700;white-space:nowrap';
    lagreBtn.onclick = () => lagreNyRating(spillerId, input, knapp, rad, lbRad);

    const avbrytBtn = document.createElement('button');
    avbrytBtn.textContent = '✕';
    avbrytBtn.style.cssText = 'background:none;border:1px solid var(--border);border-radius:8px;padding:7px 14px;color:var(--muted2);font-size:15px;cursor:pointer;white-space:nowrap';
    avbrytBtn.onclick = () => avbrytRedigerRating(input, knapp, rad, lbRad);

    rad.appendChild(input);
    rad.appendChild(lagreBtn);
    rad.appendChild(avbrytBtn);
    lbRad.appendChild(rad);
    input.focus();
    input.select();
  });
}
window.startRedigerRating = startRedigerRating;

function avbrytRedigerRating(input, knapp, rad, lbRad) {
  rad?.remove();
  input?.remove();
  if (lbRad) { lbRad.style.flexDirection = ''; lbRad.style.alignItems = ''; }
  knapp.style.display = '';
}

async function lagreNyRating(spillerId, input, knapp, rad, lbRad) {
  const nyRating = parseInt(input.value, 10);
  if (isNaN(nyRating) || nyRating < 1 || nyRating > 9999) {
    visMelding('Ugyldig rating — skriv inn et tall mellom 1 og 9999.', 'advarsel');
    input.focus();
    return;
  }
  try {
    await updateDoc(doc(db, SAM.SPILLERE, spillerId), { rating: nyRating });
    const spiller = (app.spillere ?? []).find(s => s.id === spillerId);
    if (spiller) spiller.rating = nyRating;
    rad?.remove();
    if (lbRad) { lbRad.style.flexDirection = ''; lbRad.style.alignItems = ''; }
    knapp.style.display = '';
    visMelding('Rating oppdatert ✓');
    oppdaterGlobalLedertavle();
  } catch (e) {
    visFBFeil('Kunne ikke lagre rating: ' + (e?.message ?? e));
    avbrytRedigerRating(input, knapp, rad, lbRad);
  }
}

// Nullstill sesong-cache — kalles fra utforNullstill internt
export function nullstillSesongCache() {
  _sesongCache = null;
}
