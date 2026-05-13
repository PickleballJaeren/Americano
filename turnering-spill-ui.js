// ════════════════════════════════════════════════════════
// turnering-spill-ui.js — Live-turneringsvisning
// Puljeskjerm, bracket, resultat-modal og sluttresultat.
// Ingen oppsett-logikk — det bor i turnering-ui.js.
//
// Avhengigheter fra turnering-ui.js løses via eksporterte
// hjelpefunksjoner: getAktivTurneringId(), navigerTurnering()
// og krevAdminTurnering().
// ════════════════════════════════════════════════════════

import { escHtml, visMelding } from './ui.js';
import { app } from './state.js';
import {
  T_STATUS,
  STANDARD_KAMPFORMAT,
  hentFormatForRunde,
  hentTurnering,
  registrerPuljeresultat,
  registrerWalkover,
  flyttLag,
  beregnPuljetabell,
  kvalifiserTilSluttspill,
  startSluttspill,
  registrerSluttspillResultat,
  oppdaterKampformat,
  nullstillNedstrømsKamper,
  beregnEndeligRangering,
  beregnFremgang,
  avsluttTurnering,
  validerResultat,
  beregnBestOf3,
} from './turnering.js';
import {
  getAktivTurneringId,
  navigerTurnering,
  krevAdminTurnering,
} from './turnering-ui.js';

// ════════════════════════════════════════════════════════
// PULJESKJERM — tabeller og kampregistrering
// ════════════════════════════════════════════════════════
export async function visPulje(turnering) {
  const t = turnering ?? await hentTurnering(getAktivTurneringId());
  app.aktivTurnering = t;

  document.getElementById('pulje-turnering-navn').textContent = t.navn;

  const fremgang = beregnFremgang(t.puljer);
  const fp = document.getElementById('pulje-fremgang');
  if (fp) {
    fp.innerHTML = `
      <div class="fremgang-bar-wrap">
        <div class="fremgang-bar-spor">
          <div class="fremgang-bar-fyll" style="width:${fremgang.prosent}%"></div>
        </div>
        <div class="fremgang-bar-tekst">${fremgang.ferdig}/${fremgang.totalt} kamper</div>
      </div>`;
  }

  const lagMap = Object.fromEntries(t.lag.map(l => [l.id, l]));
  const innhold = document.getElementById('pulje-innhold');
  if (!innhold) return;

  innhold.innerHTML = (t.puljer ?? []).map(p => {
    const tabell = beregnPuljetabell(p, t.lag);
    const format = t.konfig?.kampformatPulje ?? STANDARD_KAMPFORMAT;
    return `
      <div class="seksjon-etikett">${escHtml(p.navn)}</div>
      <div class="kort"><div class="kort-innhold" style="padding:0">
        ${lagTabellHTML(tabell, lagMap, p.id)}
      </div></div>
      <div class="seksjon-etikett" style="margin-top:10px">Kamper — ${escHtml(p.navn)}</div>
      <div class="kort"><div class="kort-innhold" style="padding:0">
        ${_grupperKamperPerRunde(p.kamper ?? []).map(runde =>
          runde.kamper.map(k => kampRadHTML(k, p.id, lagMap, format)).join('')
        ).join('')}
      </div></div>`;
  }).join('');

  // Kvalifisering-boks
  const kvalBoks = document.getElementById('kvalifisering-boks');
  const tilKnapp = document.getElementById('til-sluttspill-knapp');

  const alleFerdig = (t.puljer ?? []).length > 0 &&
    (t.puljer ?? []).every(p => (p.kamper ?? []).every(k => k.ferdig));

  if (alleFerdig && t.status !== T_STATUS.PLAYOFFS && t.status !== T_STATUS.FINISHED) {
    if (kvalBoks) { kvalBoks.style.display = 'block'; visKvalifisering(t, lagMap); }
    if (tilKnapp) tilKnapp.style.display = 'block';
  } else {
    if (kvalBoks) kvalBoks.style.display = 'none';
    if (tilKnapp) tilKnapp.style.display = 'none';
  }
}

function _grupperKamperPerRunde(kamper) {
  const rundeMap = {};
  for (const k of kamper) {
    if (!rundeMap[k.runde]) rundeMap[k.runde] = { runde: k.runde, kamper: [] };
    rundeMap[k.runde].kamper.push(k);
  }
  return Object.values(rundeMap).sort((a, b) => a.runde - b.runde);
}

