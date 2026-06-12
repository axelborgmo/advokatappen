/* ============================================================
   Advokatappen: timeføring og fakturering for norske advokater.
   Hele appen er bevisst så enkel som mulig: én fil, ingen
   avhengigheter, all data lagres lokalt på enheten.
   ============================================================ */

'use strict';

// Privat praksis: det faktureres per påbegynt kvarter.
const KVARTER_I_SEKUNDER = 15 * 60;
const KVARTER_PER_TIME = 4;

// Salærforskriften § 5: på salæroppgaver avrundes samlet tidsbruk
// (utenom rettsmøter) oppad til nærmeste halvtime. Rettsmøter avrundes
// oppad til nærmeste halvtime per dag, og møter under én time
// godtgjøres med én time.
const HALVTIME_I_TIMER = 0.5;
const RETTSMOTE_MINSTEGODTGJORING_TIMER = 1;
const RETTSMOTE_AKTIVITET = 'Rettsmøte';

// Offentlig salær avregnes mot domstolen når oppdraget passerer terskelen.
const TERSKEL_AVREGNING_OFFENTLIG_TIMER = 60;

// Advokattjenester er avgiftspliktige.
const MVA_SATS = 0.25;

// Standard betalingsfrist på fakturaer til private klienter.
const FORFALL_DAGER = 14;

const LAGRINGSNOKKEL = 'advokatappen.v1';

const AKTIVITETER = [
  'Klient ringer',
  'Klientmøte',
  'Saksforberedelse',
  'Rettsmøte',
  'E-post og brev',
  'Annet arbeid',
];

// ---------- Tilstand ----------

let state = lastTilstand();
let visning = { side: 'klienter' };
let klokkeIntervall = null;

function nyTilstand() {
  return {
    advokat: {
      navn: '', tittel: 'Advokat', firma: '', orgnr: '',
      adresse: '', telefon: '', epost: '', kontonummer: '',
      standardsats: '',
    },
    klienter: [],
    foringer: [],
    fakturaer: [],
    aktiv: null, // { klientId, aktivitet, startMs }
    fakturaTeller: 0,
  };
}

function lastTilstand() {
  try {
    const raa = localStorage.getItem(LAGRINGSNOKKEL);
    if (!raa) return nyTilstand();
    return Object.assign(nyTilstand(), JSON.parse(raa));
  } catch (feil) {
    console.error('Kunne ikke lese lagret data', feil);
    return nyTilstand();
  }
}

function lagre() {
  localStorage.setItem(LAGRINGSNOKKEL, JSON.stringify(state));
}

function nyId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- Formatering ----------

const kronerFmt = new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK' });
const datoLangFmt = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'long', year: 'numeric' });
const datoKortFmt = new Intl.DateTimeFormat('nb-NO', { day: '2-digit', month: '2-digit', year: 'numeric' });
const manedFmt = new Intl.DateTimeFormat('nb-NO', { month: 'long', year: 'numeric' });

function fmtKr(belop) { return kronerFmt.format(belop); }
function fmtDatoLang(iso) { return datoLangFmt.format(new Date(iso)); }
function fmtDatoKort(iso) { return datoKortFmt.format(new Date(iso)); }

function fmtKlokke(sekunder) {
  const t = Math.floor(sekunder / 3600);
  const m = Math.floor((sekunder % 3600) / 60);
  const s = Math.floor(sekunder % 60);
  const to = (n) => String(n).padStart(2, '0');
  return `${to(t)}:${to(m)}:${to(s)}`;
}

