// Real-world travel procedures, step by step, in sim time.
//
// Each protocol is a list of steps written as async functions against a small
// UI API (show / next / choose / wait). Waiting steps (queues, boarding,
// baggage reclaim) consume simulated time and can be skipped, which jumps the
// sim clock forward exactly as if you had waited.
import { html, raw, el, $, $$, esc } from './dom.js';
import { state, spend, earn, addStamp, visit } from './store.js';
import { sfx, speak } from './audio.js';
import { flag } from './countries.js';
import { VEHICLES } from './data/vehicles.js';
import { AIRPORTS } from './data/airports.js';
import {
  CARRIER,
  US_CARRIERS,
  CURRENCY,
  EMERGENCY,
  BAGGAGE,
  drivesOnLeft,
  needsCustoms,
  needsPassportControl,
  fuelPrice,
} from './data/countries-info.js';
import { estimateFare, hashString } from './flight.js';
import { sunElevation, formatCoord, compass } from './geo.js';
import { weatherAt } from './services.js';

// ── Formatting ────────────────────────────────────────────────────────────
export function fmtTime(ms, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || undefined }).format(ms);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(ms);
  }
}
export function fmtDate(ms, tz, opts = { day: '2-digit', month: 'short', year: 'numeric' }) {
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz || undefined }).format(ms);
  } catch {
    return new Intl.DateTimeFormat('en-GB', opts).format(ms);
  }
}
export function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${String(m).padStart(2, '0')}m`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}
export const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tzName = (ms, tz) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' }).formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
};

/** Deterministic pseudo-random generator seeded from a string. */
function rng(seed) {
  let x = hashString(seed) || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

// IATA airline accounting (ticketing) prefixes, used in bag-tag licence plates.
const ACCOUNTING = {
  AA: '001', DL: '006', UA: '016', AC: '014', BA: '125', AF: '057', KL: '074', LH: '220', LX: '724', EK: '176',
  QR: '157', EY: '607', TK: '235', ET: '071', KQ: '706', SA: '083', SQ: '618', CX: '160', QF: '081', NZ: '086',
  JL: '131', NH: '205', AI: '098', MS: '077', AT: '147', IB: '075', AZ: '055', TP: '047', SK: '117', AY: '105',
  EI: '053', LO: '080', SV: '065',
};

// ── The protocol sheet (UI) ───────────────────────────────────────────────
export class ProtocolSheet {
  constructor(root, deps) {
    this.root = root; // container element
    this.deps = deps; // { clock, toast, map, countries, journey }
  }

  /** Run a named protocol for a runner. Resolves when all steps are done. */
  async run(name, runner) {
    const build = PROTOCOLS[name];
    if (!build) return;
    const steps = (await build(runner, this.deps)).filter(Boolean);
    if (!steps.length) return;
    const title = TITLES[name](runner);
    this.root.innerHTML = '';
    const sheet = el(html`
      <section class="sheet" role="dialog" aria-modal="false" aria-label="${title.text}">
        <header class="sheet-head">
          <div class="sheet-kicker">${title.kicker}</div>
          <h2>${title.text}</h2>
          <button class="sheet-min icon-btn" title="Minimise" aria-label="Minimise panel">▾</button>
        </header>
        <ol class="sheet-steps">${steps.map((s, i) => html`<li data-i="${i}"><span class="dot">${s.icon || i + 1}</span><span>${s.title}</span></li>`)}</ol>
        <div class="sheet-body" aria-live="polite"></div>
        <footer class="sheet-foot"></footer>
      </section>`);
    this.root.appendChild(sheet);
    this.root.hidden = false;
    $('.sheet-min', sheet).onclick = () => sheet.classList.toggle('min');
    requestAnimationFrame(() => sheet.classList.add('in'));

    for (let i = 0; i < steps.length; i++) {
      $$('.sheet-steps li', sheet).forEach((li, k) => li.classList.toggle('done', k < i) || li.classList.toggle('active', k === i));
      $$('.sheet-steps li', sheet)[i].classList.add('active');
      $$('.sheet-steps li', sheet)[i].scrollIntoView({ block: 'nearest', inline: 'center' });
      const api = this.api(sheet, runner, steps[i]);
      await steps[i].run(api);
      $$('.sheet-steps li', sheet)[i].classList.add('done');
    }
    sheet.classList.remove('in');
    await new Promise((r) => setTimeout(r, 250));
    this.root.hidden = true;
    this.root.innerHTML = '';
  }

  api(sheet, runner, step) {
    const body = $('.sheet-body', sheet);
    const foot = $('.sheet-foot', sheet);
    const { clock } = this.deps;
    const auto = () => state.settings.autoChecks;
    const self = this;
    return {
      runner,
      leg: runner.leg,
      clock,
      deps: this.deps,
      show(fragment) {
        body.innerHTML = String(fragment);
        body.scrollTop = 0;
        foot.innerHTML = '';
        return body;
      },
      append(fragment) {
        const node = el(fragment);
        body.appendChild(node);
        node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return node;
      },
      next(label = 'Continue', { autoMs = 1400 } = {}) {
        foot.innerHTML = '';
        const b = el(html`<button class="btn btn-primary">${label}</button>`);
        foot.appendChild(b);
        b.focus({ preventScroll: true });
        return new Promise((resolve) => {
          const go = () => {
            sfx('beep');
            foot.innerHTML = '';
            resolve();
          };
          b.onclick = go;
          if (auto()) setTimeout(() => b.isConnected && go(), autoMs);
        });
      },
      choose(options, { columns = 2, autoPick } = {}) {
        foot.innerHTML = '';
        const grid = el(html`<div class="opt-grid cols-${columns}"></div>`);
        body.appendChild(grid);
        return new Promise((resolve) => {
          for (const o of options) {
            const b = el(html`<button class="opt ${o.tone || ''}" ${o.disabled ? raw('disabled') : ''}>
                <span class="opt-label">${o.icon ? html`<span class="opt-icon">${o.icon}</span>` : ''}${o.label}</span>
                ${o.sub ? html`<span class="opt-sub">${o.sub}</span>` : ''}
              </button>`);
            b.onclick = () => {
              sfx('beep');
              $$('.opt', grid).forEach((x) => (x.disabled = true));
              b.classList.add('picked');
              setTimeout(() => resolve(o.value), 180);
            };
            grid.appendChild(b);
          }
          if (auto() && autoPick !== undefined) {
            setTimeout(() => {
              const idx = options.findIndex((o) => o.value === autoPick);
              grid.children[Math.max(0, idx)]?.click();
            }, 1200);
          }
        });
      },
      /** Wait `seconds` of sim time with a live progress bar and a skip button. */
      async wait(seconds, label, { detail = '' } = {}) {
        const start = clock.simMs;
        const end = start + seconds * 1000;
        const node = el(html`<div class="waitbox">
            <div class="wait-head"><span class="spinner" aria-hidden="true"></span><strong>${label}</strong><span class="wait-left"></span></div>
            ${detail ? html`<div class="wait-detail">${detail}</div>` : ''}
            <div class="progress"><div class="bar"></div></div>
          </div>`);
        body.appendChild(node);
        foot.innerHTML = '';
        const skip = el(html`<button class="btn">Skip waiting ⏩</button>`);
        foot.appendChild(skip);
        skip.onclick = () => clock.skipWait();
        let raf;
        const paint = () => {
          const f = Math.min(1, (clock.simMs - start) / (end - start));
          $('.bar', node).style.width = `${(f * 100).toFixed(1)}%`;
          $('.wait-left', node).textContent = fmtDur((end - clock.simMs) / 1000);
          if (f < 1) raf = requestAnimationFrame(paint);
        };
        paint();
        await clock.wait(seconds);
        cancelAnimationFrame(raf);
        $('.bar', node).style.width = '100%';
        $('.wait-left', node).textContent = 'Done';
        node.classList.add('done');
        foot.innerHTML = '';
      },
      async pay(amount, label) {
        while (!spend(amount, label, clock.simMs)) {
          const choice = await self.insufficient(body, foot, amount);
          if (choice === 'work') {
            await this.wait(8 * 3600, 'Working remotely from a café', { detail: 'A full day of freelance work: +$320' });
            earn(320, 'Remote work day', clock.simMs);
            this.deps.toast?.('💼 +$320 earned working remotely');
          }
        }
        this.deps.toast?.(`💳 ${money(amount)}: ${label}`);
        return true;
      },
      speak: (text, kind = 'crew') => speak(text, { kind }),
      sfx,
      toast: (m) => self.deps.toast?.(m),
    };
  }

  insufficient(body, foot, amount) {
    const box = el(html`<div class="notice warn">
      <strong>Card declined: insufficient funds.</strong>
      <p>This costs ${money(amount)} but your wallet holds ${money(state.wallet)}. Like any traveller, you can pick up a day of remote work.</p>
    </div>`);
    body.appendChild(box);
    foot.innerHTML = '';
    return new Promise((resolve) => {
      const b = el(html`<button class="btn btn-primary">Work remotely for a day (+$320)</button>`);
      b.onclick = () => {
        box.remove();
        resolve('work');
      };
      foot.appendChild(b);
    });
  }
}

const TITLES = {
  'road-pre': (r) => ({ kicker: `${VEHICLES[r.leg.vehicle].name}`, text: r.leg.rental ? 'Pick up your rental' : VEHICLES[r.leg.vehicle].mode === 'drive' ? 'Before you drive' : 'Before you set off' }),
  'road-post': (r) => ({ kicker: 'Arrival', text: r.leg.to.name }),
  'air-pre': (r) => ({ kicker: `${r.leg.from.airport.name} · ${r.leg.from.iata}`, text: 'Departure' }),
  'air-post': (r) => ({ kicker: `${r.leg.to.airport.name} · ${r.leg.to.iata}`, text: 'Arrival' }),
  'sea-pre': (r) => ({ kicker: r.leg.from.label, text: VEHICLES[r.leg.vehicle].carDeck ? 'Ferry check-in' : 'Embarkation' }),
  'sea-post': (r) => ({ kicker: r.leg.to.label, text: 'Disembarkation' }),
};

// ── Shared documents ──────────────────────────────────────────────────────
function passengerName() {
  const n = (state.profile?.name || 'Traveller').trim().toUpperCase().split(/\s+/);
  const last = n.length > 1 ? n[n.length - 1] : n[0];
  const first = n.length > 1 ? n.slice(0, -1).join(' ') : 'MX';
  return { last, first, bcbp: `${last}/${first}`.replace(/[^A-Z/ ]/g, '').slice(0, 20).padEnd(20, ' ') };
}

function julian(ms) {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return String(Math.floor((ms - start) / 86400000)).padStart(3, '0');
}

/** IATA Resolution 792 Bar Coded Boarding Pass (mandatory items, single leg). */
export function bcbp(b) {
  const flt = String(b.number).padStart(4, '0').padEnd(5, ' ');
  const seat = b.seat.replace(/^(\d+)([A-Z])$/, (m, r, c) => r.padStart(3, '0') + c);
  return `M1${passengerName().bcbp}E${b.pnr.padEnd(7, ' ')}${b.from}${b.to}${b.carrier.padEnd(3, ' ')}${flt}${julian(b.std)}${b.cabinCode}${seat}${String(b.seq).padStart(4, '0')} 100`;
}

function barcodeSvg(text, h = 46) {
  // PDF417-style stacked bars generated deterministically from the BCBP string.
  const r = rng(text);
  let x = 0;
  const bars = [];
  for (let row = 0; row < 6; row++) {
    x = 0;
    while (x < 300) {
      const w = 1 + Math.floor(r() * 3);
      if (r() > 0.45) bars.push(`<rect x="${x}" y="${row * (h / 6)}" width="${w}" height="${h / 6 - 0.6}"/>`);
      x += w + (r() > 0.6 ? 1 : 0);
    }
  }
  return `<svg class="barcode" viewBox="0 0 300 ${h}" preserveAspectRatio="none" aria-label="Boarding pass barcode"><g fill="#111">${bars.join('')}</g></svg>`;
}

function boardingPassCard(b) {
  const tz0 = b.fromAirport.tz;
  return html`<article class="doc boarding-pass">
    <div class="bp-band">
      <span class="bp-carrier">${b.carrierName}</span>
      <span class="bp-cabin">${b.cabinName.toUpperCase()}</span>
    </div>
    <div class="bp-main">
      <div class="bp-route">
        <div><span class="bp-code">${b.from}</span><span class="bp-city">${b.fromAirport.city}</span></div>
        <span class="bp-plane">✈</span>
        <div><span class="bp-code">${b.to}</span><span class="bp-city">${b.toAirport.city}</span></div>
      </div>
      <dl class="bp-grid">
        <div><dt>Passenger</dt><dd>${passengerName().last}/${passengerName().first}</dd></div>
        <div><dt>Flight</dt><dd>${b.carrier} ${b.number}</dd></div>
        <div><dt>Date</dt><dd>${fmtDate(b.std, tz0, { day: '2-digit', month: 'short' }).toUpperCase()}</dd></div>
        <div><dt>Gate</dt><dd>${b.gate}</dd></div>
        <div><dt>Boarding</dt><dd>${fmtTime(b.boarding, tz0)}</dd></div>
        <div><dt>Departs</dt><dd>${fmtTime(b.std, tz0)}</dd></div>
        <div><dt>Seat</dt><dd class="big">${b.seat}</dd></div>
        <div><dt>Group</dt><dd class="big">${b.group}</dd></div>
        <div><dt>Seq</dt><dd>${String(b.seq).padStart(3, '0')}</dd></div>
        <div><dt>PNR</dt><dd>${b.pnr}</dd></div>
      </dl>
      ${raw(barcodeSvg(bcbp(b)))}
      <code class="bp-raw" title="IATA BCBP string">${bcbp(b)}</code>
      <p class="bp-note">Gate closes ${fmtTime(b.gateClose, tz0)}. ${b.international ? 'Present your passport at the gate.' : 'Photo ID required.'}</p>
    </div>
  </article>`;
}

function bagTagCard(b) {
  return html`<article class="doc bagtag">
    <div class="bt-dest">${b.to}</div>
    <div class="bt-row"><span>${b.carrier} ${b.number}</span><span>${fmtDate(b.std, b.fromAirport.tz, { day: '2-digit', month: 'short' }).toUpperCase()}</span></div>
    <div class="bt-city">${b.toAirport.city.toUpperCase()}</div>
    ${raw(barcodeSvg(b.bagTag, 34))}
    <div class="bt-plate">${b.bagTag}</div>
    <div class="bt-name">${passengerName().last}/${passengerName().first}</div>
  </article>`;
}

function stampSvg(s) {
  const r = rng(`${s.iso}${s.date}${s.port}`);
  const rot = Math.round(r() * 24 - 12);
  const hue = [205, 350, 140, 270, 25][Math.floor(r() * 5)];
  const shape = r() > 0.5 ? 'circle' : 'rect';
  const color = `hsl(${hue} 70% 34%)`;
  const date = fmtDate(s.date, undefined, { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  const name = esc(s.country.toUpperCase().slice(0, 22));
  // Squeeze long country names to the stamp's width, like a real rubber stamp.
  const fit = (max) => (name.length * 8.4 > max ? `textLength="${max}" lengthAdjust="spacingAndGlyphs"` : '');
  const inner =
    shape === 'circle'
      ? `<circle cx="80" cy="80" r="72" fill="none" stroke="${color}" stroke-width="5"/><circle cx="80" cy="80" r="62" fill="none" stroke="${color}" stroke-width="1.5"/>
         <text x="80" y="52" text-anchor="middle" font-size="13" font-weight="800" fill="${color}" letter-spacing="1" ${fit(104)}>${name}</text>
         <text x="80" y="88" text-anchor="middle" font-size="19" font-weight="900" fill="${color}">${esc(date)}</text>
         <text x="80" y="112" text-anchor="middle" font-size="12" font-weight="700" fill="${color}">${esc(s.port)} · ${s.kind === 'exit' ? 'DEPARTED' : 'ADMITTED'}</text>
         <text x="80" y="130" text-anchor="middle" font-size="15" fill="${color}">${s.mode === 'fly' ? '✈' : s.mode === 'sail' ? '⚓' : '🚘'}</text>`
      : `<rect x="8" y="22" width="144" height="116" rx="10" fill="none" stroke="${color}" stroke-width="5"/>
         <text x="80" y="52" text-anchor="middle" font-size="13" font-weight="800" fill="${color}" letter-spacing="1" ${fit(128)}>${name}</text>
         <line x1="18" y1="62" x2="142" y2="62" stroke="${color}" stroke-width="1.5"/>
         <text x="80" y="90" text-anchor="middle" font-size="19" font-weight="900" fill="${color}">${esc(date)}</text>
         <text x="80" y="114" text-anchor="middle" font-size="12" font-weight="700" fill="${color}">${esc(s.port)} · ${s.kind === 'exit' ? 'EXIT' : 'ENTRY'}</text>
         <text x="80" y="131" text-anchor="middle" font-size="15" fill="${color}">${s.mode === 'fly' ? '✈' : s.mode === 'sail' ? '⚓' : '🚘'}</text>`;
  return `<svg class="stamp" viewBox="0 0 160 160" style="transform:rotate(${rot}deg)" role="img" aria-label="${esc(s.country)} ${s.kind} stamp">${inner}</svg>`;
}
export { stampSvg };

async function giveStamp(api, s) {
  addStamp(s);
  const node = api.append(html`<div class="stamp-drop">${raw(stampSvg(s))}</div>`);
  sfx('stamp');
  node.classList.add('thud');
  await new Promise((r) => setTimeout(r, 600));
}

/** Arrival information card: the essentials a traveller checks on landing. */
async function arrivalCard(api, place, countries) {
  const country = countries.lookup(place.coord) || countries.get(place.iso);
  let wx = null;
  try {
    wx = await weatherAt(place.coord);
  } catch {
    // offline: show the card without weather
  }
  const tz = place.tz || wx?.timezone;
  const now = api.clock.simMs;
  const iso = country?.iso || place.iso;
  const cur = CURRENCY[iso];
  let curName = cur;
  try {
    curName = `${new Intl.DisplayNames(['en'], { type: 'currency' }).of(cur)} (${cur})`;
  } catch {
    // older browsers
  }
  if (country) {
    const first = visit(country, now);
    if (first) api.toast(`🎉 New country: ${flag(country.iso)} ${country.name} (+250 XP)`);
  }
  return html`<div class="arrival-card">
    <div class="ac-head"><span class="ac-flag">${flag(iso)}</span><div><strong>Welcome to ${place.name}</strong><span>${country?.name || ''}${country?.continent ? ` · ${country.continent}` : ''}</span></div></div>
    <dl class="kv">
      <div><dt>Local time</dt><dd>${fmtTime(now, tz)} <small>${tz ? tzName(now, tz) : ''}</small></dd></div>
      ${wx ? html`<div><dt>Weather now</dt><dd>${wx.icon} ${Math.round(wx.tempC)}°C · ${wx.text}</dd></div>` : ''}
      ${wx ? html`<div><dt>Wind</dt><dd>${Math.round(wx.windKmh)} km/h ${compass(wx.windDir)}</dd></div>` : ''}
      ${cur ? html`<div><dt>Currency</dt><dd>${curName}</dd></div>` : ''}
      <div><dt>Traffic drives on</dt><dd>the ${drivesOnLeft(iso) ? 'LEFT' : 'RIGHT'}</dd></div>
      <div><dt>Emergency number</dt><dd>${EMERGENCY[iso] || '112'}</dd></div>
      <div><dt>Position</dt><dd>${formatCoord(place.coord)}</dd></div>
    </dl>
  </div>`;
}

// ── Protocol definitions ──────────────────────────────────────────────────
const PROTOCOLS = {
  // ROAD: before setting off ------------------------------------------------
  'road-pre': async (runner) => {
    const { leg } = runner;
    const v = VEHICLES[leg.vehicle];
    const night = sunElevation(leg.from.coord, new Date(runner.ctx.clock.simMs)) < -0.8;
    const route = leg.route;
    const majorRoads = [...new Set(route.steps.map((s) => s.ref || s.name).filter(Boolean))].slice(0, 5);
    const steps = [];

    if (leg.rental) {
      steps.push({
        title: 'Rental desk',
        icon: '🔑',
        run: async (api) => {
          const days = Math.max(1, Math.ceil(leg.durationS / 86400));
          const daily = { sedan: 48, suv: 115, ev: 79, motorbike: 65 }[leg.vehicle] || 55;
          api.show(html`<p class="lead">You're at the rental counter at ${leg.from.label || leg.from.name}.</p>
            <ul class="checklist static">
              <li>Driving licence${needsPassportControl(state.profile?.nationality, leg.from.iso) ? ' + International Driving Permit' : ''}</li>
              <li>Credit card in the driver's name (security deposit hold: $300)</li>
              <li>${v.name}, ${days} day${days > 1 ? 's' : ''} at ${money(daily)}/day, collision damage waiver included</li>
            </ul>`);
          await api.next('Sign rental agreement');
          await api.pay(daily * days, `Rental: ${v.name}`);
          api.append(html`<p>Walk-around damage check: photograph every panel and note existing scratches on the check-out sheet.</p>`);
          await api.wait(8 * 60, 'Walk-around inspection');
        },
      });
    }

    const checks =
      v.mode === 'bike'
        ? ['Helmet on and strap fastened', 'Tyre pressure checked (80–100 psi)', 'Brakes tested, front and rear', `Lights ${night ? 'ON (it is dark)' : 'charged'}`, 'Two water bottles filled (2 × 750 ml)']
        : v.mode === 'walk'
          ? ['Comfortable shoes', 'Water bottle filled', 'Phone charged, offline map saved', night ? 'Reflective clothing (it is dark)' : 'Sunscreen & hat']
          : v.icon === 'motorbike'
            ? ['Helmet, gloves, jacket, boots: all the gear, all the time', 'Mirrors adjusted', 'Dipped headlight ON (mandatory in many countries)', 'Tyres & chain checked', 'Side stand up']
            : [
                'Seat and steering wheel adjusted',
                'Mirrors: rear-view and both wing mirrors',
                'Seatbelts fastened: driver and all passengers',
                v.batteryKWh ? `Battery ${Math.round((runner.battery / v.batteryKWh) * 100)}%, range ${Math.round(((runner.battery / v.kWhPer100) * 100))} km` : `Fuel ${Math.round((runner.fuel / v.tankL) * 100)}% (${Math.round(runner.fuel)} L), est. range ${Math.round((runner.fuel / v.lPer100) * 100)} km`,
                `Headlights ${night ? 'ON (after sunset)' : 'on AUTO'}`,
                'Phone in cradle, Do Not Disturb while driving',
              ];
    steps.push({
      title: 'Safety checks',
      icon: '✅',
      run: async (api) => {
        const body = api.show(html`<p class="lead">${leg.from.name} → ${leg.to.name}</p>
          <ul class="checklist">${checks.map((c, i) => html`<li><label><input type="checkbox" data-i="${i}"> ${c}</label></li>`)}</ul>
          <p class="muted">Tick every item, as you would in real life.</p>`);
        const list = $$('.checklist input', body);
        await new Promise((resolve) => {
          const check = () => list.every((b) => b.checked) && resolve();
          list.forEach((b) => b.addEventListener('change', () => (sfx('beep'), check())));
          if (state.settings.autoChecks) list.forEach((b, i) => setTimeout(() => ((b.checked = true), check()), 250 * (i + 1)));
        });
      },
    });
    steps.push({
      title: 'Route & go',
      icon: '🧭',
      run: async (api) => {
        const kmh = (route.distanceM / route.durationS) * 3.6;
        api.show(html`<div class="route-brief">
            <div class="rb-big">${(route.distanceM / 1000).toFixed(route.distanceM < 10000 ? 1 : 0)} km</div>
            <div>Estimated ${fmtDur(leg.durationS)} · average ${Math.round(kmh)} km/h</div>
            ${majorRoads.length ? html`<div class="muted">Via ${majorRoads.join(' · ')}</div>` : ''}
            ${v.lPer100 ? html`<div class="muted">Fuel needed ≈ ${((route.distanceM / 100000) * v.lPer100).toFixed(1)} L (≈ ${money(((route.distanceM / 100000) * v.lPer100) * fuelPrice(leg.from.iso))} at local prices)</div>` : ''}
            <div class="muted">Traffic in ${leg.from.iso ? flag(leg.from.iso) : ''} keeps ${drivesOnLeft(leg.from.iso) ? 'LEFT' : 'RIGHT'}.</div>
          </div>`);
        if (v.mode === 'drive') {
          await api.next(v.batteryKWh ? 'Press brake + Start' : 'Start engine');
          sfx('ignition');
          api.speak(`Starting route to ${leg.to.name}. ${route.steps[0]?.text || ''}.`, 'nav');
          api.append(html`<p class="muted">Release the handbrake, select ${v.icon === 'motorbike' ? 'first gear' : 'D'}, check your blind spot, signal and pull away.</p>`);
          await api.next('Pull away');
        } else {
          await api.next(v.mode === 'bike' ? 'Clip in & ride' : 'Start walking');
          api.speak(`Starting route to ${leg.to.name}.`, 'nav');
        }
      },
    });
    return steps;
  },

  // ROAD: arrival ------------------------------------------------------------
  'road-post': async (runner, deps) => {
    const { leg } = runner;
    const v = VEHICLES[leg.vehicle];
    const next = deps.journey?.nextLeg?.();
    const steps = [];
    steps.push({
      title: 'Arrived',
      icon: '🏁',
      run: async (api) => {
        const hrs = runner.drivingS / 3600;
        const avg = (leg.path.length / 1000) / Math.max(0.01, hrs);
        const toTerminal = next && (next.mode === 'fly' || next.mode === 'sail');
        const parkText = toTerminal
          ? next.mode === 'fly'
            ? leg.rental
              ? 'Rental return: fuel topped up, keys handed back, inspection signed off. Shuttle to departures.'
              : 'Drop-off at Departures. Kerbside stopping only: unload and go.'
            : next.withVehicle
              ? 'Join the check-in lanes at the ferry terminal. Keep your vehicle registration ready.'
              : 'Long-stay parking at the cruise terminal, then porters take your luggage.'
          : v.mode === 'drive'
            ? 'Parked. Handbrake on, engine off, valuables out of sight.'
            : 'You made it!';
        api.show(html`<div class="trip-summary">
            <div class="ts-big">${(leg.path.length / 1000).toFixed(1)} km</div>
            <dl class="kv">
              <div><dt>Time on the road</dt><dd>${fmtDur(runner.drivingS)}</dd></div>
              <div><dt>Average speed</dt><dd>${avg.toFixed(0)} km/h</dd></div>
              ${runner.fuelUsed ? html`<div><dt>Fuel used</dt><dd>${runner.fuelUsed.toFixed(1)} L (${((runner.fuelUsed / (leg.path.length / 1000)) * 100).toFixed(1)} L/100 km)</dd></div>` : ''}
              ${runner.kcal ? html`<div><dt>Energy burned</dt><dd>${Math.round(runner.kcal)} kcal</dd></div>` : ''}
              ${v.co2gPerKm ? html`<div><dt>CO₂</dt><dd>${((v.co2gPerKm * leg.path.length) / 1e6).toFixed(1)} kg</dd></div>` : ''}
            </dl>
            <p>${parkText}</p>
          </div>`);
        if (!toTerminal) {
          const html2 = await arrivalCard(api, leg.to, deps.countries);
          api.append(html2);
        }
        await api.next(toTerminal ? (next.mode === 'fly' ? 'Head into the terminal' : 'To the terminal') : 'Done');
      },
    });
    return steps;
  },

  // AIR: departure -----------------------------------------------------------
  'air-pre': async (runner, deps) => {
    const { leg } = runner;
    const plan = leg.plan;
    const A = leg.from.airport;
    const B = leg.to.airport;
    const intl = A.iso !== B.iso;
    const passport = needsPassportControl(A.iso, B.iso);
    const r = rng(`${A.iata}${B.iata}${Math.floor(runner.ctx.clock.simMs / 86400000)}`);
    const [carrier, carrierName] = A.iso === 'US' || (!CARRIER[A.iso] && B.iso === 'US') ? US_CARRIERS[Math.floor(r() * 3)] : CARRIER[A.iso] || CARRIER[B.iso] || ['WF', 'Wayfarer Air'];
    const number = plan.distanceKm > 4500 ? 1 + Math.floor(r() * 299) : 300 + Math.floor(r() * 1700);
    const now = runner.ctx.clock.simMs;
    const lead = (intl ? 3 : 2) * 3600 * 1000;
    const std = Math.ceil((now + lead) / 300000) * 300000;
    const wide = plan.ac.seats > 200;
    const b = {
      carrier,
      carrierName,
      number,
      from: A.iata,
      to: B.iata,
      fromAirport: A,
      toAirport: B,
      std,
      sta: std + plan.blockS * 1000,
      boarding: std - (wide ? 50 : 35) * 60000,
      gateClose: std - 20 * 60000,
      gate: `${'ABCDEFGHK'[Math.floor(r() * 9)]}${1 + Math.floor(r() * 48)}`,
      terminal: 1 + Math.floor(r() * (A.iata === 'LHR' ? 5 : 3)),
      pnr: Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(r() * 32)]).join(''),
      seq: 10 + Math.floor(r() * 280),
      international: intl,
      cabin: 'economy',
      cabinName: 'Economy',
      cabinCode: 'Y',
      seat: '',
      group: 4,
      bagTag: '',
    };
    runner.booking = b;
    const T = (ms) => fmtTime(ms, A.tz);
    const steps = [];

    steps.push({
      title: 'Book',
      icon: '🎫',
      run: async (api) => {
        api.show(html`<div class="itinerary">
            <div class="it-row"><strong>${carrierName} ${carrier} ${number}</strong><span>${plan.ac.name}</span></div>
            <div class="it-route"><div><b>${A.iata}</b> ${T(std)}<small>${A.city}</small></div><span class="it-line">${fmtDur(plan.blockS)} · ${Math.round(plan.distanceKm).toLocaleString('en-US')} km</span><div><b>${B.iata}</b> ${fmtTime(b.sta, B.tz)}<small>${B.city}${fmtDate(b.sta, B.tz) !== fmtDate(std, A.tz) ? ` · ${fmtDate(b.sta, B.tz, { day: '2-digit', month: 'short' })}` : ''}</small></div></div>
            <div class="muted">Cruise FL${plan.cruiseFL} · ${plan.windKts >= 0 ? 'tailwind' : 'headwind'} ${Math.round(Math.abs(plan.windKts))} kt (live 250 hPa winds) · ${intl ? 'International' : 'Domestic'}</div>
          </div>
          <p class="muted">Choose your cabin. Fares are estimated from the distance band, like airline fare construction.</p>`);
        const cabins = [
          ['economy', 'Economy', 'Y', `${BAGGAGE.checkedKg} kg bag · standard seat`],
          ['premium', 'Premium Economy', 'W', '2 × 23 kg · extra legroom'],
          ['business', 'Business', 'J', 'Lie-flat seat · lounge · priority'],
          ...(plan.distanceKm > 5000 ? [['first', 'First', 'F', 'Private suite · chauffeur']] : []),
        ];
        const pick = await api.choose(
          cabins.map(([value, label, , sub]) => ({ value, label, sub: `${money(estimateFare(plan.distanceKm, value))} · ${sub}`, icon: { economy: '💺', premium: '🛋️', business: '🥂', first: '👑' }[value] })),
          { autoPick: 'economy' },
        );
        const c = cabins.find((x) => x[0] === pick);
        b.cabin = pick;
        b.cabinName = c[1];
        b.cabinCode = c[2];
        await api.pay(estimateFare(plan.distanceKm, pick), `${carrier}${number} ${A.iata}–${B.iata} ${c[1]}`);
        api.append(html`<div class="notice ok">Booking confirmed. Reference <b>${b.pnr}</b>. E-ticket sent.</div>`);
        await api.next('Online check-in');
      },
    });

    steps.push({
      title: 'Check-in & seat',
      icon: '💺',
      run: async (api) => {
        api.show(html`<p class="lead">Online check-in is open (24 h to 1 h before departure).</p>
          <dl class="kv">
            <div><dt>Passenger</dt><dd>${passengerName().last}/${passengerName().first}</dd></div>
            <div><dt>Passport</dt><dd>${flag(state.profile?.nationality)} ${state.profile?.passportNo || '—'}</dd></div>
            ${passport ? html`<div><dt>Entry requirements</dt><dd>Visa/eTA verified for ${flag(B.iso)} ${B.iso}</dd></div>` : ''}
          </dl>
          <p class="muted">Select a seat on the ${plan.ac.name}:</p>`);
        const seat = await seatMap(api, plan, b, r);
        b.seat = seat;
        const row = parseInt(seat, 10);
        b.group = b.cabin === 'business' || b.cabin === 'first' ? 1 : b.cabin === 'premium' ? 2 : row > 25 ? 3 : 4;
        api.show(boardingPassCard(b));
        sfx('success');
        await api.next('Go to the airport');
      },
    });

    steps.push({
      title: 'Bag drop',
      icon: '🧳',
      run: async (api) => {
        const allowance = b.cabin === 'economy' ? 1 : 2;
        const body = api.show(html`<p class="lead">Terminal ${b.terminal} · ${carrierName} bag drop</p>
          <p>Place your suitcase on the belt scale. Allowance: ${allowance} × ${BAGGAGE.checkedKg} kg checked, ${BAGGAGE.cabinKg} kg cabin bag.</p>
          <label class="slider-row">Suitcase weight <input type="range" min="8" max="34" step="0.5" value="19.5" class="bag-kg"> <output class="bag-out">19.5 kg</output></label>`);
        const input = $('.bag-kg', body);
        const out = $('.bag-out', body);
        input.oninput = () => (out.textContent = `${input.value} kg`);
        await api.next('Weigh bag');
        let kg = Number(input.value);
        if (kg > 32) {
          sfx('error');
          api.append(html`<div class="notice warn">${kg} kg is over the 32 kg safety limit: no airline will accept it. You repack into your cabin bag.</div>`);
          await api.wait(6 * 60, 'Repacking at the counter');
          kg = 31;
        }
        if (kg > BAGGAGE.checkedKg) {
          api.append(html`<div class="notice warn">Overweight: ${kg} kg (limit ${BAGGAGE.checkedKg} kg). Excess baggage fee applies.</div>`);
          await api.pay(75, 'Excess baggage');
        }
        const acct = ACCOUNTING[carrier] || String(100 + (hashString(carrier) % 900));
        b.bagTag = `0${acct}${String(Math.floor(r() * 1e6)).padStart(6, '0')}`;
        api.append(html`<p>Bag accepted at <b>${kg} kg</b>. Tagged through to <b>${B.iata}</b>.</p>`);
        api.append(bagTagCard(b));
        await api.wait(5 * 60, 'Bag drop queue');
        await api.next('To security');
      },
    });

    steps.push({ title: 'Security', icon: '🛡️', run: (api) => securityScreening(api, r) });

    if (passport) {
      steps.push({
        title: 'Passport control',
        icon: '🛂',
        run: async (api) => {
          api.show(html`<p class="lead">Emigration: departing ${flag(A.iso)} ${deps.countries.get(A.iso)?.name || A.iso}</p>
            <p>Have your passport open at the photo page and your boarding pass ready.</p>`);
          const lane = await api.choose(
            [
              { value: 'egate', label: 'e-Gates', sub: 'Biometric passports · face scan', icon: '🤖' },
              { value: 'desk', label: 'Officer desk', sub: 'All passports', icon: '🧑‍✈️' },
            ],
            { autoPick: 'egate' },
          );
          await api.wait((lane === 'egate' ? 4 : 14) * 60, lane === 'egate' ? 'e-Gate: look at the camera, remove glasses' : 'Queue for the officer');
          api.append(html`<div class="notice ok">Cleared for departure.</div>`);
          await api.next('Airside');
        },
      });
    }

    steps.push({
      title: 'Airside',
      icon: '🛍️',
      run: async (api) => {
        api.show(html`<p class="lead">Departures · Terminal ${b.terminal}</p>${fidsBoard(runner, b, deps)}`);
        const until = b.boarding - api.clock.simMs - 15 * 60000;
        const choice = await api.choose(
          [
            { value: 'lounge', label: b.cabin === 'economy' ? 'Lounge day pass ($45)' : 'Lounge (included)', sub: 'Quiet seats, food, showers', icon: '☕' },
            { value: 'dutyfree', label: 'Browse duty free', sub: 'Allowances apply on arrival', icon: '🛍️' },
            { value: 'gate', label: 'Go straight to the gate', sub: `Gate ${b.gate}`, icon: '🚶' },
          ],
          { autoPick: 'gate' },
        );
        if (choice === 'lounge' && b.cabin === 'economy') await api.pay(45, 'Lounge day pass');
        if (until > 0) await api.wait(until / 1000, choice === 'gate' ? `Waiting at gate ${b.gate}` : choice === 'lounge' ? 'Relaxing in the lounge' : 'Shopping airside', { detail: `Boarding at ${T(b.boarding)}` });
        api.append(html`<div class="notice">📢 “${carrierName} flight ${carrier} ${number} to ${B.city} is now boarding at gate ${b.gate}.”</div>`);
        api.speak(`${carrierName} flight ${carrier} ${number} to ${B.city} is now boarding at gate ${b.gate}.`, 'crew');
        await api.wait(Math.max(60, (b.boarding - api.clock.simMs) / 1000 + 600), `Walking to gate ${b.gate}`);
      },
    });

    steps.push({
      title: 'Boarding',
      icon: '🛫',
      run: async (api) => {
        api.show(html`<p class="lead">Gate ${b.gate} · Boarding by group</p>
          <ol class="groups">${[1, 2, 3, 4].map((g) => html`<li class="${g === b.group ? 'you' : ''}">Group ${g}${g === 1 ? ': Business, First & priority' : g === 2 ? ': Premium & elite' : g === 3 ? ': Rear rows' : ': Front rows'}${g === b.group ? ' ← you' : ''}</li>`)}</ol>`);
        await api.wait(Math.max(60, (b.group - 1) * 6 * 60), 'Waiting for your group to be called');
        await api.next('Scan boarding pass');
        sfx('beep');
        api.append(html`<div class="notice ok">✔ Boarding pass accepted · ${b.seat}</div>`);
        api.append(html`<p>Down the jet bridge, aircraft door ${wide ? '2L' : '1L'}. “Welcome aboard!” Find seat <b>${b.seat}</b>, bag in the overhead bin, seatbelt fastened.</p>`);
        await api.wait(Math.max(60, (b.std - api.clock.simMs) / 1000 - 6 * 60), 'Passengers boarding · stowing bags');
        api.append(html`<div class="notice">Doors closed. Cabin crew, arm doors and cross-check. Please switch portable electronic devices to flight mode.</div>`);
        const demo = `Ladies and gentlemen, welcome aboard ${carrierName} flight ${number} to ${B.city}. Please watch carefully as we demonstrate the safety features of this ${plan.ac.name}. Fasten your seatbelt by inserting the metal tip into the buckle. There are emergency exits on both sides of the aircraft. In the event of a loss of cabin pressure, oxygen masks will drop from the panel above. Pull the mask towards you, place it over your nose and mouth, and secure your own mask before helping others. Your life jacket is under your seat. Thank you for your attention.`;
        api.speak(demo, 'crew');
        api.append(html`<details class="safety"><summary>Safety demonstration</summary><p>${demo}</p></details>`);
        await api.next('Ready for pushback');
      },
    });
    return steps;
  },

  // AIR: arrival -------------------------------------------------------------
  'air-post': async (runner, deps) => {
    const { leg } = runner;
    const A = leg.from.airport;
    const B = leg.to.airport;
    const b = runner.booking;
    const passport = needsPassportControl(A.iso, B.iso);
    const customs = needsCustoms(A.iso, B.iso);
    const r = rng(`${b?.pnr || 'x'}arr`);
    const country = deps.countries.get(B.iso);
    const steps = [];
    steps.push({
      title: 'Deplane',
      icon: '🚪',
      run: async (api) => {
        const text = `Ladies and gentlemen, welcome to ${B.city}. The local time is ${fmtTime(api.clock.simMs, B.tz)}. Please remain seated with your seatbelt fastened until the captain switches off the seatbelt sign.`;
        api.speak(text, 'crew');
        api.show(html`<p class="lead">“${text}”</p>`);
        await api.wait(12 * 60, 'Disembarking and walking to arrivals');
      },
    });
    if (passport) {
      steps.push({
        title: 'Immigration',
        icon: '🛂',
        run: async (api) => {
          api.show(html`<p class="lead">Arrivals immigration · ${flag(B.iso)} ${country?.name || B.iso}</p>
            <p>Join the queue for ${state.profile?.nationality === B.iso ? 'citizens' : 'all other passports'}.</p>`);
          await api.wait((15 + Math.round(r() * 25)) * 60, 'Immigration queue');
          api.append(html`<p><b>Officer:</b> “Good ${new Date(api.clock.simMs).getUTCHours() < 12 ? 'morning' : 'afternoon'}. Passport, please. What is the purpose of your visit?”</p>`);
          await api.choose(
            [
              { value: 't', label: 'Tourism', icon: '📸' },
              { value: 'b', label: 'Business', icon: '💼' },
              { value: 'f', label: 'Visiting friends/family', icon: '🏠' },
              { value: 'x', label: 'Transit', icon: '🔁' },
            ],
            { autoPick: 't', columns: 2 },
          );
          api.append(html`<p><b>Officer:</b> “How long will you be staying?”</p>`);
          await api.choose(
            [
              { value: 'w', label: 'About a week' },
              { value: '2', label: 'Two weeks' },
              { value: 'm', label: 'A month' },
            ],
            { autoPick: 'w', columns: 3 },
          );
          api.append(html`<p><b>Officer:</b> “Enjoy your stay.” <i>Fingerprints scanned, photo taken, passport stamped.</i></p>`);
          await giveStamp(api, { iso: B.iso, country: country?.name || B.city, date: api.clock.simMs, port: B.iata, mode: 'fly', kind: 'entry' });
          await api.next('Baggage reclaim');
        },
      });
    }
    steps.push({
      title: 'Baggage reclaim',
      icon: '🧳',
      run: async (api) => {
        const belt = 1 + Math.floor(r() * 12);
        api.show(html`<p class="lead">Baggage reclaim · belt ${belt}</p><p>Flight ${b ? `${b.carrier} ${b.number}` : ''} from ${A.city}.</p>`);
        await api.wait((10 + Math.round(r() * 18)) * 60, `Waiting at belt ${belt}`);
        api.append(html`<div class="notice ok">Your suitcase appears${b?.bagTag ? html`: tag <code>${b.bagTag}</code> matches your receipt` : ''}.</div>`);
        await api.next(customs ? 'To customs' : 'To arrivals');
      },
    });
    if (customs) {
      steps.push({
        title: 'Customs',
        icon: '🛃',
        run: async (api) => {
          api.show(html`<p class="lead">Customs</p>
            <p>Green channel: nothing to declare (within duty-free allowances). Red channel: goods to declare, cash over the reporting limit (typically 10,000 USD/EUR), restricted food, plants or animals.</p>`);
          const ch = await api.choose(
            [
              { value: 'green', label: 'Nothing to declare', tone: 'green', icon: '🟢' },
              { value: 'red', label: 'Goods to declare', tone: 'red', icon: '🔴' },
            ],
            { autoPick: 'green' },
          );
          if (ch === 'red') {
            await api.wait(15 * 60, 'Declaring goods with a customs officer');
            api.append(html`<div class="notice ok">Declaration processed: items within allowance, no duty payable.</div>`);
          } else if (r() < 0.08) {
            api.append(html`<div class="notice warn">Random spot check: “Could you put your bag on the table, please?”</div>`);
            await api.wait(9 * 60, 'Bag inspection');
            api.append(html`<div class="notice ok">All clear. Thank you.</div>`);
          }
          await api.next('Arrivals hall');
        },
      });
    }
    steps.push({
      title: 'Welcome',
      icon: '👋',
      run: async (api) => {
        api.show(await arrivalCard(api, { ...leg.to, name: B.city, tz: B.tz }, deps.countries));
        await api.next('Continue');
      },
    });
    return steps;
  },

  // SEA: embarkation ---------------------------------------------------------
  'sea-pre': async (runner, deps) => {
    const { leg } = runner;
    const v = VEHICLES[leg.vehicle];
    const ferry = !!v.carDeck;
    const r = rng(`${leg.from.id}${leg.to.id}${Math.floor(runner.ctx.clock.simMs / 86400000)}`);
    const passport = needsPassportControl(leg.from.iso, leg.to.iso);
    // UK–France "juxtaposed controls": French border police check you at Dover, UK Border Force at Calais.
    const juxtaposed = ['DOV', 'CQF'].includes(leg.from.id) && ['DOV', 'CQF'].includes(leg.to.id);
    const nights = Math.max(1, Math.ceil(leg.durationS / 86400));
    const steps = [];
    runner.booking = { nights, cabin: '', deck: 0, muster: 'ABCDEF'[Math.floor(r() * 6)] };

    steps.push({
      title: ferry ? 'Ticket' : 'Cruise booking',
      icon: '🎫',
      run: async (api) => {
        if (ferry) {
          const km = leg.distanceM / 1000;
          const pax = Math.round(35 + km * 0.22);
          const car = leg.withVehicle ? Math.round(70 + km * 0.55) : 0;
          api.show(html`<p class="lead">${leg.from.label} → ${leg.to.label}</p>
            <dl class="kv"><div><dt>Crossing</dt><dd>${fmtDur(leg.durationS)} · ${(km / 1.852).toFixed(0)} nmi</dd></div>
            <div><dt>Vessel</dt><dd>${v.name}, ${v.serviceKnots} kn</dd></div>
            <div><dt>Fare</dt><dd>${money(pax)} foot passenger${leg.withVehicle ? html` + ${money(car)} car & driver` : ''}</dd></div></dl>`);
          await api.next('Buy ticket');
          await api.pay(pax + car, `Ferry ${leg.from.city}–${leg.to.city}`);
        } else {
          api.show(html`<p class="lead">${leg.from.label} → ${leg.to.label}</p>
            <dl class="kv"><div><dt>Voyage</dt><dd>${nights} night${nights > 1 ? 's' : ''} · ${(leg.distanceM / 1852).toFixed(0)} nautical miles</dd></div>
            <div><dt>Ship</dt><dd>${v.name} · service speed ${v.serviceKnots} kn</dd></div></dl>
            <p class="muted">Choose your stateroom (price per night, all meals included):</p>`);
          const base = v.icon === 'ship' && leg.vehicle === 'expedition' ? 650 : 140;
          const kinds = [
            ['interior', 'Interior', 1, '🛏️'],
            ['ocean', 'Ocean view', 1.35, '🪟'],
            ['balcony', 'Balcony', 1.8, '🌅'],
            ['suite', 'Suite', 3.4, '👑'],
          ];
          const pick = await api.choose(kinds.map(([value, label, m, icon]) => ({ value, label, icon, sub: `${money(base * m)}/night · ${money(base * m * nights)} total` })), { autoPick: 'interior' });
          const k = kinds.find((x) => x[0] === pick);
          runner.booking.cabin = k[1];
          runner.booking.deck = pick === 'interior' ? 4 + Math.floor(r() * 4) : pick === 'suite' ? 14 : 8 + Math.floor(r() * 5);
          runner.booking.stateroom = `${runner.booking.deck}${String(100 + Math.floor(r() * 300))}`;
          await api.pay(base * k[2] * nights, `Cruise ${leg.from.city}–${leg.to.city}, ${k[1]}`);
        }
      },
    });

    steps.push({
      title: 'Check-in',
      icon: '🧾',
      run: async (api) => {
        if (ferry) {
          const lane = 100 + Math.floor(r() * 140);
          const L = () => 'ABCDEFGHJKLMNPRSTVWXY'[Math.floor(r() * 21)];
          const plate = `${L()}${L()}${10 + Math.floor(r() * 89)} ${L()}${L()}${L()}`;
          api.show(html`<p class="lead">${leg.withVehicle ? 'Drive-up check-in booth' : 'Foot passenger check-in'}</p>
            <article class="doc ferry-card"><div class="fc-head">BOARDING CARD</div>
            <div class="fc-route">${leg.from.city.toUpperCase()} ➜ ${leg.to.city.toUpperCase()}</div>
            <dl class="kv"><div><dt>Passenger</dt><dd>${passengerName().last}/${passengerName().first}</dd></div>
            ${leg.withVehicle ? html`<div><dt>Vehicle</dt><dd>${plate}</dd></div><div><dt>Lane</dt><dd class="big">${lane}</dd></div>` : html`<div><dt>Gate</dt><dd>Foot passengers</dd></div>`}</dl></article>
            <p class="muted">Hang the boarding card from your rear-view mirror.</p>`);
          await api.wait(6 * 60, 'Check-in queue');
        } else {
          api.show(html`<p class="lead">Cruise terminal check-in</p>
            <ul class="checklist static"><li>Passport & travel documents checked</li><li>Health questionnaire completed</li><li>Photo taken for your cruise card</li><li>Credit card linked for onboard purchases</li></ul>
            <article class="doc seapass"><div class="sp-ship">${v.name.toUpperCase()}</div><div class="sp-name">${passengerName().first} ${passengerName().last}</div>
            <dl class="kv"><div><dt>Stateroom</dt><dd class="big">${runner.booking.stateroom}</dd></div><div><dt>Muster station</dt><dd class="big">${runner.booking.muster}</dd></div><div><dt>Dining</dt><dd>Main dining · 2nd seating</dd></div></dl></article>`);
          await api.wait(25 * 60, 'Check-in & photo');
        }
      },
    });

    if (passport && juxtaposed) {
      steps.push({
        title: 'Border control',
        icon: '🛂',
        run: async (api) => {
          const dest = deps.countries.get(leg.to.iso);
          api.show(html`<p class="lead">Juxtaposed controls</p><p>Under the Le Touquet Treaty, ${dest?.name || leg.to.iso} border officers check your passport here, before you sail, so you drive straight off on arrival.</p>`);
          await api.wait(10 * 60, `${dest?.name || ''} border control booth`);
          await giveStamp(api, { iso: leg.to.iso, country: dest?.name || leg.to.city, date: api.clock.simMs, port: leg.to.id, mode: 'sail', kind: 'entry' });
          runner.booking.stamped = true;
          await api.next('Continue');
        },
      });
    }

    steps.push({
      title: 'Security',
      icon: '🛡️',
      run: async (api) => {
        api.show(html`<p class="lead">Security screening</p><p>${ferry && leg.withVehicle ? 'Vehicles may be selected for a random search; passengers stay with their car.' : 'Hand luggage through X-ray, walk-through metal detector. No weapons, no irons, no candles.'}</p>`);
        await api.wait((ferry ? 5 : 12) * 60, 'Screening');
        if (ferry && leg.withVehicle && r() < 0.15) {
          api.append(html`<div class="notice warn">Your car is waved into the search bay.</div>`);
          await api.wait(8 * 60, 'Vehicle search');
        }
      },
    });

    steps.push({
      title: ferry ? 'Boarding' : 'Muster drill',
      icon: ferry ? '⛴️' : '🦺',
      run: async (api) => {
        if (ferry) {
          api.show(html`<p class="lead">${leg.withVehicle ? 'Drive up the ramp onto the car deck' : 'Walk the gangway onto the ship'}</p>
            <p>${leg.withVehicle ? 'Follow the crew’s hand signals. Engage the handbrake, leave the car in gear, switch off the alarm. Note your deck & stairway colour. The car decks are closed during the crossing.' : 'Find a seat in the lounge or out on deck.'}</p>`);
          await api.wait(Math.max(5, 20 * (leg.withVehicle ? 1 : 0.5)) * 60, 'Loading the ship');
          const brief = 'Ladies and gentlemen, welcome aboard. In an emergency you will hear seven short blasts and one long blast on the ship’s whistle. Make your way to your assembly station, where crew will issue life jackets.';
          api.speak(brief, 'crew');
          api.append(html`<div class="notice">“${brief}”</div>`);
        } else {
          api.show(html`<p class="lead">Mandatory safety drill (SOLAS)</p>
            <p>International law requires every passenger to attend the muster drill before the ship departs. Watch the safety video on your stateroom TV, then check in at muster station <b>${runner.booking.muster}</b>, Deck 5.</p>
            <ul class="checklist static"><li>General emergency alarm: seven short blasts, one long</li><li>Life jackets at the muster station</li><li>No elevators during an emergency</li></ul>`);
          await api.wait(20 * 60, `Checking in at muster station ${runner.booking.muster}`);
          api.append(html`<div class="notice ok">Your attendance has been recorded. Sail-away party on the pool deck!</div>`);
        }
        await api.next('Cast off');
      },
    });
    return steps;
  },

  // SEA: disembarkation -----------------------------------------------------
  'sea-post': async (runner, deps) => {
    const { leg } = runner;
    const passport = needsPassportControl(leg.from.iso, leg.to.iso) && !runner.booking?.stamped;
    const country = deps.countries.get(leg.to.iso);
    const ferry = !!VEHICLES[leg.vehicle].carDeck;
    const steps = [];
    steps.push({
      title: 'Disembark',
      icon: '🚪',
      run: async (api) => {
        api.show(html`<p class="lead">${ferry && leg.withVehicle ? 'Return to your vehicle when called. Wait for crew signals to drive off.' : 'Disembarkation by colour group. Collect your luggage in the terminal.'}</p>`);
        await api.wait((ferry ? 15 : 45) * 60, ferry ? 'Unloading the car deck' : 'Disembarking');
      },
    });
    if (passport) {
      steps.push({
        title: 'Immigration',
        icon: '🛂',
        run: async (api) => {
          api.show(html`<p class="lead">Arrival immigration · ${flag(leg.to.iso)} ${country?.name || leg.to.iso}</p>`);
          await api.wait(20 * 60, 'Passport check');
          await giveStamp(api, { iso: leg.to.iso, country: country?.name || leg.to.city, date: api.clock.simMs, port: leg.to.id, mode: 'sail', kind: 'entry' });
          await api.next('Continue');
        },
      });
    }
    steps.push({
      title: 'Welcome',
      icon: '👋',
      run: async (api) => {
        api.show(await arrivalCard(api, { ...leg.to, name: leg.to.city || leg.to.name }, deps.countries));
        await api.next('Continue');
      },
    });
    return steps;
  },
};

// ── Interactive pieces ────────────────────────────────────────────────────

/** Seat map with a realistic cabin layout for the aircraft. */
function seatMap(api, plan, b, r) {
  const layouts = {
    a320neo: [
      { cabin: 'business', rows: [1, 3], cols: 'AC_DF' },
      { cabin: 'economy', rows: [4, 30], cols: 'ABC_DEF' },
    ],
    b787: [
      { cabin: 'business', rows: [1, 8], cols: 'A_DG_K' },
      { cabin: 'premium', rows: [20, 24], cols: 'AC_DEF_HK' },
      { cabin: 'economy', rows: [30, 56], cols: 'ABC_DEF_HJK' },
    ],
    a350ulr: [
      { cabin: 'business', rows: [11, 27], cols: 'A_DG_K' },
      { cabin: 'premium', rows: [31, 41], cols: 'AC_DEFG_HK' },
    ],
  };
  let blocks = layouts[plan.aircraft] || layouts.a320neo;
  const want = b.cabin === 'first' ? 'business' : b.cabin;
  let mine = blocks.filter((x) => x.cabin === want);
  if (!mine.length) mine = blocks.filter((x) => x.cabin === 'premium').length ? blocks.filter((x) => x.cabin === 'premium') : blocks;
  blocks = mine;
  api.append(html`<div class="seat-legend"><span class="seat window">A</span> Window <span class="seat aisle">C</span> Aisle <span class="seat">B</span> Middle <span class="seat taken">·</span> Occupied</div>`);
  const container = api.append(html`<div class="seatmap" role="grid" aria-label="Seat map"></div>`);
  return new Promise((resolve) => {
    const free = [];
    for (const blk of blocks) {
      const head = el(html`<div class="sm-head">${blk.cols.split('').map((c) => html`<span>${c === '_' ? '' : c}</span>`)}</div>`);
      container.appendChild(head);
      for (let row = blk.rows[0]; row <= blk.rows[1]; row++) {
        if (row === 13 && plan.aircraft !== 'a350ulr') continue; // many airlines skip row 13
        const line = el(html`<div class="sm-row" data-row="${row}"></div>`);
        for (const c of blk.cols) {
          if (c === '_') {
            line.appendChild(el(html`<span class="aisle">${row}</span>`));
            continue;
          }
          const taken = r() < 0.62;
          const seat = `${row}${c}`;
          const kind = c === 'A' || c === blk.cols.replace(/_/g, '').slice(-1) ? 'window' : blk.cols[blk.cols.indexOf(c) - 1] === '_' || blk.cols[blk.cols.indexOf(c) + 1] === '_' ? 'aisle' : 'middle';
          const btn = el(html`<button class="seat ${kind} ${taken ? 'taken' : ''}" ${taken ? raw('disabled') : ''} title="${seat} · ${kind}" aria-label="Seat ${seat}, ${kind}${taken ? ', occupied' : ''}">${c}</button>`);
          if (!taken) {
            free.push(btn);
            btn.onclick = () => {
              sfx('beep');
              $$('.seat', container).forEach((s) => (s.disabled = true));
              btn.classList.add('mine');
              setTimeout(() => resolve(seat), 350);
            };
          }
          line.appendChild(btn);
        }
        container.appendChild(line);
      }
    }
    if (state.settings.autoChecks && free.length) setTimeout(() => free.find((x) => x.classList.contains('window'))?.click() || free[0].click(), 1200);
  });
}

/** Security checkpoint: decide where each item goes. */
async function securityScreening(api, r) {
  const ct = r() < 0.35; // newer CT scanners: laptops & liquids may stay in the bag
  const items = [
    { id: 'laptop', icon: '💻', label: 'Laptop', ok: ct ? ['own', 'bag'] : ['own'] },
    { id: 'liquids', icon: '🧴', label: 'Liquids bag (≤100 ml each, 1 L clear bag)', ok: ct ? ['own', 'bag'] : ['own'] },
    { id: 'water', icon: '🥤', label: '500 ml bottle of water', ok: ['bin'] },
    { id: 'belt', icon: '👖', label: 'Belt with metal buckle', ok: ['tray'] },
    { id: 'pockets', icon: '🔑', label: 'Phone, keys & coins', ok: ['tray'] },
    { id: 'jacket', icon: '🧥', label: 'Jacket', ok: ['tray'] },
    { id: 'passport', icon: '🛂', label: 'Passport & boarding pass', ok: ['keep'] },
  ];
  const choices = [
    ['keep', 'Keep'],
    ['tray', 'Tray'],
    ['own', 'Own tray'],
    ['bag', 'In bag'],
    ['bin', 'Bin'],
  ];
  const body = api.show(html`<p class="lead">Security checkpoint ${ct ? '· CT scanner lane' : '· conventional X-ray'}</p>
    <p class="muted">${ct ? 'This lane has computed-tomography scanners: laptops and liquids may stay in your bag.' : 'Laptops and the liquids bag must go in a separate tray. Liquids over 100 ml are not allowed.'}</p>
    <div class="trays">${items.map(
      (it) => html`<div class="tray-item" data-id="${it.id}"><span class="ti-label">${it.icon} ${it.label}</span><span class="ti-opts">${choices.map(([v, l]) => html`<button class="chip" data-v="${v}">${l}</button>`)}</span></div>`,
    )}</div>`);
  const picks = {};
  $$('.tray-item', body).forEach((row) => {
    $$('.chip', row).forEach((chip) =>
      chip.addEventListener('click', () => {
        $$('.chip', row).forEach((c) => c.classList.remove('on'));
        chip.classList.add('on');
        picks[row.dataset.id] = chip.dataset.v;
        sfx('beep');
      }),
    );
  });
  if (state.settings.autoChecks) {
    items.forEach((it, i) => setTimeout(() => $(`.tray-item[data-id="${it.id}"] .chip[data-v="${it.ok[0]}"]`, body)?.click(), 200 * (i + 1)));
  }
  await api.wait(10 * 60, 'Security queue');
  for (;;) {
    await api.next('Send trays through the X-ray', { autoMs: 2200 });
    if (items.every((it) => picks[it.id])) break;
    api.toast('Place every item first');
  }
  const wrong = items.filter((it) => !it.ok.includes(picks[it.id]));
  api.append(html`<p>Walk through the body scanner: arms up… ${wrong.some((w) => ['belt', 'pockets'].includes(w.id)) ? html`<b>BEEP.</b> Pat-down search.` : 'clear.'}</p>`);
  if (wrong.length) {
    sfx('error');
    api.append(html`<div class="notice warn">Your bag was pulled for a manual search: ${wrong.map((w) => w.label.toLowerCase()).join(', ')}.</div>`);
    await api.wait(9 * 60, 'Secondary search');
  } else {
    sfx('success');
    api.append(html`<div class="notice ok">Perfect screening. Trays through on the first pass.</div>`);
  }
  await api.next('Continue');
}

/** Split-flap style departures board with real carriers to real destinations. */
function fidsBoard(runner, b, deps) {
  const A = b.fromAirport;
  const r = rng(`${A.iata}${Math.floor(b.std / 3600000)}`);
  const others = AIRPORTS.filter((x) => x.iata !== A.iata && x.iata !== b.to);
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const to = others[Math.floor(r() * others.length)];
    const [cc] = CARRIER[A.iso] && r() < 0.5 ? CARRIER[A.iso] : CARRIER[to.iso] || ['WF'];
    const t = b.std + Math.round((r() * 4 - 1.5) * 3600000 / 300000) * 300000;
    rows.push({ t, flt: `${cc} ${100 + Math.floor(r() * 1800)}`, to: to.city, gate: `${'ABCDEFGHK'[Math.floor(r() * 9)]}${1 + Math.floor(r() * 48)}` });
  }
  rows.push({ t: b.std, flt: `${b.carrier} ${b.number}`, to: b.toAirport.city, gate: b.gate, you: true });
  rows.sort((x, y) => x.t - y.t);
  const now = runner.ctx.clock.simMs;
  const status = (t) => (t < now - 600000 ? 'DEPARTED' : t - now < 20 * 60000 ? 'GATE CLOSED' : t - now < 50 * 60000 ? 'BOARDING' : t - now < 120 * 60000 ? 'GO TO GATE' : 'ON TIME');
  void deps;
  return html`<table class="fids"><thead><tr><th>Time</th><th>Flight</th><th>Destination</th><th>Gate</th><th>Remarks</th></tr></thead><tbody>
    ${rows.map((x) => html`<tr class="${x.you ? 'you' : ''}"><td>${fmtTime(x.t, A.tz)}</td><td>${x.flt}</td><td>${x.to.toUpperCase()}</td><td>${x.gate}</td><td>${status(x.t)}</td></tr>`)}
  </tbody></table>`;
}