function lagTabellHTML(tabell, lagMap, puljeId = null) {
  if (!tabell?.length) return '<div class="tom-tilstand-liten">Ingen lag i puljen.</div>';

  const harInnbyrdes = tabell.some(r => r.tiebreakType === 'innbyrdes');
  const harPoengdiff = tabell.some(r => r.tiebreakType === 'poengdiff');

  const kanterCSS = `
    .tb-kant-inn  { border-left: 3px solid var(--accent2); padding-left: 5px; }
    .tb-kant-pd   { border-left: 3px solid var(--yellow);  padding-left: 5px; }
    .tb-kant-ingen{ padding-left: 8px; }
    .tb-fotnote   { font-size:12px; color:var(--muted2); padding:8px 12px 10px; display:flex; gap:14px; flex-wrap:wrap; }
    .tb-dot       { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; vertical-align:middle; }
  `;

  let fotnote = '';
  if (harInnbyrdes || harPoengdiff) {
    fotnote = `<div class="tb-fotnote">`;
    if (harInnbyrdes) fotnote += `<span><span class="tb-dot" style="background:var(--accent2)"></span>Skilt via innbyrdes oppgjør</span>`;
    if (harPoengdiff) fotnote += `<span><span class="tb-dot" style="background:var(--yellow)"></span>Skilt via poengdiff (sirkeloppgjør)</span>`;
    fotnote += `</div>`;
  }

  return `
    <style>${kanterCSS}</style>
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      <thead><tr>
        <th class="th-venstre">#</th>
        <th class="th-venstre">Lag</th>
        <th class="th-center">K</th>
        <th class="th-center">S</th>
        <th class="th-center">T</th>
        <th class="th-center">+/-</th>
        ${puljeId ? '<th></th>' : ''}
      </tr></thead>
      <tbody>
        ${tabell.map((r, i) => {
          const kantKl = r.tiebreakType === 'innbyrdes' ? 'tb-kant-inn'
                       : r.tiebreakType === 'poengdiff'  ? 'tb-kant-pd'
                       : 'tb-kant-ingen';
          return `
          <tr class="td-rad-skille">
            <td class="td-center pulje-td-plass annen"><div class="${kantKl}">${i + 1}</div></td>
            <td class="td-venstre" style="font-weight:${i < 2 ? 600 : 400}">${escHtml(lagMap[r.lagId]?.navn ?? r.lagId)}</td>
            <td class="td-center">${r.kamper}</td>
            <td class="pulje-td-seire td-center">${r.seire}</td>
            <td class="td-center" style="color:var(--red2)">${r.tap}</td>
            <td class="td-center" style="color:${r.pd >= 0 ? 'var(--green2)' : 'var(--red2)'}">${r.pd > 0 ? '+' : ''}${r.pd}</td>
            <td class="td-center"><button class="t-rediger-knapp" title="Flytt lag til annen pulje" onclick="apneFlyttLagModal('${escHtml(r.lagId)}','${escHtml(puljeId)}')">↕</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    ${fotnote}`;
}

function kampRadHTML(kamp, puljeId, lagMap, format) {
  const l1 = lagMap[kamp.lag1Id]?.navn ?? '?';
  const l2 = lagMap[kamp.lag2Id]?.navn ?? '?';
  const l1Vant = kamp.ferdig && kamp.lag1Poeng > kamp.lag2Poeng;
  const l2Vant = kamp.ferdig && kamp.lag2Poeng > kamp.lag1Poeng;
  const typeLabel = format.type === 'best_of_3' ? 'B3' : '1G';
  const poeng = format.points_to_win;
  const erOverstyrt = kamp.format != null;
  const erB3 = format.type === 'best_of_3';

  // Game-detaljer for best-av-3 — vises under kampresultatet
  const gameDetaljer = erB3 && kamp.ferdig && kamp.games?.length
    ? `<div style="font-size:12px;color:var(--muted2);margin-top:3px;letter-spacing:.3px">
        ${kamp.games.map((g, i) => {
          const g1Vant = g.l1 > g.l2;
          return `<span style="color:${g1Vant ? 'var(--green2)' : 'var(--muted2)'}">
            ${g.l1}</span><span style="color:var(--muted)">–</span><span style="color:${!g1Vant ? 'var(--green2)' : 'var(--muted2)'}">
            ${g.l2}</span>${i < kamp.games.length - 1 ? '<span style="color:var(--border2)"> · </span>' : ''}`;
        }).join('')}
       </div>`
    : '';

  return `
    <div class="kamp-rad" style="opacity:${kamp.walkover ? 0.6 : 1}">
      <div class="lb-navn" style="min-width:0">
        <div class="kamp-lag-${l1Vant ? 'vinner' : 'taper'}" style="font-size:16px">${escHtml(l1)}</div>
        <div class="kamp-lag-${l2Vant ? 'vinner' : 'taper'}" style="font-size:16px">${escHtml(l2)}</div>
        <div style="font-size:12px;color:var(--muted2);margin-top:4px">
          ${typeLabel} · ${poeng} pts${erOverstyrt ? ' ✎' : ''}
          ${kamp.walkover ? ' · walkover' : ''}
        </div>
        ${gameDetaljer}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
        ${kamp.ferdig
          ? `<div class="poeng-kolonne" style="margin-bottom:4px"><span>${kamp.lag1Poeng}</span><span>${kamp.lag2Poeng}</span></div>`
          : ''
        }
        <button class="t-rediger-knapp" title="${kamp.ferdig ? 'Rediger score' : 'Registrer score'}"
          onclick="apneResultatModal('${escHtml(puljeId)}','${escHtml(kamp.id)}','${escHtml(kamp.lag1Id)}','${escHtml(kamp.lag2Id)}')">✏️</button>
        ${!kamp.ferdig ? `<button class="knapp knapp-omriss knapp-liten" onclick="apneResultatModal('${escHtml(puljeId)}','${escHtml(kamp.id)}','${escHtml(kamp.lag1Id)}','${escHtml(kamp.lag2Id)}')">Registrer</button>` : ''}
      </div>
    </div>`;
}

function visKvalifisering(t, lagMap) {
  const boks = document.getElementById('kvalifisering-boks');
  if (!boks) return;
  try {
    const kval = kvalifiserTilSluttspill(t);
    const render = (ids, tittel, farge) => {
      if (!ids?.length) return '';
      return `<div class="kvalifisert-gruppe">
        <div class="kvalifisert-tittel" style="color:${farge}">${tittel}</div>
        ${ids.map((id, i) => `
          <div class="kvalifisert-rad">
            <span class="kvalifisert-nr">${i + 1}.</span>
            <span class="kvalifisert-navn">${escHtml(lagMap[id]?.navn ?? id)}</span>
          </div>`).join('')}
      </div>`;
    };
    boks.innerHTML = `
      <div class="seksjon-etikett">Kvalifisering til sluttspill</div>
      <div class="kort"><div class="kort-innhold">
        ${render(kval.A, '🥇 A-sluttspill (plass 1–8)', 'var(--yellow)')}
        ${render(kval.B, '🥈 B-sluttspill (plass 9–16)', 'var(--accent2)')}
        ${render(kval.C, '🥉 C-sluttspill (plass 17+)', 'var(--muted2)')}
      </div></div>`;
  } catch (e) {
    boks.innerHTML = `<div class="tom-tilstand-liten" style="color:var(--red2)">${escHtml(e.message)}</div>`;
  }
}

// ════════════════════════════════════════════════════════
// RESULTAT-MODAL — registrer kampresultat
// Støtter både single game og best av 3.
// ════════════════════════════════════════════════════════

// ── Modal-state ──────────────────────────────────────────
let _modalPuljeId  = null;
let _modalKampId   = null;
let _modalLag1Id   = null;
let _modalLag2Id   = null;
let _modalNivaa    = null;   // null = pulje | 'A' | 'B' | 'C'
let _modalFormat   = null;

// ── Best av 3 state ──────────────────────────────────────
let _games         = [null, null, null]; // [{l1, l2}, ...]
let _aktivGame     = 0;                  // 0-indeksert
let _tAktivLag     = 1;
let _tMaxPoeng     = 15;

// ════════════════════════════════════════════════════════
// ÅPNE / LUKK
// ════════════════════════════════════════════════════════
window.apneResultatModal = function(puljeEllerNivaa, kampId, lag1Id, lag2Id, erSluttspill = false) {
  _modalPuljeId = erSluttspill ? null : puljeEllerNivaa;
  _modalNivaa   = erSluttspill ? puljeEllerNivaa : null;
  _modalKampId  = kampId;
  _modalLag1Id  = lag1Id;
  _modalLag2Id  = lag2Id;

  const t      = app.aktivTurnering;
  const lagMap = Object.fromEntries((t?.lag ?? []).map(l => [l.id, l]));

  if (erSluttspill) {
    const kamp  = t?.sluttspill?.[puljeEllerNivaa]?.kamper?.find(k => k.id === kampId);
    _modalFormat = hentFormatForRunde(kamp?.runde ?? '', t?.konfig ?? {}, kamp?.format ?? null);
  } else {
    _modalFormat = t?.konfig?.kampformatPulje ?? STANDARD_KAMPFORMAT;
  }

  _tMaxPoeng = _modalFormat.max_points ?? 15;

  // Hent eksisterende score for forhåndsutfylling
  let eksisterendeL1 = null, eksisterendeL2 = null;
  if (erSluttspill) {
    const kamp = t?.sluttspill?.[puljeEllerNivaa]?.kamper?.find(k => k.id === kampId);
    if (kamp?.ferdig) { eksisterendeL1 = kamp.lag1Poeng; eksisterendeL2 = kamp.lag2Poeng; }
  } else {
    const pulje = t?.puljer?.find(p => p.id === puljeEllerNivaa);
    const kamp  = pulje?.kamper?.find(k => k.id === kampId);
    if (kamp?.ferdig) { eksisterendeL1 = kamp.lag1Poeng; eksisterendeL2 = kamp.lag2Poeng; }
  }

  // Nullstill game-state
  _games     = [null, null, null];
  _aktivGame = 0;
  _tAktivLag = 1;

  // Sett lagnavn og format-tekst
  document.getElementById('modal-resultat-lag1').textContent = lagMap[lag1Id]?.navn ?? 'Lag 1';
  document.getElementById('modal-resultat-lag2').textContent = lagMap[lag2Id]?.navn ?? 'Lag 2';
  document.getElementById('modal-resultat-format').textContent =
    `${_modalFormat.type === 'best_of_3' ? 'Best av 3 · ' : ''}Til ${_modalFormat.points_to_win} · maks ${_modalFormat.max_points}`;
  document.getElementById('modal-resultat-feil').textContent = '';

  // Fyll inn poeng-boksene (eksisterende eller blank)
  const startVerdier = { l1: eksisterendeL1, l2: eksisterendeL2 };
  ['l1', 'l2'].forEach(felt => {
    const boks = document.getElementById(`t-pvb-${felt}`);
    const val  = startVerdier[felt];
    if (boks) {
      boks.textContent = val != null ? String(val) : '—';
      boks.classList.remove('aktiv');
      boks.dataset.verdi = val != null ? String(val) : '';
    }
    const picker = document.getElementById(`t-pp-${felt}`);
    if (picker) { picker.style.display = 'none'; }
  });
  // Forhåndsutfyll _games for single game
  if (eksisterendeL1 != null && eksisterendeL2 != null && _modalFormat?.type !== 'best_of_3') {
    _games[0] = { l1: eksisterendeL1, l2: eksisterendeL2 };
  }

  document.getElementById('modal-resultat').style.display = 'flex';
  _tOppdaterModalUI();
};

window.lukkResultatModal = function() {
  _tLukkAllePickere();
  document.getElementById('modal-resultat').style.display = 'none';
};

// ════════════════════════════════════════════════════════
// UI-OPPDATERING
// ════════════════════════════════════════════════════════

/** Oppdaterer hele modalen basert på gjeldende game-state. */
function _tOppdaterModalUI() {
  const erB3 = _modalFormat?.type === 'best_of_3';

  // Game-indikatorer
  const indEl = document.getElementById('t-game-indikatorer');
  if (indEl) {
    if (erB3) {
      const stilling = beregnBestOf3(_games.filter(Boolean));
      indEl.style.display = 'flex';
      indEl.innerHTML = [0, 1, 2].map(i => {
        const g = _games[i];
        let klasse = 'game-sirkel';
        if (g) klasse += g.l1 > g.l2 ? ' game-vunnet-lag1' : ' game-vunnet-lag2';
        else if (i === _aktivGame) klasse += ' game-aktiv';
        return `<span class="${klasse}"></span>`;
      }).join('');

      // Stillingsdisplay
      const stEl = document.getElementById('t-game-stilling');
      if (stEl) {
        stEl.style.display = 'block';
        stEl.textContent = `${stilling.lag1Seire} – ${stilling.lag2Seire}`;
      }
    } else {
      indEl.style.display = 'none';
      const stEl = document.getElementById('t-game-stilling');
      if (stEl) stEl.style.display = 'none';
    }
  }

  // Oppdater poeng-boksene og lukk pickere
  _tFremhevValgte();
  _tLukkAllePickere();

  // Åpne picker for neste lag automatisk (etter kort forsinkelse)
  const game = _games[_aktivGame] ?? {};
  if (game.l1 == null) {
    setTimeout(() => window.tApnePicker('l1'), 60);
  } else if (game.l2 == null) {
    setTimeout(() => window.tApnePicker('l2'), 60);
  }

  // LAGRE-knapp — synlig kun når kampen er ferdig
  const lagreKnapp = document.querySelector('#modal-resultat .knapp-gronn');
  if (lagreKnapp) {
    if (erB3) {
      const stilling = beregnBestOf3(_games.filter(Boolean));
      lagreKnapp.disabled = !stilling.ferdig;
      lagreKnapp.style.opacity = stilling.ferdig ? '1' : '0.4';
    } else {
      const g = _games[0] ?? {};
      lagreKnapp.disabled = g.l1 == null || g.l2 == null;
      lagreKnapp.style.opacity = (g.l1 != null && g.l2 != null) ? '1' : '0.4';
    }
  }

  _tFremhevValgte();
}

function _tSettAktivLagUI(lag) {
  // Lag-indikator er erstattet av poeng-velger-boks — ingen separat UI-oppdatering nødvendig
  _tAktivLag = lag;
}

function _tBygPickerGrid(felt, maks) {
  const picker = document.getElementById(`t-pp-${felt}`);
  if (!picker) return;
  const game    = _games[_aktivGame] ?? {};
  const gjeldende = felt === 'l1' ? game.l1 : game.l2;
  picker.innerHTML = '';
  for (let n = 0; n <= maks; n++) {
    const el = document.createElement('div');
    el.className = 'poeng-picker-tall' + (n === gjeldende ? ' valgt' : '');
    el.textContent = n;
    el.onclick = (e) => { e.stopPropagation(); tVelgPoeng(n); };
    picker.appendChild(el);
  }
}

window.tApnePicker = function(felt) {
  const annet  = felt === 'l1' ? 'l2' : 'l1';
  // Lukk den andre pickeren
  const annenP = document.getElementById(`t-pp-${annet}`);
  if (annenP) annenP.style.display = 'none';
  document.getElementById(`t-pvb-${annet}`)?.classList.remove('aktiv');

  const picker = document.getElementById(`t-pp-${felt}`);
  const boks   = document.getElementById(`t-pvb-${felt}`);
  if (!picker || !boks) return;

  _tAktivLag = felt === 'l1' ? 1 : 2;

  const erApen = picker.style.display !== 'none';
  if (erApen) {
    picker.style.display = 'none';
    boks.classList.remove('aktiv');
  } else {
    _tBygPickerGrid(felt, _tMaxPoeng);
    picker.style.display = 'grid';
    boks.classList.add('aktiv');
  }
};

function _tLukkAllePickere() {
  ['l1', 'l2'].forEach(felt => {
    const picker = document.getElementById(`t-pp-${felt}`);
    const boks   = document.getElementById(`t-pvb-${felt}`);
    if (picker) picker.style.display = 'none';
    if (boks)   boks.classList.remove('aktiv');
  });
}

function _tFremhevValgte() {
  const game = _games[_aktivGame] ?? {};
  ['l1', 'l2'].forEach(felt => {
    const boks = document.getElementById(`t-pvb-${felt}`);
    const verdi = felt === 'l1' ? game.l1 : game.l2;
    if (boks) boks.textContent = verdi != null ? String(verdi) : '—';
  });
}

// ════════════════════════════════════════════════════════
// POENGVALG
// ════════════════════════════════════════════════════════
window.tSettAktivLag = function(lag) {
  _tAktivLag = lag;
  window.tApnePicker(lag === 1 ? 'l1' : 'l2');
};

window.tVelgPoeng = function(verdi) {
  // Sett poeng for aktivt lag i aktivt game
  if (!_games[_aktivGame]) _games[_aktivGame] = { l1: null, l2: null };
  if (_tAktivLag === 1) _games[_aktivGame].l1 = verdi;
  else                  _games[_aktivGame].l2 = verdi;

  // Oppdater boks umiddelbart og lukk picker
  const felt = _tAktivLag === 1 ? 'l1' : 'l2';
  const boks = document.getElementById(`t-pvb-${felt}`);
  if (boks) { boks.textContent = String(verdi); boks.classList.remove('aktiv'); }
  const picker = document.getElementById(`t-pp-${felt}`);
  if (picker) picker.style.display = 'none';

  const game = _games[_aktivGame];
  const beggeValgt = game.l1 != null && game.l2 != null;

  if (beggeValgt) {
    if (_modalFormat?.type === 'best_of_3') {
      // Valider dette gamet
      const val = validerResultat(game.l1, game.l2, _modalFormat);
      if (!val.ok) {
        document.getElementById('modal-resultat-feil').textContent = val.feil;
        // Nullstill det ugyldige gamet
        _games[_aktivGame] = null;
        _tAktivLag = 1;
        _tOppdaterModalUI();
        return;
      }
      document.getElementById('modal-resultat-feil').textContent = '';

      // Sjekk stilling — er kampen avgjort?
      const fullteGames = _games.filter(Boolean);
      const stilling    = beregnBestOf3(fullteGames);

      if (stilling.ferdig) {
        // Kampen er ferdig — aktiver LAGRE
        _tOppdaterModalUI();
      } else {
        // Gå til neste game automatisk
        const nesteGame = _aktivGame + 1;
        if (nesteGame < 3) {
          _aktivGame = nesteGame;
          _tAktivLag = 1;
          _tOppdaterModalUI();
        }
      }
    } else {
      // Single game — bytt til lag 2 hvis lag 1 nettopp valgte
      if (_tAktivLag === 1) {
        _tAktivLag = 2;
      }
      _tOppdaterModalUI();
    }
  } else {
    // Bare ett lag har valgt — bytt til det andre
    _tAktivLag = _tAktivLag === 1 ? 2 : 1;
    _tOppdaterModalUI();
  }
};

// ════════════════════════════════════════════════════════
// LAGRE
// ════════════════════════════════════════════════════════
window.bekreftResultat = async function() {
  const erB3     = _modalFormat?.type === 'best_of_3';
  const feilEl   = document.getElementById('modal-resultat-feil');
  const lagreBtn = document.querySelector('#modal-resultat .knapp-gronn');

  let lag1Poeng, lag2Poeng, games = null;

  if (erB3) {
    const fullteGames = _games.filter(Boolean);
    const stilling    = beregnBestOf3(fullteGames);
    if (!stilling.ferdig) {
      feilEl.textContent = 'Kampen er ikke ferdig ennå.';
      return;
    }
    games     = fullteGames;
    lag1Poeng = stilling.lag1Seire;
    lag2Poeng = stilling.lag2Seire;
  } else {
    const game = _games[0];
    if (!game || game.l1 == null || game.l2 == null) {
      feilEl.textContent = 'Velg poeng for begge lag.';
      return;
    }
    const val = validerResultat(game.l1, game.l2, _modalFormat);
    if (!val.ok) { feilEl.textContent = val.feil; return; }
    lag1Poeng = game.l1;
    lag2Poeng = game.l2;
  }

  if (lagreBtn) lagreBtn.disabled = true;
  feilEl.textContent = '';

  try {
    const id = getAktivTurneringId();
    const t  = app.aktivTurnering;
    if (_modalNivaa) {
      const oppdatert = await registrerSluttspillResultat(id, _modalNivaa, _modalKampId, lag1Poeng, lag2Poeng, games);
      app.aktivTurnering = { ...t, sluttspill: oppdatert };
      lukkResultatModal();
      visBracket(app.aktivTurnering);
    } else {
      await registrerPuljeresultat(id, _modalPuljeId, _modalKampId, lag1Poeng, lag2Poeng, games);
      const oppdatert = await hentTurnering(id);
      app.aktivTurnering = oppdatert;
      lukkResultatModal();
      visPulje(oppdatert);
    }
  } catch (e) {
    feilEl.textContent = e?.message ?? 'Feil ved lagring.';
  } finally {
    if (lagreBtn) lagreBtn.disabled = false;
  }
};

window.registrerWalkoverUI = async function() {
  if (!_modalKampId || (!_modalPuljeId && !_modalNivaa)) return;
  krevAdminTurnering('Walkover', 'Bekreft walkover — motstanderen tildeles seier.', async () => {
    try {
      const id = getAktivTurneringId();
      await registrerWalkover(id, _modalPuljeId, _modalKampId, _modalLag2Id);
      const oppdatert = await hentTurnering(id);
      app.aktivTurnering = oppdatert;
      lukkResultatModal();
      visPulje(oppdatert);
    } catch (e) {
      visMelding(e?.message ?? 'Feil.', 'feil');
    }
  });
};
// ════════════════════════════════════════════════════════
// BRACKET-SKJERM
// ════════════════════════════════════════════════════════
export async function visBracket(turnering) {
  const t = turnering ?? await hentTurnering(getAktivTurneringId());
  app.aktivTurnering = t;

  document.getElementById('bracket-turnering-navn').textContent = t.navn;

  const lagMap    = Object.fromEntries(t.lag.map(l => [l.id, l]));
  const container = document.getElementById('bracket-innhold');
  if (!container) return;

  const aKamper = t.sluttspill?.A?.kamper ?? [];
  const bKamper = t.sluttspill?.B?.kamper ?? [];
  const cKamper = t.sluttspill?.C?.kamper ?? [];

  container.innerHTML = [
    aKamper.length ? bracketNivaaHTML('🥇 A-sluttspill', 'var(--yellow)',   aKamper, lagMap, 'A') : '',
    bKamper.length ? bracketNivaaHTML('🥈 B-sluttspill', 'var(--accent2)',  bKamper, lagMap, 'B') : '',
    cKamper.length ? bracketNivaaHTML('🥉 C-sluttspill', 'var(--muted2)',   cKamper, lagMap, 'C') : '',
  ].filter(Boolean).join('');

  const avsluttKnapp = document.getElementById('avslutt-turnering-knapp');
  if (avsluttKnapp) avsluttKnapp.style.display = erAltFerdig(t) ? 'block' : 'none';
}

function bracketNivaaHTML(tittel, farge, kamper, lagMap, nivaa) {
  const runder = grupperKamperIRunder(kamper);
  return `
    <div class="seksjon-etikett" style="color:${farge}">${tittel}</div>
    <div class="kort"><div class="kort-innhold" style="padding:8px 0">
      <div style="display:flex;gap:16px;overflow-x:auto;padding:4px 8px">
        ${runder.map(r => bracketRundeHTML(r, lagMap, nivaa, farge)).join('')}
      </div>
    </div></div>`;
}

function grupperKamperIRunder(kamper) {
  const rundeRekkefølge = ['Åttedelsfinale', 'Kvartfinale', 'Semifinale', 'Plass 5–8', '5. plass', '7. plass', '3. plass', '1. plass', 'Finale', '9. plass', '17. plass'];
  const rundeMap = {};
  for (const k of kamper) {
    if (!rundeMap[k.runde]) rundeMap[k.runde] = [];
    rundeMap[k.runde].push(k);
  }
  return Object.entries(rundeMap)
    .sort(([a], [b]) => {
      const ia = rundeRekkefølge.indexOf(a);
      const ib = rundeRekkefølge.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    })
    .map(([runde, kamper]) => ({ runde, kamper }));
}

function bracketRundeHTML(runde, lagMap, nivaa, farge) {
  return `
    <div class="bracket-kolonne">
      <div class="bracket-runde-tittel" style="color:${farge}">${escHtml(runde.runde)}</div>
      ${runde.kamper.map(k => bracketKampHTML(k, lagMap, nivaa)).join('')}
    </div>`;
}

function bracketKampHTML(kamp, lagMap, nivaa) {
  const l1     = lagMap[kamp.lag1Id]?.navn ?? (kamp.lag1Id ? '?' : 'TBD');
  const l2     = lagMap[kamp.lag2Id]?.navn ?? (kamp.lag2Id ? '?' : 'TBD');
  const v1     = kamp.ferdig && kamp.lag1Poeng > kamp.lag2Poeng;
  const v2     = kamp.ferdig && kamp.lag2Poeng > kamp.lag1Poeng;
  const kanReg = kamp.lag1Id && kamp.lag2Id && !kamp.ferdig;

  const gameDetaljer = kamp.ferdig && kamp.games?.length
    ? `<div style="font-size:11px;color:var(--muted2);margin-top:4px;letter-spacing:.3px">
        ${kamp.games.map((g, i) => {
          const g1Vant = g.l1 > g.l2;
          return `<span style="color:${g1Vant ? 'var(--green2)' : 'var(--muted2)'}">${g.l1}</span><span style="color:var(--muted)">–</span><span style="color:${!g1Vant ? 'var(--green2)' : 'var(--muted2)'}">${g.l2}</span>${i < kamp.games.length - 1 ? '<span style="color:var(--border2)"> · </span>' : ''}`;
        }).join('')}
       </div>`
    : '';

  return `
    <div class="kamp-rad bracket-kamp-rad" style="cursor:${kanReg ? 'pointer' : 'default'}"
      ${kanReg ? `onclick="apneResultatModal('${nivaa}','${escHtml(kamp.id)}','${escHtml(kamp.lag1Id)}','${escHtml(kamp.lag2Id)}',true)"` : ''}>
      <div class="lb-navn" style="min-width:0">
        <div class="kamp-lag-${v1 ? 'vinner' : 'taper'}" style="font-size:15px">${escHtml(l1)}</div>
        <div class="kamp-lag-${v2 ? 'vinner' : 'taper'}" style="font-size:15px;margin-top:4px">${escHtml(l2)}</div>
        ${gameDetaljer}
      </div>
      ${kamp.ferdig
        ? `<div class="poeng-kolonne" style="font-size:18px"><span>${kamp.lag1Poeng}</span><span>${kamp.lag2Poeng}</span></div>`
        : kanReg ? `<div style="font-size:20px;color:var(--muted2)">✏️</div>` : ''
      }
    </div>
    ${kamp.ferdig
      ? `<div style="text-align:right;margin-bottom:4px">
           <button class="knapp-tekst bracket-rediger-knapp" onclick="redigerSluttspillKamp('${nivaa}','${escHtml(kamp.id)}')">Rediger</button>
         </div>` : ''}`;
}


// ════════════════════════════════════════════════════════
// FLYTT LAG MELLOM PULJER
// ════════════════════════════════════════════════════════
let _flyttLagId   = null;
let _flyttFraPulje = null;

window.apneFlyttLagModal = function(lagId, fraPuljeId) {
  krevAdminTurnering('Flytt lag', 'PIN kreves for å flytte lag mellom puljer.', () => {
    _flyttLagId    = lagId;
    _flyttFraPulje = fraPuljeId;
    const t      = app.aktivTurnering;
    const lagMap = Object.fromEntries((t?.lag ?? []).map(l => [l.id, l]));
    const lagNavn = lagMap[lagId]?.navn ?? lagId;

    // Bygg modal dynamisk
    let modal = document.getElementById('modal-flytt-lag');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'modal-flytt-lag';
      modal.className = 'modal-bakgrunn';
      modal.style.display = 'none';
      modal.onclick = e => { if (e.target === modal) lukkFlyttLagModal(); };
      document.body.appendChild(modal);
    }

    const andrePuljer = (t?.puljer ?? []).filter(p => p.id !== fraPuljeId);
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-tittel">↕ Flytt lag</div>
        <div class="modal-tekst" style="font-size:16px;margin-bottom:16px">
          Flytt <strong>${escHtml(lagNavn)}</strong> til:
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px">
          ${andrePuljer.map(p => `
            <button class="knapp knapp-omriss" style="text-align:left;font-size:16px"
              onclick="bekreftFlyttLag('${escHtml(p.id)}','${escHtml(p.navn)}')">
              ${escHtml(p.navn)}
            </button>`).join('')}
        </div>
        <button class="knapp knapp-omriss" style="width:100%" onclick="lukkFlyttLagModal()">Avbryt</button>
      </div>`;
    modal.style.display = 'flex';
  });
};

