// Wayfarer: entry point. Wires the globe, planner, journey runner, HUD,
// protocols and passport together and runs the game loop.
import { $, $$, html } from './dom.js';
import { state, save, spend, visit, addStamp, unlock, addXp, ACHIEVEMENTS, earn } from './store.js';
import { GlobeMap } from './map.js';
import { CountryIndex, flag } from './countries.js';
import { Clock, TIME_SCALES, runnerFor } from './sim.js';
import { Hud } from './hud.js';
import { ProtocolSheet, fmtDur, fmtTime, money } from './protocols.js';
import { Planner, renderExplore, renderPassport, renderSettings, applySettings, onboarding, toast, modal, openLandmark } from './ui.js';
import { engineSound, speak, sfx, stopEngine, hushVoice } from './audio.js';
import { LANDMARKS } from './data/landmarks.js';
import { VEHICLES } from './data/vehicles.js';
import { needsPassportControl } from './data/countries-info.js';
import { distance, normalizeLon, formatCoord } from './geo.js';
import { weatherAt, reverseLocality, wikiNearby } from './services.js';
import { MODES } from './planner.js';

const clock = new Clock(Date.now());
clock.scale = state.settings.timeScale || 60;

let countries = null;
let map = null;
let planner = null;
let journey = null;
let lastTz; // last known local time zone, kept after a journey ends
const hud = new Hud($('#hud'));

// ── Boot ──────────────────────────────────────────────────────────────────
async function boot() {
  const countriesP = fetch(new URL('./data/countries.json', import.meta.url))
    .then((r) => r.json())
    .then((fc) => new CountryIndex(fc));
  map = new GlobeMap('map', {
    onReady: () => {
      applySettings(map);
      $('#loading')?.classList.add('gone');
    },
  });
  map.onUserMove = () => ($('#recenter').hidden = false);
  window.wayfarer = {
    clock,
    get map() {
      return map;
    },
    get journey() {
      return journey;
    },
    state,
  };
  countries = await countriesP;

  bindTabs();
  bindControls();
  renderProfileChip();
  if (!state.profile) onboarding(countries, startPlanner);
  else startPlanner();
  requestAnimationFrame(loop);
  // Gentle idle spin of the globe until the player picks a route.
  idleSpin();
}

function idleSpin() {
  const step = () => {
    if (!journey && map?.ready && map.map.getZoom() < 3 && !map.map.isMoving() && !document.hidden && !map.userMoved) {
      const c = map.map.getCenter();
      map.map.setCenter([c.lng + 0.04, c.lat]);
    }
    requestAnimationFrame(step);
  };
  setTimeout(step, 1500);
  map.map.on('mousedown', () => (map.userMoved = true));
}

function startPlanner() {
  renderProfileChip();
  planner = new Planner($('#tab-plan'), { map, onStart: startJourney });
  if (state.profile?.home && map?.ready) map.flyTo(state.profile.home.coord, { zoom: 10.5, pitch: 40, duration: 5000 });
  else if (state.profile?.home) map.map.once('load', () => map.flyTo(state.profile.home.coord, { zoom: 10.5, pitch: 40, duration: 5000 }));
}

function renderProfileChip() {
  const p = state.profile;
  $('#profile').innerHTML = String(
    html`<span class="pc-flag">${p ? flag(p.nationality) : '🌐'}</span><span class="pc-name">${p?.name || 'Guest'}</span
      ><span class="pc-wallet">${money(state.wallet)}</span>`,
  );
}

function bindTabs() {
  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('on', x === t));
      $$('.tab-panel').forEach((p) => (p.hidden = p.id !== `tab-${t.dataset.tab}`));
      if (t.dataset.tab === 'explore') renderExplore($('#tab-explore'), { map, countries, onTravel: travelTo });
      if (t.dataset.tab === 'passport') renderPassport($('#tab-passport'), { countries });
      if (t.dataset.tab === 'settings') renderSettings($('#tab-settings'), { map, onReset: () => location.reload() });
      $('#panel').classList.remove('collapsed');
    }),
  );
  $('#panel-toggle').onclick = () => $('#panel').classList.toggle('collapsed');
}