function fmtTimerDesimal(timer) {
  return timer.toLocaleString('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function esc(tekst) {
  const div = document.createElement('div');
  div.textContent = tekst == null ? '' : String(tekst);
  return div.innerHTML;
}

// ---------- Domeneregler ----------

function kvarterFor(sekunder) {
  return Math.max(1, Math.ceil(sekunder / KVARTER_I_SEKUNDER));
}

function fakturerbareTimer(sekunder) {
  return kvarterFor(sekunder) / KVARTER_PER_TIME;
}

function raaTimer(sekunder) {
  return sekunder / 3600;
}

function rundOppTilHalvtime(timer) {
  return Math.ceil(timer / HALVTIME_I_TIMER) * HALVTIME_I_TIMER;
}

// Salærforskriften § 5-oppgjør for offentlig salær: rettsmøter per dag
// (minst én time), alt annet arbeid avrundes samlet.
function beregnOffentligTimer(foringer) {
  const rettsmoterPerDag = new Map();
  let annetSekunder = 0;
  foringer.forEach((f) => {
    if (f.aktivitet === RETTSMOTE_AKTIVITET) {
      const dag = f.start.slice(0, 10);
      rettsmoterPerDag.set(dag, (rettsmoterPerDag.get(dag) || 0) + f.sekunder);
    } else {
      annetSekunder += f.sekunder;
    }
  });
  let rettsmoteTimer = 0;
  rettsmoterPerDag.forEach((sekunder) => {
    rettsmoteTimer += Math.max(
      RETTSMOTE_MINSTEGODTGJORING_TIMER,
      rundOppTilHalvtime(raaTimer(sekunder))
    );
  });
  const annetTimer = annetSekunder > 0 ? rundOppTilHalvtime(raaTimer(annetSekunder)) : 0;
  return { annetTimer, rettsmoteTimer, totaltTimer: annetTimer + rettsmoteTimer };
}

function klient(klientId) {
  return state.klienter.find((k) => k.id === klientId) || null;
}

function uavregnedeForinger(klientId) {
  return state.foringer.filter((f) => f.klientId === klientId && !f.fakturaId);
}

function uavregnetSum(klientId) {
  const k = klient(klientId);
  const foringer = uavregnedeForinger(klientId);
  let timer;
  if (k && k.klienttype === 'offentlig') {
    timer = beregnOffentligTimer(foringer).totaltTimer;
  } else {
    timer = foringer.reduce((sum, f) => sum + fakturerbareTimer(f.sekunder), 0);
  }
  return { antall: foringer.length, timer, belop: timer * Number(k ? k.sats : 0) };
}

function bortePassertTerskel(k) {
  return k.klienttype === 'offentlig'
    && uavregnetSum(k.id).timer >= TERSKEL_AVREGNING_OFFENTLIG_TIMER;
}

// Private klienter faktureres månedlig: har klienten uavregnede føringer
// fra en tidligere måned, ligger månedsfakturaen klar.
function harKlarMaanedsfaktura(k) {
  if (k.klienttype !== 'privat') return false;
  const naa = new Date();
  return uavregnedeForinger(k.id).some((f) => {
    const slutt = new Date(f.slutt);
    return slutt.getFullYear() < naa.getFullYear()
      || (slutt.getFullYear() === naa.getFullYear() && slutt.getMonth() < naa.getMonth());
  });
}

// ---------- Tidtaking ----------

function startTidtaking(klientId, aktivitet) {
  if (state.aktiv && state.aktiv.klientId !== klientId) {
    const aktivKlient = klient(state.aktiv.klientId);
    const bytt = confirm(`Tidtaking pågår allerede på ${aktivKlient ? aktivKlient.navn : 'en annen klient'}. Vil du stoppe den og starte ny?`);
    if (!bytt) return;
    stoppTidtaking();
  } else if (state.aktiv && state.aktiv.klientId === klientId) {
    stoppTidtaking();
  }
  state.aktiv = { klientId, aktivitet, startMs: Date.now() };
  lagre();
  render();
}

function stoppTidtaking() {
  if (!state.aktiv) return;
  const { klientId, aktivitet, startMs } = state.aktiv;
  const sluttMs = Date.now();
  const sekunder = Math.max(1, Math.round((sluttMs - startMs) / 1000));
  state.foringer.push({
    id: nyId(),
    klientId,
    aktivitet,
    start: new Date(startMs).toISOString(),
    slutt: new Date(sluttMs).toISOString(),
    sekunder,
    fakturaId: null,
  });
  state.aktiv = null;
  lagre();
}

function aktivSekunder() {
  if (!state.aktiv) return 0;
  return Math.floor((Date.now() - state.aktiv.startMs) / 1000);
}

function oppdaterKlokker() {
  const sekunder = aktivSekunder();
  document.querySelectorAll('[data-klokke]').forEach((el) => {
    el.textContent = fmtKlokke(sekunder);
  });
  if (state.aktiv) {
    const k = klient(state.aktiv.klientId);
    document.title = `${fmtKlokke(sekunder)} · ${k ? k.navn : ''} · Advokatappen`;
  }
}

function styrKlokkeIntervall() {
  if (state.aktiv && !klokkeIntervall) {
    klokkeIntervall = setInterval(oppdaterKlokker, 1000);
  } else if (!state.aktiv && klokkeIntervall) {
    clearInterval(klokkeIntervall);
    klokkeIntervall = null;
    document.title = 'Advokatappen';
  }
}

// ---------- Faktura ----------

function lagFaktura(klientId) {
  const k = klient(klientId);
  const foringer = uavregnedeForinger(klientId);
  if (!k || foringer.length === 0) return null;

  state.fakturaTeller += 1;
  const naa = new Date();
  const nummer = `${naa.getFullYear()}-${String(state.fakturaTeller).padStart(3, '0')}`;

  const erOffentlig = k.klienttype === 'offentlig';
  const sortert = foringer.slice().sort((a, b) => a.start.localeCompare(b.start));

  // Salæroppgave: timelisten viser medgått tid per føring, avrundingen
  // skjer på totalen etter salærforskriften. Privat faktura: hver føring
  // avregnes per påbegynt kvarter.
  const linjer = sortert.map((f) => {
    const timer = erOffentlig ? raaTimer(f.sekunder) : fakturerbareTimer(f.sekunder);
    return {
      dato: f.start,
      aktivitet: f.aktivitet,
      sekunder: f.sekunder,
      timer,
      sats: Number(k.sats),
      belop: erOffentlig ? null : timer * Number(k.sats),
    };
  });

  const offentligTimer = erOffentlig ? beregnOffentligTimer(foringer) : null;
  const sumEks = erOffentlig
    ? offentligTimer.totaltTimer * Number(k.sats)
    : linjer.reduce((sum, l) => sum + l.belop, 0);
  const mva = sumEks * MVA_SATS;

  const forfall = new Date(naa);
  forfall.setDate(forfall.getDate() + FORFALL_DAGER);

  const faktura = {
    id: nyId(),
    nummer,
    type: erOffentlig ? 'salaeroppgave' : 'faktura',
    klientId,
    dato: naa.toISOString(),
    forfall: forfall.toISOString(),
    klient: { navn: k.navn, fodt: k.fodt, sakstype: k.sakstype, klienttype: k.klienttype, oppdrag: k.oppdrag },
    advokat: { ...state.advokat },
    linjer,
    offentligTimer,
    sumEks,
    mva,
    sumInk: sumEks + mva,
  };

  state.fakturaer.push(faktura);
  foringer.forEach((f) => { f.fakturaId = faktura.id; });
  lagre();
  return faktura;
}

// ---------- Visninger ----------

function render() {
  styrKlokkeIntervall();
  const app = document.getElementById('app');
  let innhold = '';

  if (visning.side === 'klienter') innhold = visKlienter();
  else if (visning.side === 'nyKlient') innhold = visNyKlient();
  else if (visning.side === 'klient') innhold = visKlient(visning.klientId);
  else if (visning.side === 'faktura') innhold = visFaktura(visning.fakturaId);
  else if (visning.side === 'innstillinger') innhold = visInnstillinger();

  app.innerHTML = `
    <header class="topp">
      <button class="ordmerke" data-action="hjem">Advokat<span class="amp">appen</span></button>
      <nav class="topp-knapper">
        <button class="lenkeknapp" data-action="hjem">Klienter</button>
        <button class="lenkeknapp" data-action="innstillinger">Innstillinger</button>
      </nav>
    </header>
    ${innhold}
    <p class="fotnote"><span class="paragraf">§</span> Alt lagres lokalt på denne enheten. Privat tid avregnes per påbegynt kvarter, salæroppgaver etter salærforskriften § 5.</p>
  `;

  kobleSkjemaer();
  oppdaterKlokker();

  // Fakturaen ligger alltid klar i print-området, så Cmd+P fungerer
  // også uten å gå via knappen.
  const printRot = document.getElementById('print-root');
  if (visning.side === 'faktura') {
    const f = state.fakturaer.find((x) => x.id === visning.fakturaId);
    printRot.innerHTML = f ? `<div class="faktura-ark">${fakturaDok(f)}</div>` : '';
  } else {
    printRot.innerHTML = '';
  }
}

function visAktivKort() {
  if (!state.aktiv) return '';
  const k = klient(state.aktiv.klientId);
  return `
    <div class="aktiv-kort">
      <div class="status">I arbeid</div>
      <div class="klokke" data-klokke>${fmtKlokke(aktivSekunder())}</div>
      <div class="hva"><strong>${esc(state.aktiv.aktivitet)}</strong> · ${esc(k ? k.navn : 'Ukjent klient')}</div>
      <button class="knapp knapp-rod knapp-bred" data-action="stopp">Stopp og registrer tiden</button>
    </div>
  `;
}

function visKlienter() {
  const rader = state.klienter.map((k) => {
    const sum = uavregnetSum(k.id);
    const varsler = [];
    if (bortePassertTerskel(k)) varsler.push('<span class="chip chip-messing">Klar til avregning</span>');
    else if (harKlarMaanedsfaktura(k)) varsler.push('<span class="chip chip-messing">Månedsfaktura klar</span>');
    return `
      <button class="klientrad" data-action="apneKlient" data-id="${k.id}">
        <span>
          <span class="navn">${esc(k.navn)}</span>
          <span class="meta">
            <span class="chip ${k.sakstype === 'straff' ? 'chip-straff' : ''}">${k.sakstype === 'straff' ? 'Straff' : 'Sivil'}</span>
            <span class="chip ${k.klienttype === 'offentlig' ? 'chip-offentlig' : ''}">${k.klienttype === 'offentlig' ? 'Offentlig salær' : 'Privat'}</span>
            ${varsler.join('')}
          </span>
        </span>
        <span class="timer"><strong>${fmtTimerDesimal(sum.timer)} t</strong><br>uavregnet</span>
      </button>
    `;
  }).join('');

  const tomt = `
    <div class="tomt">
      <span class="paragraf">§</span>
      Ingen klienter ennå.<br>Registrer den første, det tar under et minutt.
    </div>
  `;

  return `
    ${visAktivKort()}
    <span class="etikett">Dine klienter</span>
    <h1 class="tittel">Klientoversikt</h1>
    <p class="undertekst">Trykk på en klient for å starte tidtaking eller lage faktura.</p>
    ${state.klienter.length ? rader : tomt}
    <button class="knapp knapp-primar knapp-bred" data-action="nyKlient">Ny klient</button>
  `;
}

function visNyKlient() {
  const standardsats = state.advokat.standardsats || '';
  return `
    <button class="lenkeknapp tilbake" data-action="hjem">&larr; Tilbake</button>
    <span class="etikett">Ny klient</span>
    <h1 class="tittel">Fem raske spørsmål</h1>
    <p class="undertekst">Svarene plasserer klienten i riktig kategori, så blir faktureringen riktig av seg selv.</p>
    <form id="nyKlientSkjema" class="kort">
      <div class="sporsmal felt">
        <label for="navn"><span class="nummer">1.</span> Hvem er klienten?</label>
        <input type="text" id="navn" name="navn" required autocomplete="off" placeholder="Fullt navn">
      </div>
      <div class="sporsmal felt">
        <label for="fodt"><span class="nummer">2.</span> Når er klienten født?
          <span class="hjelpetekst">Brukes på faktura og salæroppgave.</span>
        </label>
        <input type="date" id="fodt" name="fodt" required>
      </div>
      <div class="sporsmal felt">
        <label><span class="nummer">3.</span> Sivil sak eller straffesak?</label>
        <div class="valgrad">
          <label class="valg"><input type="radio" name="sakstype" value="sivil" required checked><span>Sivil</span></label>
          <label class="valg"><input type="radio" name="sakstype" value="straff"><span>Straff</span></label>
        </div>
      </div>
      <div class="sporsmal felt">
        <label><span class="nummer">4.</span> Privat klient eller oppnevnt på offentlig salær?</label>
        <div class="valgrad">
          <label class="valg"><input type="radio" name="klienttype" value="privat" required checked><span>Privat<small>Faktureres månedlig, når du vil</small></span></label>
          <label class="valg"><input type="radio" name="klienttype" value="offentlig"><span>Offentlig salær<small>Avregnes mot domstolen</small></span></label>
        </div>
      </div>
      <div class="sporsmal felt">
        <label for="sats"><span class="nummer">5.</span> Hvilken timesats gjelder?
          <span class="hjelpetekst">Kroner per time, eks. mva. Rettshjelpssatsen er 1 375 kr i 2026 (offentlig salær).</span>
        </label>
        <input type="number" id="sats" name="sats" required min="0" step="1" inputmode="numeric" value="${esc(standardsats)}" placeholder="F.eks. 2000">
      </div>
      <div class="sporsmal felt">
        <label for="oppdrag">Hva består oppdraget i? <span class="hjelpetekst">Valgfritt, men setter rammene. F.eks. «Oppnevnt forsvarer, fengslingsperiode juni 2026».</span></label>
        <textarea id="oppdrag" name="oppdrag" placeholder="Kort beskrivelse av oppdraget"></textarea>
      </div>
      <button type="submit" class="knapp knapp-primar knapp-bred">Registrer klienten</button>
    </form>
  `;
}

function visKlient(klientId) {
  const k = klient(klientId);
  if (!k) { visning = { side: 'klienter' }; return visKlienter(); }

  const sum = uavregnetSum(k.id);
  const foringer = uavregnedeForinger(k.id)
    .slice()
    .sort((a, b) => b.start.localeCompare(a.start));

  const aktivHer = state.aktiv && state.aktiv.klientId === k.id;

  const aktivitetsknapper = AKTIVITETER.map((a) => `
    <button class="aktivitet" data-action="start" data-id="${k.id}" data-aktivitet="${esc(a)}">
      <span class="play">&#9654; Start</span>
      <span class="navn">${esc(a)}</span>
    </button>
  `).join('');

  const erOffentlig = k.klienttype === 'offentlig';
  const foringsliste = foringer.map((f) => {
    const visteTimer = erOffentlig ? raaTimer(f.sekunder) : fakturerbareTimer(f.sekunder);
    const belop = erOffentlig ? 'avregnes samlet' : fmtKr(fakturerbareTimer(f.sekunder) * Number(k.sats));
    return `
    <div class="foring">
      <span>
        <span class="aktivitetsnavn">${esc(f.aktivitet)}</span><br>
        <span class="dato">${fmtDatoKort(f.start)} · målt ${fmtKlokke(f.sekunder)} · <button class="lenkeknapp" data-action="slettForing" data-id="${f.id}">Slett</button></span>
      </span>
      <span class="varighet">${fmtTimerDesimal(visteTimer)} t<br><span class="belop">${belop}</span></span>
    </div>
  `;
  }).join('');

  const terskelVarsel = bortePassertTerskel(k) ? `
    <div class="varsel">
      <span class="varsel-tittel">Naturlig å avregne nå</span>
      <p>Du har ført over ${TERSKEL_AVREGNING_OFFENTLIG_TIMER} timer på oppdraget. Her er salæroppgaven, klar til å sendes til domstolen.</p>
      <button class="knapp knapp-primar" data-action="lagFaktura" data-id="${k.id}">Lag salæroppgave nå</button>
    </div>
  ` : '';

  const maanedsVarsel = !bortePassertTerskel(k) && harKlarMaanedsfaktura(k) ? `
    <div class="varsel">
      <span class="varsel-tittel">Månedsfakturaen ligger klar</span>
      <p>Klienten har uavregnet tid fra forrige måned. Private klienter kan faktureres når du vil.</p>
      <button class="knapp knapp-primar" data-action="lagFaktura" data-id="${k.id}">Lag månedsfaktura</button>
    </div>
  ` : '';

  const tidligereFakturaer = state.fakturaer
    .filter((f) => f.klientId === k.id)
    .slice()
    .sort((a, b) => b.dato.localeCompare(a.dato))
    .map((f) => `
      <div class="foring">
        <span>
          <span class="aktivitetsnavn">${f.type === 'salaeroppgave' ? 'Salæroppgave' : 'Faktura'} ${esc(f.nummer)}</span><br>
          <span class="dato">${fmtDatoKort(f.dato)} · ${f.linjer.length} føringer</span>
        </span>
        <span class="varighet">${fmtKr(f.sumInk)}<br><button class="lenkeknapp" data-action="apneFaktura" data-id="${f.id}">Åpne</button></span>
      </div>
    `).join('');

  return `
    <button class="lenkeknapp tilbake" data-action="hjem">&larr; Alle klienter</button>
    ${visAktivKort()}
    <span class="etikett">${k.sakstype === 'straff' ? 'Straffesak' : 'Sivil sak'} · ${k.klienttype === 'offentlig' ? 'Offentlig salær' : 'Privat klient'}</span>
    <h1 class="tittel">${esc(k.navn)}</h1>
    <p class="undertekst">Født ${fmtDatoKort(k.fodt)} · Sats ${fmtKr(Number(k.sats))} per time${k.oppdrag ? ` · ${esc(k.oppdrag)}` : ''}</p>

    ${terskelVarsel}
    ${maanedsVarsel}

    ${aktivHer ? '' : `
      <div class="seksjon-topp"><h2 class="tittel">Hva gjør du nå?</h2></div>
      <div class="aktivitetsnett">${aktivitetsknapper}</div>
    `}

    <div class="seksjon">
      <div class="seksjon-topp">
        <h2 class="tittel">Uavregnet tid</h2>
      </div>
      <div class="kort">
        ${foringer.length ? foringsliste : '<p class="undertekst" style="margin:0">Ingen føringer ennå. Start tidtakingen over når arbeidet begynner.</p>'}
        ${foringer.length ? `
          <div class="sumlinje">
            <span>${fmtTimerDesimal(sum.timer)} timer uavregnet${erOffentlig ? ' (salærforskriften § 5)' : ''}</span>
            <span class="sum-kr">${fmtKr(sum.belop)}</span>
          </div>
        ` : ''}
      </div>
      ${foringer.length ? `
        <button class="knapp knapp-primar knapp-bred" data-action="lagFaktura" data-id="${k.id}">
          ${k.klienttype === 'offentlig' ? 'Oppdraget er ferdig: lag salæroppgave' : 'Lag faktura nå'}
        </button>
      ` : ''}
    </div>

    ${tidligereFakturaer ? `
      <div class="seksjon">
        <div class="seksjon-topp"><h2 class="tittel">Avregnet</h2></div>
        <div class="kort">${tidligereFakturaer}</div>
      </div>
    ` : ''}
  `;
}

function fakturaDok(f) {
  const a = f.advokat;
  const erSalaer = f.type === 'salaeroppgave';
  const linjer = f.linjer.map((l) => `
    <tr>
      <td>${fmtDatoKort(l.dato)}</td>
      <td>${esc(l.aktivitet)}</td>
      <td class="tall">${fmtTimerDesimal(l.timer)}</td>
      <td class="tall">${fmtKr(l.sats)}</td>
      <td class="tall">${l.belop == null ? '&ndash;' : fmtKr(l.belop)}</td>
    </tr>
  `).join('');

  const sumTimer = f.linjer.reduce((sum, l) => sum + l.timer, 0);

  const summerRader = erSalaer && f.offentligTimer ? `
    <div class="rad"><span>Medgått tid i alt</span><span class="tall">${fmtTimerDesimal(sumTimer)}</span></div>
    ${f.offentligTimer.annetTimer ? `<div class="rad"><span>Arbeid utenom rettsmøter, avrundet til halvtime</span><span class="tall">${fmtTimerDesimal(f.offentligTimer.annetTimer)}</span></div>` : ''}
    ${f.offentligTimer.rettsmoteTimer ? `<div class="rad"><span>Rettsmøter, per dag (minst 1 time)</span><span class="tall">${fmtTimerDesimal(f.offentligTimer.rettsmoteTimer)}</span></div>` : ''}
    <div class="rad"><span>Timer til godtgjøring (salærforskriften § 5)</span><span class="tall">${fmtTimerDesimal(f.offentligTimer.totaltTimer)}</span></div>
  ` : `
    <div class="rad"><span>Timer i alt (per påbegynt kvarter)</span><span class="tall">${fmtTimerDesimal(sumTimer)}</span></div>
  `;

  return `
    <div class="dok">
      <div class="dok-topp">
        <span class="dok-type">${erSalaer ? 'Salæroppgave' : 'Faktura'}</span>
        <span class="dok-nr">Nr. ${esc(f.nummer)} · ${fmtDatoLang(f.dato)}</span>
      </div>
      <div class="parter">
        <div class="part">
          <h3>Fra</h3>
          <p>
            <strong>${esc(a.navn || 'Navn ikke utfylt')}</strong>${a.tittel ? `, ${esc(a.tittel)}` : ''}<br>
            ${a.firma ? `${esc(a.firma)}<br>` : ''}
            ${a.adresse ? `${esc(a.adresse)}<br>` : ''}
            ${a.orgnr ? `Org.nr. ${esc(a.orgnr)}<br>` : ''}
            ${a.telefon ? `${esc(a.telefon)} · ` : ''}${a.epost ? esc(a.epost) : ''}
          </p>
        </div>
        <div class="part">
          <h3>${erSalaer ? 'Til domstolen, vedrørende' : 'Til'}</h3>
          <p>
            <strong>${esc(f.klient.navn)}</strong><br>
            Født ${fmtDatoKort(f.klient.fodt)}<br>
            ${f.klient.sakstype === 'straff' ? 'Straffesak' : 'Sivil sak'}
          </p>
        </div>
      </div>
      ${f.klient.oppdrag ? `
        <div class="oppdrag">
          <h3 class="etikett">Oppdraget</h3>
          <p>${esc(f.klient.oppdrag)}</p>
        </div>
      ` : ''}
      <table>
        <thead>
          <tr>
            <th>Dato</th>
            <th>Arbeid</th>
            <th class="tall">Timer</th>
            <th class="tall">Sats</th>
            <th class="tall">Beløp</th>
          </tr>
        </thead>
        <tbody>${linjer}</tbody>
      </table>
      <div class="summer">
        ${summerRader}
        <div class="rad"><span>Salær eks. mva.</span><span class="tall">${fmtKr(f.sumEks)}</span></div>
        <div class="rad"><span>Merverdiavgift 25 %</span><span class="tall">${fmtKr(f.mva)}</span></div>
        <div class="rad total"><span>Å betale</span><span class="tall">${fmtKr(f.sumInk)}</span></div>
      </div>
      <div class="betaling">
        <p>${a.kontonummer ? `Betales til konto <strong>${esc(a.kontonummer)}</strong>` : ''}</p>
        <p>${erSalaer ? '' : `Forfall ${fmtDatoLang(f.forfall)}`}</p>
      </div>
      <div class="signatur">
        <span class="strek"></span>
        ${a.navn ? `${esc(a.navn)}${a.tittel ? `, ${esc(a.tittel).toLowerCase()}` : ''}` : ''}
      </div>
    </div>
  `;
}

function visFaktura(fakturaId) {
  const f = state.fakturaer.find((x) => x.id === fakturaId);
  if (!f) { visning = { side: 'klienter' }; return visKlienter(); }
  const erSalaer = f.type === 'salaeroppgave';
  return `
    <button class="lenkeknapp tilbake" data-action="apneKlient" data-id="${f.klientId}">&larr; Tilbake til ${esc(f.klient.navn)}</button>
    <span class="etikett">${erSalaer ? 'Sendes til domstolen' : 'Sendes til klienten'}</span>
    <h1 class="tittel">${erSalaer ? 'Salæroppgave' : 'Faktura'} ${esc(f.nummer)}</h1>
    <p class="undertekst">Skriv ut eller lagre som PDF, så kan den sendes rett ${erSalaer ? 'til domstolen' : 'til klienten'}.</p>
    <div class="handlingsrad">
      <button class="knapp knapp-primar" data-action="skrivUt" data-id="${f.id}">Skriv ut / lagre som PDF</button>
    </div>
    <div class="faktura-ark">${fakturaDok(f)}</div>
  `;
}

function visInnstillinger() {
  const a = state.advokat;
  return `
    <button class="lenkeknapp tilbake" data-action="hjem">&larr; Tilbake</button>
    <span class="etikett">Innstillinger</span>
    <h1 class="tittel">Dine fakturaopplysninger</h1>
    <p class="undertekst">Dette settes inn på alle fakturaer og salæroppgaver.</p>
    <form id="innstillingerSkjema" class="kort">
      <div class="felt"><label for="i-navn">Navn</label><input type="text" id="i-navn" name="navn" value="${esc(a.navn)}" autocomplete="name"></div>
      <div class="felt"><label for="i-tittel">Tittel</label><input type="text" id="i-tittel" name="tittel" value="${esc(a.tittel)}" placeholder="Advokat / Advokatfullmektig"></div>
      <div class="felt"><label for="i-firma">Firma</label><input type="text" id="i-firma" name="firma" value="${esc(a.firma)}"></div>
      <div class="felt"><label for="i-orgnr">Organisasjonsnummer</label><input type="text" id="i-orgnr" name="orgnr" value="${esc(a.orgnr)}" inputmode="numeric"></div>
      <div class="felt"><label for="i-adresse">Adresse</label><input type="text" id="i-adresse" name="adresse" value="${esc(a.adresse)}" autocomplete="street-address"></div>
      <div class="felt"><label for="i-telefon">Telefon</label><input type="tel" id="i-telefon" name="telefon" value="${esc(a.telefon)}" autocomplete="tel"></div>
      <div class="felt"><label for="i-epost">E-post</label><input type="email" id="i-epost" name="epost" value="${esc(a.epost)}" autocomplete="email"></div>
      <div class="felt"><label for="i-konto">Kontonummer</label><input type="text" id="i-konto" name="kontonummer" value="${esc(a.kontonummer)}" inputmode="numeric"></div>
      <div class="felt"><label for="i-sats">Standard timesats (kr)</label><input type="number" id="i-sats" name="standardsats" value="${esc(a.standardsats)}" min="0" step="1" inputmode="numeric"></div>
      <button type="submit" class="knapp knapp-primar knapp-bred">Lagre</button>
    </form>
  `;
}

// ---------- Hendelser ----------

document.getElementById('app').addEventListener('click', (hendelse) => {
  const mål = hendelse.target.closest('[data-action]');
  if (!mål) return;
  const handling = mål.dataset.action;
  const id = mål.dataset.id;

  if (handling === 'hjem') { visning = { side: 'klienter' }; render(); }
  else if (handling === 'innstillinger') { visning = { side: 'innstillinger' }; render(); }
  else if (handling === 'nyKlient') { visning = { side: 'nyKlient' }; render(); }
  else if (handling === 'apneKlient') { visning = { side: 'klient', klientId: id }; render(); }
  else if (handling === 'start') { startTidtaking(id, mål.dataset.aktivitet); }
  else if (handling === 'stopp') { stoppTidtaking(); render(); }
  else if (handling === 'slettForing') {
    if (confirm('Vil du slette denne føringen?')) {
      state.foringer = state.foringer.filter((f) => f.id !== id);
      lagre(); render();
    }
  }
  else if (handling === 'lagFaktura') {
    const f = lagFaktura(id);
    if (f) { visning = { side: 'faktura', fakturaId: f.id }; render(); }
  }
  else if (handling === 'apneFaktura') { visning = { side: 'faktura', fakturaId: id }; render(); }
  else if (handling === 'skrivUt') {
    window.print();
  }
});

function kobleSkjemaer() {
  const nyKlientSkjema = document.getElementById('nyKlientSkjema');
  if (nyKlientSkjema) {
    nyKlientSkjema.addEventListener('submit', (hendelse) => {
      hendelse.preventDefault();
      const data = new FormData(nyKlientSkjema);
      const klientId = nyId();
      state.klienter.push({
        id: klientId,
        navn: data.get('navn').trim(),
        fodt: data.get('fodt'),
        sakstype: data.get('sakstype'),
        klienttype: data.get('klienttype'),
        sats: Number(data.get('sats')),
        oppdrag: (data.get('oppdrag') || '').trim(),
        opprettet: new Date().toISOString(),
      });
      lagre();
      visning = { side: 'klient', klientId };
      render();
    });
  }

  const innstillingerSkjema = document.getElementById('innstillingerSkjema');
  if (innstillingerSkjema) {
    innstillingerSkjema.addEventListener('submit', (hendelse) => {
      hendelse.preventDefault();
      const data = new FormData(innstillingerSkjema);
      ['navn', 'tittel', 'firma', 'orgnr', 'adresse', 'telefon', 'epost', 'kontonummer', 'standardsats']
        .forEach((felt) => { state.advokat[felt] = String(data.get(felt) || '').trim(); });
      lagre();
      visning = { side: 'klienter' };
      render();
    });
  }
}

// ---------- Oppstart ----------

render();