window.lukkFlyttLagModal = function() {
  const modal = document.getElementById('modal-flytt-lag');
  if (modal) modal.style.display = 'none';
};

window.bekreftFlyttLag = async function(tilPuljeId, tilPuljeNavn) {
  lukkFlyttLagModal();
  const id = getAktivTurneringId();
  try {
    await flyttLag(id, _flyttLagId, tilPuljeId);
    const oppdatert = await hentTurnering(id);
    app.aktivTurnering = oppdatert;
    visPulje(oppdatert);
    visMelding(`Lag flyttet til ${tilPuljeNavn} — kamper regenerert.`);
  } catch (e) {
    visMelding(e?.message ?? 'Feil ved flytting av lag.', 'feil');
  }
};

function erAltFerdig(t) {
  const sjekkBracket = (kamper) => kamper.length > 0 && kamper.every(k => k.ferdig);
  return sjekkBracket(t.sluttspill?.A?.kamper ?? []) &&
    (!t.sluttspill?.B?.kamper?.length || sjekkBracket(t.sluttspill.B.kamper)) &&
    (!t.sluttspill?.C?.kamper?.length || sjekkBracket(t.sluttspill.C.kamper));
}

function _hentEllerLagRedigerAdvarselBoks() {
  let boks = document.getElementById('rediger-advarsel-boks');
  if (boks) return boks;

  // Boksen mangler i HTML — bygg den dynamisk første gang
  boks = document.createElement('div');
  boks.id = 'rediger-advarsel-boks';
  boks.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:999;align-items:flex-end;justify-content:center';
  boks.innerHTML = `
    <div style="background:var(--navy2,#0d1f3c);border-radius:22px 22px 0 0;padding:24px 20px;width:100%;max-width:480px;box-sizing:border-box">
      <div style="font-size:18px;font-weight:700;color:var(--white);margin-bottom:10px">⚠️ Rediger ferdig kamp?</div>
      <div style="font-size:14px;color:var(--muted2);margin-bottom:20px">Alle kamper som avhenger av dette resultatet vil bli nullstilt.</div>
      <div style="display:flex;gap:10px">
        <button class="knapp knapp-omriss" style="flex:1" onclick="lukkRedigerAdvarsel()">Avbryt</button>
        <button class="knapp knapp-fare" style="flex:2;font-family:'Bebas Neue',cursive;font-size:20px" onclick="bekreftRediger()">REDIGER LIKEVEL</button>
      </div>
    </div>`;
  document.body.appendChild(boks);
  return boks;
}