function travelTo(place) {
  $$('.tab')
    .find((t) => t.dataset.tab === 'plan')
    .click();
  planner.setDestination(place);
  toast(`${place.name} added to your trip`);
}

// ── Controls: time, camera ────────────────────────────────────────────────
function bindControls() {
  const ts = $('#timescale');
  ts.innerHTML = TIME_SCALES.map(
    (s) =>
      `<button class="ts ${s === clock.scale ? 'on' : ''}" data-s="${s}" title="1 real second = ${label(s)}">${s === 1 ? 'Real time' : `×${s.toLocaleString('en-US')}`}</button>`,
  ).join('');
  $$('.ts', ts).forEach((b) =>
    b.addEventListener('click', () => {
      clock.scale = Number(b.dataset.s);
      state.settings.timeScale = clock.scale;
      save();
      $$('.ts', ts).forEach((x) => x.classList.toggle('on', x === b));
    }),
  );
  $('#pause').onclick = () => {
    clock.paused = !clock.paused;
    $('#pause').textContent = clock.paused ? '▶' : '❚❚';
    $('#pause').setAttribute('aria-label', clock.paused ? 'Resume' : 'Pause');
  };
  $$('.cam').forEach((b) =>
    b.addEventListener('click', () => {
      map.cameraMode = b.dataset.cam;
      map.userMoved = false;
      $('#recenter').hidden = true;
      $$('.cam').forEach((x) => x.classList.toggle('on', x === b));
    }),
  );
  $('#recenter').onclick = () => {
    map.userMoved = false;
    $('#recenter').hidden = true;
  };
  $('#abort').onclick = () => {
    if (journey && confirm('End this journey here? Progress so far is kept.')) journey.abort();
  };
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === ' ' && journey) {
      e.preventDefault();
      $('#pause').click();
    }
    if (/^[1-6]$/.test(e.key) && journey) $$('.ts')[Number(e.key) - 1]?.click();
    if (e.key.toLowerCase() === 'c' && journey) {
      const cams = $$('.cam');
      const i = cams.findIndex((c) => c.classList.contains('on'));
      cams[(i + 1) % cams.length].click();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hushVoice();
  });
}