window.redigerSluttspillKamp = function(nivaa, kampId) {
  krevAdminTurnering('Rediger kamp', 'PIN kreves for å redigere et ferdig resultat.', () => {
    const t    = app.aktivTurnering;
    const kamp = t?.sluttspill?.[nivaa]?.kamper?.find(k => k.id === kampId);
    if (!kamp) return;
    const boks = _hentEllerLagRedigerAdvarselBoks();
    boks.dataset.nivaa  = nivaa;
    boks.dataset.kampId = kampId;
    boks.style.display  = 'flex';
  });
};

window.lukkRedigerAdvarsel = function() {
  const boks = document.getElementById('rediger-advarsel-boks');
  if (boks) boks.style.display = 'none';
};

window.bekreftRediger = async function() {
  const boks   = document.getElementById('rediger-advarsel-boks');
  const nivaa  = boks?.dataset?.nivaa;
  const kampId = boks?.dataset?.kampId;
  if (!nivaa || !kampId) return;
  lukkRedigerAdvarsel();
  try {
    const id = getAktivTurneringId();
    await nullstillNedstrømsKamper(id, nivaa, kampId);
    const oppdatert = await hentTurnering(id);
    app.aktivTurnering = oppdatert;
    const kamp = oppdatert.sluttspill?.[nivaa]?.kamper?.find(k => k.id === kampId);
    if (kamp) apneResultatModal(nivaa, kampId, kamp.lag1Id, kamp.lag2Id, true);
    visBracket(oppdatert);
  } catch (e) {
    visMelding(e?.message ?? 'Feil.', 'feil');
  }
};

function _finnNedstrøms(kampId, alleKamper) {
  const resultat = [];
  const kamp = alleKamper.find(k => k.id === kampId);
  if (!kamp) return resultat;
  if (kamp.winner_to) resultat.push(..._finnNedstrøms(kamp.winner_to, alleKamper));
  if (kamp.loser_to)  resultat.push(..._finnNedstrøms(kamp.loser_to,  alleKamper));
  resultat.push(kampId);
  return resultat;
}

window.tilSluttspillUI = function() {
  krevAdminTurnering('Start sluttspill', 'PIN kreves for å starte sluttspill.', async () => {
    try {
      const id        = getAktivTurneringId();
      const sluttspill = await startSluttspill(id);
      const oppdatert  = await hentTurnering(id);
      app.aktivTurnering = oppdatert;
      navigerTurnering('turnering-pulje', 'turnering-bracket');
      visBracket(oppdatert);
    } catch (e) {
      visMelding(e?.message ?? 'Feil ved start av sluttspill.', 'feil');
    }
  });
};

window.avsluttTurneringUI = function() {
  krevAdminTurnering('Avslutt turnering', 'PIN kreves for å avslutte turneringen.', async () => {
    try {
      const id         = getAktivTurneringId();
      const rangering  = await avsluttTurnering(id);
      const oppdatert  = await hentTurnering(id);
      app.aktivTurnering = oppdatert;
      navigerTurnering('turnering-bracket', 'turnering-resultat');
      visResultat(oppdatert, rangering);
    } catch (e) {
      visMelding(e?.message ?? 'Feil ved avslutning.', 'feil');
    }
  });
};