function label(s) {
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${s / 60} min`;
  return `${s / 3600} h`;
}

// ── Journey ───────────────────────────────────────────────────────────────
class Journey {
  constructor(legs, stops) {
    this.legs = legs;
    this.stops = stops;
    this.index = -1;
    this.runner = null;
    this.done = [];
    this.modes = new Set();
    this.aborted = false;
    this.startMs = clock.simMs;
    this.lastLocality = 0;
    this.lastNearby = { pos: null, t: 0 };
    this.seenNearby = new Set();
    this.ctx = {
      clock,
      countries,
      emit: (type, detail) => this.onEvent(type, detail),
      protocol: (name, runner) => sheet.run(name, runner),
      localTz: undefined,
      legStartMs: clock.simMs,
    };
  }

  nextLeg() {
    return this.legs[this.index + 1];
  }

  async run() {
    document.body.classList.add('journeying');
    map.follow = true;
    map.userMoved = false;
    for (let i = 0; i < this.legs.length && !this.aborted; i++) {
      this.index = i;
      const leg = this.legs[i];
      this.ctx.legStartMs = clock.simMs;
      const r = runnerFor(leg, this.ctx);
      this.runner = r;
      const v = VEHICLES[leg.vehicle];
      map.setVehicle(v.icon, leg.path.coords[0]);
      map.camBearing = r.heading;
      this.renderLegs();
      this.refreshPlace(true);
      try {
        await r.run();
      } catch (err) {
        if (!this.aborted) {
          console.error(err);
          toast(`Something went wrong: ${err.message}`, { tone: 'warn' });
        }
        break;
      }
      if (this.aborted) break;
      this.completeLeg(leg, r);
    }
    this.finish();
  }

  completeLeg(leg, r) {
    const km = leg.path.length / 1000;
    const s = state.stats;
    const v = VEHICLES[leg.vehicle];
    this.modes.add(leg.mode === 'motorbike' ? 'drive' : leg.mode);
    if (leg.mode === 'fly') {
      s.flyKm += km;
      s.flights++;
      s.co2kg += (v.co2gPerPaxKm * km) / 1000;
      this.achieve('first-flight');
      if (km > 12000) this.achieve('long-haul');
    } else if (leg.mode === 'sail') {
      s.sailKm += km;
      s.voyages++;
      s.co2kg += (v.co2gPerPaxKm * km) / 1000;
      this.achieve('first-voyage');
      if (leg.path.coords.some(([x, y]) => (x > -80 && x < -79.4 && y > 8.9 && y < 9.4) || (x > 32.2 && x < 32.6 && y > 29.9 && y < 31.3)))
        this.achieve('canal');
    } else if (v.mode === 'bike') {
      s.bikeKm += km;
      this.achieve('first-ride');
    } else if (v.mode === 'walk') {
      s.walkKm += km;
    } else {
      s.driveKm += km;
      s.co2kg += (v.co2gPerKm * km) / 1000;
      this.achieve('first-drive');
      if (s.driveKm >= 1609) this.achieve('road-1000');
    }
    s.hours += (clock.simMs - this.ctx.legStartMs) / 3600000;
    addXp(km * (leg.mode === 'fly' ? 0.2 : leg.mode === 'sail' ? 1 : 2));
    const c = countries.lookup(leg.to.coord) || countries.get(leg.to.iso);
    if (c) visit(c, clock.simMs);
    this.checkCountryAchievements();
    this.done.push(leg.path.coords);
    save();
    renderProfileChip();
  }

  finish() {
    document.body.classList.remove('journeying');
    map.follow = false;
    stopEngine();
    hud.clear();
    $('#placecard').hidden = true;
    const last = this.legs[this.index];
    if (!this.aborted && this.modes.size >= 3) this.achieve('multimodal');
    journey = null;
    $('#legs').innerHTML = '';
    if (!this.aborted && last) {
      sfx('success');
      const totalKm = this.legs.reduce((s, l) => s + l.path.length, 0) / 1000;
      modal(
        html`<div class="finish">
          <div class="ob-hero">🏁</div>
          <h2>You've arrived in ${last.to.name}</h2>
          <p>
            ${Math.round(totalKm).toLocaleString('en-US')} km by
            ${[...this.modes].map((m) => MODES[m]?.label.toLowerCase() || m).join(', ')} in ${fmtDur((clock.simMs - this.startMs) / 1000)}
            of travel time.
          </p>
          <p class="muted">Local time ${fmtTime(clock.simMs, this.ctx.localTz)} · Wallet ${money(state.wallet)}</p>
        </div>`,
      );
      if (last.to.kind === 'landmark' || LANDMARKS.some((l) => distance(l.coord, last.to.coord) < 3000)) {
        const lm = LANDMARKS.find((l) => distance(l.coord, last.to.coord) < 3000);
        if (lm) setTimeout(() => openLandmark(lm, { map, onTravel: travelTo }), 1200);
      }
      planner.stops = [last.to, null];
      planner.gaps = [{ mode: 'auto', vehicle: 'sedan' }];
      planner.legs = null;
      planner.render();
    } else {
      planner.render();
    }
    renderProfileChip();
  }

  abort() {
    this.aborted = true;
    if (this.runner) this.runner.cancelled = true;
    clock.cancelAll();
    $('#sheet').hidden = true;
    $('#sheet').innerHTML = '';
    map.removeVehicle();
    hushVoice();
    this.finish();
  }

  achieve(id) {
    const a = unlock(id, clock.simMs);
    if (a) {
      sfx('success');
      toast(`🏆 Achievement unlocked: ${a[0]} ${a[1]}`, { ms: 6000, tone: 'gold' });
    }
  }

  checkCountryAchievements() {
    const n = Object.keys(state.visited).length;
    const c = Object.keys(state.continents).length;
    if (n >= 5) this.achieve('five-countries');
    if (n >= 20) this.achieve('twenty-countries');
    if (c >= 3) this.achieve('three-continents');
    if (c >= 7) this.achieve('seven-continents');
  }

  onEvent(type, d) {
    const scale = clock.scale;
    switch (type) {
      case 'country': {
        if (d.mode === 'fly') {
          toast(`✈️ Now flying over ${flag(d.to.iso)} ${d.to.name}`);
        } else if (d.mode !== 'sail') {
          toast(`${flag(d.to.iso)} Welcome to ${d.to.name}`, { ms: 5000 });
          if (d.from) {
            state.stats.borders++;
            this.achieve('border');
            if (!needsPassportControl(d.from.iso, d.to.iso)) {
              // Open border (Schengen, CTA): no stop, just the sign.
              const first = visit(d.to, clock.simMs);
              if (first) toast(`🎉 New country: ${d.to.name} (+250 XP)`);
            }
          }
          this.checkCountryAchievements();
        }
        break;
      }
      case 'border-cleared': {
        const c = d.country;
        addStamp({ iso: c.iso, country: c.name, date: clock.simMs, port: 'LAND BORDER', mode: 'drive', kind: 'entry' });
        sfx('stamp');
        const first = visit(c, clock.simMs);
        toast(`🛂 Entry stamp: ${flag(c.iso)} ${c.name}${first ? ' · new country (+250 XP)' : ''}`, { ms: 5000 });
        this.checkCountryAchievements();
        break;
      }
      case 'crossing': {
        const msg = {
          equator: ['🌐 Crossing the Equator: welcome to the other hemisphere!', 'equator'],
          dateline: [`📅 Crossing the International Date Line: the calendar jumps ${d.eastbound ? 'back' : 'forward'} a day`, 'dateline'],
          arctic: ['🧊 Crossing the Arctic Circle (66°34′N)', 'arctic'],
          antarctic: ['🐧 Crossing the Antarctic Circle (66°34′S)', 'antarctic'],
          cancer: ['☀️ Crossing the Tropic of Cancer', null],
          capricorn: ['☀️ Crossing the Tropic of Capricorn', null],
        }[d.kind];
        if (msg) {
          toast(msg[0], { ms: 6000 });
          if (msg[1]) this.achieve(msg[1]);
        }
        break;
      }
      case 'voice':
        // Turn-by-turn at high time compression would be a babble: keep it for ≤ ×60.
        if (d.voice || scale <= 60 || d.priority >= 2) speak(d.text, { kind: d.voice || 'nav', priority: d.priority || 0 });
        if (d.voice) toast(`📢 ${d.text}`, { ms: 7000 });
        break;
      case 'chime':
        sfx(d.kind);
        break;
      case 'sound':
        sfx(d.kind);
        break;
      case 'cabin':
        toast(`ℹ️ ${d.text}`, { ms: 6000 });
        break;
      case 'stop':
        toast(`⏸ ${d.label}`, { ms: 5000 });
        break;
      case 'expense':
        if (!spend(d.amount, d.label, clock.simMs)) {
          // Cards can go into overdraft at the pump; record it anyway.
          state.wallet -= d.amount;
          state.ledger.unshift({ date: clock.simMs, amount: -d.amount, label: `${d.label} (overdraft)` });
          save();
        }
        toast(`💳 ${money(d.amount)} · ${d.label}`);
        renderProfileChip();
        break;
      case 'noon':
        this.noonReport(d);
        break;
      case 'flight-phase':
        if (d.phase === 'Takeoff roll') toast(`🛫 ${d.runner.plan.ac.name}: take-off from ${d.runner.plan.from.iata}`);
        if (d.phase === 'Landing rollout') toast(`🛬 Touchdown at ${d.runner.plan.to.iata}`);
        break;
      default:
    }
  }

  async noonReport(d) {
    let wx = null;
    try {
      wx = await weatherAt(d.pos);
    } catch {
      // keep going without weather
    }
    const text = `Good afternoon, this is the Captain with our noon report. Our position is ${formatCoord(d.pos)}. In the last twenty-four hours we have covered ${Math.round(d.nmRun)} nautical miles at an average of ${(d.nmRun / 24).toFixed(1)} knots.${wx ? ` Outside it is ${Math.round(wx.tempC)} degrees with ${wx.text.toLowerCase()} and winds of ${Math.round(wx.windKmh / 1.852)} knots.` : ''} Enjoy your day at sea.`;
    toast(`⚓ Noon report: ${formatCoord(d.pos)} · ${Math.round(d.nmRun)} nmi run`, { ms: 8000 });
    speak(text, { kind: 'pilot' });
  }

  renderLegs() {
    $('#legs').innerHTML = String(
      html`<ol class="leg-progress">
        ${this.legs.map(
          (l, i) =>
            html`<li class="${i < this.index ? 'done' : i === this.index ? 'now' : ''}" title="${l.from.name} → ${l.to.name}">
              <span>${MODES[l.mode]?.icon || '•'}</span><small>${l.to.name}</small>
            </li>`,
        )}
      </ol>`,
    );
  }

  /** Location card: country, nearest town (reverse geocoded), local time and live weather. */
  async refreshPlace(force = false) {
    const t = this.runner?.telemetry();
    if (!t) return;
    const now = performance.now();
    if (!force && now - this.lastLocality < 20000) return;
    this.lastLocality = now;
    const pos = [normalizeLon(t.pos[0]), t.pos[1]];
    const [wx, loc] = await Promise.all([
      weatherAt(pos).catch(() => null),
      t.mode === 'fly' && t.altFt > 10000 ? null : reverseLocality(pos),
    ]);
    if (wx) this.ctx.localTz = lastTz = wx.timezone;
    this.place = { wx, loc };
  }

  /** Discover notable places along the way via Wikipedia geosearch. */
  async nearby(t) {
    if (t.mode === 'fly' && t.altFt > 3000) return;
    const now = performance.now();
    const pos = [normalizeLon(t.pos[0]), t.pos[1]];
    if (now - this.lastNearby.t < 25000) return;
    if (this.lastNearby.pos && distance(pos, this.lastNearby.pos) < 8000) return;
    this.lastNearby = { pos, t: now };
    try {
      const list = await wikiNearby(pos, 8000, 6);
      const fresh = list.find((x) => !this.seenNearby.has(x.title));
      if (fresh) {
        this.seenNearby.add(fresh.title);
        const node = toastLink(`📍 Nearby: <b>${escapeHtml(fresh.title)}</b> · ${(fresh.distM / 1000).toFixed(1)} km`, () =>
          map.flyTo(fresh.coord, { zoom: 15.5, pitch: 60, duration: 2500 }),
        );
        void node;
      }
    } catch {
      // geosearch is optional
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toastLink(htmlText, onClick) {
  const root = $('#toasts');
  const t = document.createElement('button');
  t.className = 'toast link in';
  t.innerHTML = htmlText;
  t.onclick = () => {
    map.cameraMode = 'free';
    $$('.cam').forEach((x) => x.classList.toggle('on', x.dataset.cam === 'free'));
    onClick();
  };
  root.appendChild(t);
  setTimeout(() => t.remove(), 9000);
  return t;
}

const sheet = new ProtocolSheet($('#sheet'), {
  clock,
  toast,
  get countries() {
    return countries;
  },
  get journey() {
    return journey;
  },
});

function startJourney(legs, stops) {
  if (journey) return;
  $('#wiki').hidden = true;
  journey = new Journey(legs, stops);
  $('#panel').classList.add('collapsed');
  journey.run();
}

// ── Landmark proximity (visiting) ─────────────────────────────────────────
let lastLandmarkCheck = 0;
function checkLandmarks(t) {
  const now = performance.now();
  if (now - lastLandmarkCheck < 1000) return;
  lastLandmarkCheck = now;
  if (t.mode === 'fly' && t.altFt > 1500) return;
  const pos = [normalizeLon(t.pos[0]), t.pos[1]];
  for (const l of LANDMARKS) {
    if (state.landmarks[l.id]) continue;
    if (Math.abs(l.coord[1] - pos[1]) > 0.05) continue;
    if (distance(l.coord, pos) < 1500) {
      state.landmarks[l.id] = clock.simMs;
      addXp(150);
      earn(25, `Travel photo sold: ${l.name}`, clock.simMs);
      save();
      sfx('success');
      toast(`📸 Landmark visited: ${l.name} (+150 XP, +$25 photo sale)`, { ms: 6000, tone: 'gold' });
      if (Object.keys(state.landmarks).length >= 10) journey?.achieve('landmarks10');
    }
  }
}

// ── Game loop ─────────────────────────────────────────────────────────────
let lastFrame = performance.now();
let lastDone = 0;
function loop(now) {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  clock.tick(dt * 1000);
  const r = journey?.runner;
  if (r && map?.ready) {
    const t = r.telemetry();
    map.frame(t, clock.paused ? 1 : clock.scale, dt);
    hud.update(t, journey.ctx);
    if (now - lastDone > 400) {
      lastDone = now;
      map.showDone([...journey.done, r.leg.path.slice(0, r.d)]);
      renderPlaceCard(t);
      journey.refreshPlace();
      journey.nearby(t);
    }
    checkLandmarks(t);
    const sheetOpen = !$('#sheet').hidden;
    const kind =
      sheetOpen || clock.paused
        ? 'none'
        : t.mode === 'fly'
          ? t.d > 0 || t.phase === 'Taxi'
            ? 'jet'
            : 'none'
          : t.mode === 'sail'
            ? t.speedMs > 0.5
              ? 'ship'
              : 'none'
            : VEHICLES[t.vehicle].mode === 'drive'
              ? 'car'
              : VEHICLES[t.vehicle].mode === 'bike'
                ? 'bike'
                : 'none';
    engineSound(kind, t.speedMs, t.altFt || 0);
  }
  if (map?.ready) map.updateDaylight(new Date(clock.simMs));
  renderClock();
  $('#skipwait').hidden = !(journey && Number.isFinite(clock.nextWaitS()) && clock.nextWaitS() > 30 && $('#sheet').hidden);
  requestAnimationFrame(loop);
}

function renderClock() {
  const tz = journey?.ctx.localTz || lastTz;
  const c = $('#clock');
  const txt = fmtTime(clock.simMs, tz);
  if (c.dataset.t !== txt) {
    c.dataset.t = txt;
    c.textContent = txt;
  }
}

function renderPlaceCard(t) {
  const card = $('#placecard');
  const p = journey.place;
  card.hidden = false;
  const c = t.country;
  const high = t.mode === 'fly' && t.altFt > 10000;
  const loc = high ? null : p?.loc;
  const wx = p?.wx;
  const where = high ? `Over ${c ? c.name : 'the ocean'}` : t.mode === 'sail' && !loc?.locality ? 'At sea' : loc?.locality || c?.name || '';
  card.innerHTML = String(
    html` <div class="pcard-flag">${c ? flag(c.iso) : t.mode === 'sail' ? '🌊' : '🌐'}</div>
      <div class="pcard-main">
        <b>${where}</b>
        <small>${[loc?.region, c?.name].filter((x, i, a) => x && a.indexOf(x) === i).join(', ')}</small>
      </div>
      <div class="pcard-side">
        <b>${fmtTime(clock.simMs, journey.ctx.localTz)}</b>
        <small>${wx ? `${wx.icon} ${Math.round(wx.tempC)}°C` : ''}</small>
      </div>`,
  );
}

$('#skipwait').onclick = () => clock.skipWait();

boot().catch((err) => {
  console.error(err);
  $('#loading').innerHTML =
    `<div class="boot-error"><h2>Wayfarer couldn't start</h2><p>${escapeHtml(err.message)}</p><p>Check your connection and reload.</p></div>`;
});

export { clock, ACHIEVEMENTS };