// ════════════════════════════════════════════════════════
// SLUTTRESULTAT
// ════════════════════════════════════════════════════════
export async function visResultat(turnering, rangeringOverstyr = null) {
  const t         = turnering ?? await hentTurnering(getAktivTurneringId());
  const rangering = rangeringOverstyr ?? beregnEndeligRangering(t);

  document.getElementById('resultat-turnering-navn').textContent = t.navn;

  const lagMap  = Object.fromEntries((t.lag ?? []).map(l => [l.id, l]));
  const innhold = document.getElementById('t-resultat-innhold');
  if (!innhold) return;

  const plassFarge = (p) => p === 1 ? 'var(--yellow)' : p === 2 ? 'var(--muted2)' : p === 3 ? '#cd7f32' : 'var(--muted2)';
  const hentNavn   = (r) => r.lag?.navn ?? lagMap[r.lagId]?.navn ?? r.lagId ?? '?';

  innhold.innerHTML = `
    <div class="kort"><div class="kort-innhold" style="padding:0">
      ${rangering.map(r => `
        <div class="lb-rad" style="padding:14px 16px">
          <div class="lb-plass" style="color:${plassFarge(r.plass)}">${r.plass}</div>
          <div class="lb-navn" style="font-weight:${r.plass <= 3 ? 600 : 400}">${escHtml(hentNavn(r))}</div>
          <div style="font-size:20px">${r.plass === 1 ? '🏆' : r.plass === 2 ? '🥈' : r.plass === 3 ? '🥉' : ''}</div>
        </div>`).join('')}
    </div></div>`;
}
