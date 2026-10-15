// Simulation engine: a sim clock with time acceleration, and one runner per
// leg type. Runners are written as async state machines that await sim-time
// (`ctx.until`, `ctx.wait`) so real-world processes read top to bottom.
// No DOM here: runners publish telemetry and events through ctx.
import { MS_PER_KNOT, headingDelta, normalizeLon } from './geo.js';
import { VEHICLES } from './data/vehicles.js';
import { drivesOnLeft, fuelPrice, needsPassportControl } from './data/countries-info.js';
import { flightPhase } from './flight.js';
import { harbourZoneM } from './planner.js';

export const TIME_SCALES = [1, 10, 60, 300, 1800, 7200];

export class Clock {
  constructor(startMs = Date.now()) {
    this.simMs = startMs;
    this.scale = 60;
    this.paused = false;
    this.waiters = new Set();
    this.tickers = new Set();
  }

  /** Advance by real milliseconds. Large jumps are stepped so physics stays stable. */
  tick(realMs) {
    if (this.paused) return;
    const simDt = (Math.min(realMs, 250) / 1000) * this.scale;
    this.advance(simDt);
  }

  /** Advance sim time by `s` seconds, feeding tickers in ≤ 1 s sub-steps. */
  advance(s) {
    let left = s;
    while (left > 1e-9) {
      const h = Math.min(1, left);
      // Stop the step at the next waiter deadline so events land on time.
      let next = h;
      for (const w of this.waiters) next = Math.min(next, Math.max(0, (w.at - this.simMs) / 1000));
      const step = Math.max(Math.min(h, next), 1e-3);
      this.simMs += step * 1000;
      left -= step;
      for (const t of [...this.tickers]) {
        if (t.fn(step) === true) {
          this.tickers.delete(t);
          t.resolve();
        }
      }
      for (const w of [...this.waiters]) {
        if (this.simMs >= w.at - 0.5) {
          this.waiters.delete(w);
          w.resolve();
        }
      }
      if (!this.tickers.size && !this.waiters.size) {
        this.simMs += left * 1000;
        break;
      }
    }
  }

  /** Promise resolved after `s` sim seconds. */
  wait(s) {
    return new Promise((resolve) => this.waiters.add({ at: this.simMs + s * 1000, resolve }));
  }

  /** Promise resolved once fn(dtSeconds) returns true; fn runs every sub-step. */
  until(fn) {
    return new Promise((resolve) => this.tickers.add({ fn, resolve }));
  }

  /** Seconds until the next pending wait (for "skip waiting"). */
  nextWaitS() {
    let best = Infinity;
    for (const w of this.waiters) best = Math.min(best, (w.at - this.simMs) / 1000);
    return best;
  }

  /** Jump to the next pending wait instantly. */
  skipWait() {
    const s = this.nextWaitS();
    if (Number.isFinite(s) && s > 0) this.advance(s);
  }

  cancelAll() {
    this.waiters.clear();
    this.tickers.clear();
  }
}

/** Shared bookkeeping for all runners. */
class Runner {
  constructor(leg, ctx) {
    this.leg = leg;
    this.ctx = ctx;
    this.v = VEHICLES[leg.vehicle];
    this.d = 0;
    this.speed = 0; // m/s
    this.heading = leg.path.headingAt(0);
    this.country = ctx.countries.lookup(leg.from.coord);
    this.lastLookupD = -Infinity;
    this.lastLon = leg.path.coords[0][0];
    this.lastLat = leg.path.coords[0][1];
    this.status = '';
    this.stopReason = null;
    this.cancelled = false;
  }

  get pos() {
    return this.leg.path.at(this.d).pos;
  }

  telemetry() {
    return {
      mode: this.leg.mode,
      vehicle: this.leg.vehicle,
      pos: this.pos,
      heading: this.heading,
      speedMs: this.speed,
      d: this.d,
      total: this.leg.path.length,
      status: this.status,
      country: this.country,
    };
  }

  /** Country, equator, date-line and polar-circle crossings. */
  geoEvents(lookupEveryM = 1000) {
    const p = this.pos;
    if (this.d - this.lastLookupD >= lookupEveryM) {
      this.lastLookupD = this.d;
      const c = this.ctx.countries.lookup(p);
      if (c && (!this.country || c.iso !== this.country.iso)) {
        const prev = this.country;
        this.country = c;
        this.ctx.emit('country', { from: prev, to: c, mode: this.leg.mode, pos: p });
        this.onCountryChange?.(prev, c);
      }
    }
    if (Math.sign(p[1]) !== Math.sign(this.lastLat) && this.lastLat !== 0) this.ctx.emit('crossing', { kind: 'equator' });
    for (const [lat, kind] of [[66.5634, 'arctic'], [-66.5634, 'antarctic'], [23.4366, 'cancer'], [-23.4366, 'capricorn']]) {
      if ((this.lastLat - lat) * (p[1] - lat) < 0) this.ctx.emit('crossing', { kind });
    }
    // Unwrapped longitudes: crossing any odd multiple of 180° is the antimeridian.
    if (Math.floor((this.lastLon + 180) / 360) !== Math.floor((p[0] + 180) / 360)) this.ctx.emit('crossing', { kind: 'dateline', eastbound: p[0] > this.lastLon });
    this.lastLon = p[0];
    this.lastLat = p[1];
  }
}

// ── Road: car, SUV, EV, motorbike, bicycle, walking ───────────────────────
export class RoadRunner extends Runner {
  constructor(leg, ctx) {
    super(leg, ctx);
    const v = this.v;
    this.fuel = v.tankL ? v.tankL * 0.9 : null;
    this.battery = v.batteryKWh ? v.batteryKWh * 0.9 : null;
    this.stepIdx = 0;
    this.drivingS = 0;
    this.sinceBreakS = 0;
    this.kcal = 0;
    this.cost = 0;
    this.fuelUsed = 0;
    this.gear = 'P';
    this.leftHand = drivesOnLeft(this.country?.iso);
    this.announced = new Set();
  }

  get nextStep() {
    const steps = this.leg.route.steps;
    while (this.stepIdx < steps.length - 1 && steps[this.stepIdx + 1].along <= this.d + 1) this.stepIdx++;
    return steps[Math.min(this.stepIdx + 1, steps.length - 1)];
  }

  get currentStep() {
    return this.leg.route.steps[this.stepIdx];
  }

  targetSpeed() {
    const { route, path } = this.leg;
    const seg = path.segmentAt(this.d);
    let t = route.speeds[seg] || 13;
    const v = this.v;
    if (v.mode === 'bike') t = Math.min(t, v.cruiseKmh / 3.6) * (0.85 + 0.3 * Math.sin(this.d / 900) ** 2);
    else if (v.mode === 'walk') t = v.cruiseKmh / 3.6;
    else {
      // OSRM speeds are segment averages; cruise slightly above on open road.
      t = t > 20 ? t * 1.06 : t;
      t = Math.min(t, v.topSpeedKmh / 3.6);
    }
    // Slow for upcoming turns, roundabouts and the destination.
    const next = this.nextStep;
    if (next) {
      const toTurn = next.along - this.d;
      const sharp = ['turn', 'end of road', 'roundabout', 'rotary', 'fork', 'off ramp', 'arrive'].includes(next.type);
      if (sharp && toTurn < 120) t = Math.min(t, Math.max(5, toTurn / 10));
    }
    return Math.max(1.2, t);
  }

  async run() {
    const { ctx, v } = this;
    this.status = 'Pre-departure checks';
    await ctx.protocol('road-pre', this);
    this.gear = v.mode === 'drive' && v.icon !== 'motorbike' ? 'D' : '';
    ctx.emit('depart', { leg: this.leg });
    this.status = this.currentStep.text;
    await ctx.clock.until((dt) => this.update(dt));
    this.speed = 0;
    this.gear = 'P';
    this.status = 'Arrived';
    ctx.emit('arrive', { leg: this.leg, runner: this });
    await ctx.protocol('road-post', this);
  }

  /** One physics sub-step. Returns true on arrival. */
  update(dt) {
    if (this.cancelled) return true;
    if (this.stopUntil) {
      if (this.ctx.clock.simMs < this.stopUntil) {
        this.speed = Math.max(0, this.speed - 4 * dt);
        return false;
      }
      this.finishStop();
    }
    const { path } = this.leg;
    const target = this.targetSpeed();
    const accel = this.v.mode === 'drive' ? (this.v.icon === 'motorbike' ? 3.5 : 2.6) : 0.6;
    const dv = target - this.speed;
    this.speed += Math.max(-4.5 * dt, Math.min(accel * dt, dv));
    const step = this.speed * dt;
    this.d = Math.min(path.length, this.d + step);
    const targetHeading = path.headingAt(this.d, 25);
    this.heading = (this.heading + headingDelta(this.heading, targetHeading) * Math.min(1, dt * 3) + 360) % 360;
    this.drivingS += dt;
    this.sinceBreakS += dt;
    this.consume(step, dt);
    this.geoEvents(800);
    this.turnByTurn();
    this.checkStops();
    return this.d >= path.length - 0.5;
  }

  consume(m, dt) {
    const v = this.v;
    const kmh = this.speed * 3.6;
    if (v.lPer100) {
      // Consumption rises with aerodynamic drag above ~90 km/h; idling in towns costs too.
      const f = kmh < 50 ? 1.15 : 1 + Math.max(0, (kmh - 90) / 100) * 0.7;
      const l = (m / 100000) * v.lPer100 * f;
      this.fuel -= l;
      this.fuelUsed += l;
    } else if (v.kWhPer100) {
      const f = kmh < 50 ? 0.9 : 1 + Math.max(0, (kmh - 90) / 100) * 0.8;
      this.battery -= (m / 100000) * v.kWhPer100 * f;
    } else if (v.mode === 'bike') {
      this.kcal += (8.0 * 75 * dt) / 3600; // MET 8 × 75 kg
    } else if (v.mode === 'walk') {
      this.kcal += (3.5 * 75 * dt) / 3600;
    }
  }

  turnByTurn() {
    const next = this.nextStep;
    if (!next) return;
    const toGo = next.along - this.d;
    this.status = this.currentStep.text;
    for (const [m, tag] of [[1000, 'far'], [250, 'near']]) {
      const key = `${this.stepIdx}:${tag}`;
      if (toGo <= m && toGo > 30 && !this.announced.has(key) && next.type !== 'new name') {
        this.announced.add(key);
        const dist = tag === 'far' ? 'In 1 kilometre' : `In ${Math.round(toGo / 50) * 50} metres`;
        this.ctx.emit('voice', { text: `${dist}, ${next.text.charAt(0).toLowerCase()}${next.text.slice(1)}`, priority: 1 });
      }
    }
  }

  checkStops() {
    const v = this.v;
    const remaining = this.leg.path.length - this.d;
    if (remaining < 5000) return;
    if (this.fuel !== null && this.fuel < v.tankL * 0.12) {
      return this.stop('refuel', 7 * 60, `Refuelling: low fuel warning (${Math.round(this.fuel)} L left)`);
    }
    if (this.battery !== null && this.battery < v.batteryKWh * 0.1) {
      return this.stop('charge', 28 * 60, 'Supercharging 10% → 80%');
    }
    // UK Highway Code / EU guidance: a 15-minute break every 2 hours of driving.
    if (v.mode === 'drive' && this.sinceBreakS > 2 * 3600) return this.stop('break', 15 * 60, 'Rest break: 15 minutes every 2 hours behind the wheel');
    if (v.mode === 'bike' && this.sinceBreakS > 90 * 60) return this.stop('break', 12 * 60, 'Water & snack stop');
    if (v.mode === 'walk' && this.sinceBreakS > 75 * 60) return this.stop('break', 10 * 60, 'Short rest');
  }

  stop(reason, seconds, label) {
    this.stopReason = reason;
    this.stopUntil = this.ctx.clock.simMs + seconds * 1000;
    this.status = label;
    this.ctx.emit('stop', { reason, label, seconds });
    // Register a waiter so "skip waiting" jumps to the end of the stop.
    this.ctx.clock.wait(seconds);
  }

  finishStop() {
    const v = this.v;
    const iso = this.country?.iso;
    if (this.stopReason === 'refuel') {
      const litres = v.tankL - this.fuel;
      const price = fuelPrice(iso);
      const cost = litres * price;
      this.fuel = v.tankL;
      this.cost += cost;
      this.ctx.emit('expense', { amount: cost, label: `Fuel: ${litres.toFixed(1)} L at $${price.toFixed(2)}/L`, category: 'fuel' });
    } else if (this.stopReason === 'charge') {
      const kwh = v.batteryKWh * 0.8 - this.battery;
      this.battery = v.batteryKWh * 0.8;
      const cost = kwh * 0.45;
      this.cost += cost;
      this.ctx.emit('expense', { amount: cost, label: `Charging: ${kwh.toFixed(0)} kWh`, category: 'fuel' });
    } else if (this.stopReason === 'border') {
      this.ctx.emit('border-cleared', { country: this.country });
    }
    if (this.stopReason === 'break' || this.stopReason === 'charge' || this.stopReason === 'refuel') this.sinceBreakS = 0;
    this.stopReason = null;
    this.stopUntil = null;
  }

  /** Land border crossed: driving side changes and border posts. */
  onCountryChange(from, to) {
    const left = drivesOnLeft(to.iso);
    if (left !== this.leftHand) {
      this.leftHand = left;
      this.ctx.emit('voice', { text: `You are now in ${to.name}. Drive on the ${left ? 'left' : 'right'}.`, priority: 2 });
    }
    if (from && needsPassportControl(from.iso, to.iso)) {
      this.stop('border', (20 + Math.round(Math.random() * 25)) * 60, `Border control: ${from.name} → ${to.name}. Passports, vehicle registration & insurance.`);
    }
  }

  telemetry() {
    const t = super.telemetry();
    const next = this.nextStep;
    return {
      ...t,
      fuel: this.fuel,
      battery: this.battery,
      gear: this.speed < 0.3 && this.stopUntil ? 'P' : this.gear,
      nextStep: next,
      toNextM: next ? Math.max(0, next.along - this.d) : 0,
      etaS: this.etaS(),
      kcal: this.kcal,
      stopped: !!this.stopUntil,
      stopReason: this.stopReason,
      stopLeftS: this.stopUntil ? (this.stopUntil - this.ctx.clock.simMs) / 1000 : 0,
      leftHand: this.leftHand,
      drivingS: this.drivingS,
    };
  }

  etaS() {
    const { route, path } = this.leg;
    const frac = 1 - this.d / path.length;
    return route.durationS * frac;
  }
}

// ── Air ───────────────────────────────────────────────────────────────────
export class FlightRunner extends Runner {
  constructor(leg, ctx) {
    super(leg, ctx);
    this.plan = leg.plan;
    this.altFt = 0;
    this.phase = 'At gate';
    this.seatbelt = true;
    this.events = new Set();
  }

  async run() {
    const { ctx, plan } = this;
    this.status = 'Airport departure procedures';
    await ctx.protocol('air-pre', this);

    this.phase = 'Pushback';
    this.status = 'Pushback & engine start';
    ctx.emit('voice', { text: 'Cabin crew, arm doors and cross-check.', priority: 2, voice: 'crew' });
    await ctx.clock.wait(4 * 60);
    this.phase = 'Taxi';
    this.status = `Taxiing to the runway. ${plan.ac.name}`;
    this.speed = 8;
    await ctx.clock.wait(plan.taxiOutS - 4 * 60);
    ctx.emit('voice', { text: 'Cabin crew, please be seated for take-off.', priority: 2, voice: 'pilot' });
    await ctx.clock.until((dt) => this.update(dt));
    this.phase = 'Taxi to gate';
    this.status = 'Taxiing to the gate';
    this.speed = 7;
    this.altFt = 0;
    ctx.emit('arrive', { leg: this.leg, runner: this });
    await ctx.clock.wait(plan.taxiInS);
    this.speed = 0;
    this.phase = 'At gate';
    ctx.emit('chime', { kind: 'seatbelt-off' });
    await ctx.protocol('air-post', this);
  }

  update(dt) {
    if (this.cancelled) return true;
    const { plan } = this;
    const gs = plan.groundSpeedAt(this.d) * MS_PER_KNOT;
    this.speed = gs;
    this.d = Math.min(plan.path.length, this.d + gs * dt);
    this.heading = plan.path.headingAt(this.d, 3000);
    const prevAlt = this.altFt;
    this.altFt = plan.altitudeAt(this.d);
    const phase = flightPhase(plan, this.d);
    if (phase !== this.phase) {
      this.phase = phase;
      this.ctx.emit('flight-phase', { phase, runner: this });
      this.cabinEvent(phase);
    }
    // Seatbelt sign: off passing 10,000 ft in the climb, on passing it in the descent.
    if (prevAlt < 10000 && this.altFt >= 10000 && this.d < plan.tod) this.once('belt-off', () => {
      this.seatbelt = false;
      this.ctx.emit('chime', { kind: 'seatbelt-off' });
      this.ctx.emit('voice', { text: 'The captain has switched off the fasten seat belt sign. You may now move about the cabin, but we recommend you keep your seat belt fastened while seated.', voice: 'crew' });
    });
    if (prevAlt > 10000 && this.altFt <= 10000 && this.d > plan.tod) this.once('belt-on', () => {
      this.seatbelt = true;
      this.ctx.emit('chime', { kind: 'seatbelt-on' });
      this.ctx.emit('voice', { text: 'Cabin crew, please prepare the cabin for landing.', voice: 'pilot' });
    });
    if (phase === 'Cruise' && this.d > plan.climbM + 250000) this.once('meal', () => {
      this.ctx.emit('cabin', { text: plan.airborneS > 4 * 3600 ? 'Meal service begins. Chicken or beef?' : 'Drinks and snack service' });
    });
    this.status = `${phase} · FL${Math.round(this.altFt / 100).toString().padStart(3, '0')}`;
    this.geoEvents(25000);
    return this.d >= plan.path.length - 0.5;
  }

  once(key, fn) {
    if (!this.events.has(key)) {
      this.events.add(key);
      fn();
    }
  }

  cabinEvent(phase) {
    const { plan, ctx } = this;
    if (phase === 'Takeoff roll') ctx.emit('sound', { kind: 'takeoff' });
    if (phase === 'Cruise') {
      this.once('cruise', () =>
        ctx.emit('voice', {
          voice: 'pilot',
          text: `Ladies and gentlemen, this is your captain speaking. We've reached our cruising altitude of ${plan.cruiseFt.toLocaleString('en-US')} feet. Flight time to ${plan.to.city} is ${fmtHM(plan.remainingS(this.d))}. ${Math.abs(plan.windKts) > 15 ? `We have a ${Math.round(Math.abs(plan.windKts))}-knot ${plan.windKts > 0 ? 'tailwind' : 'headwind'}. ` : ''}Sit back, relax and enjoy the flight.`,
        }),
      );
    }
    if (phase === 'Descent') {
      this.once('tod', () =>
        ctx.emit('voice', {
          voice: 'pilot',
          text: `Ladies and gentlemen, we have begun our descent into ${plan.to.city}. Please return to your seats, put your seat backs upright and stow your tray tables.`,
        }),
      );
    }
    if (phase === 'Landing rollout') ctx.emit('sound', { kind: 'touchdown' });
  }

  telemetry() {
    const t = super.telemetry();
    const { plan } = this;
    return {
      ...t,
      altFt: this.altFt,
      phase: this.phase,
      tasKts: this.phase === 'Taxi' || this.phase === 'Pushback' || this.phase === 'At gate' ? this.speed / MS_PER_KNOT : plan.tasAt(this.d),
      gsKts: this.speed / MS_PER_KNOT,
      vsFpm: this.vsFpm(),
      etaS: (this.d > 0 ? plan.remainingS(this.d) : plan.airborneS) + plan.taxiInS,
      seatbelt: this.seatbelt,
      plan,
    };
  }

  vsFpm() {
    const { plan } = this;
    if (this.d <= 0) return 0;
    const ahead = Math.min(plan.path.length, this.d + 1000);
    const gs = Math.max(1, this.speed);
    return ((plan.altitudeAt(ahead) - plan.altitudeAt(this.d)) / ((ahead - this.d) / gs)) * 60;
  }
}

// ── Sea ───────────────────────────────────────────────────────────────────
export class SeaRunner extends Runner {
  constructor(leg, ctx) {
    super(leg, ctx);
    this.harbourM = harbourZoneM(leg.path.length);
    this.pilot = true;
    this.lastNoonDay = null;
    this.distSinceNoon = 0;
  }

  async run() {
    const { ctx } = this;
    this.status = 'Terminal check-in & embarkation';
    await ctx.protocol('sea-pre', this);
    this.status = 'Singling up lines. One prolonged blast.';
    ctx.emit('sound', { kind: 'horn' });
    await ctx.clock.wait(10 * 60);
    await ctx.clock.until((dt) => this.update(dt));
    this.speed = 0;
    this.status = 'All fast. Gangway down.';
    ctx.emit('sound', { kind: 'horn' });
    ctx.emit('arrive', { leg: this.leg, runner: this });
    await ctx.clock.wait(20 * 60);
    await ctx.protocol('sea-post', this);
  }

  update(dt) {
    if (this.cancelled) return true;
    const L = this.leg.path.length;
    const inHarbour = this.d < this.harbourM || L - this.d < this.harbourM;
    const target = (inHarbour ? 8 : this.v.serviceKnots) * MS_PER_KNOT;
    this.speed += Math.max(-0.05 * dt, Math.min(0.03 * dt, target - this.speed));
    const step = this.speed * dt;
    this.d = Math.min(L, this.d + step);
    this.distSinceNoon += step;
    const targetHeading = this.leg.path.headingAt(this.d, 400);
    this.heading = (this.heading + headingDelta(this.heading, targetHeading) * Math.min(1, dt * 0.15) + 360) % 360;
    if (this.pilot && this.d > this.harbourM) {
      this.pilot = false;
      this.ctx.emit('cabin', { text: 'Pilot disembarked at the pilot station. The ship is now under the command of the Master.' });
    }
    if (!this.pilot && L - this.d < this.harbourM) {
      this.pilot = true;
      this.ctx.emit('cabin', { text: 'Harbour pilot embarked. Reducing to harbour speed.' });
    }
    this.noonReport();
    this.status = inHarbour ? 'Harbour transit under pilotage' : `At sea · ${(this.speed / MS_PER_KNOT).toFixed(1)} kn`;
    this.geoEvents(5000);
    return this.d >= L - 0.5;
  }

  /** Masters broadcast the ship's position at local (solar) noon every day at sea. */
  noonReport() {
    const p = this.pos;
    const solar = new Date(this.ctx.clock.simMs + (normalizeLon(p[0]) / 15) * 3600000);
    const day = solar.toISOString().slice(0, 10);
    if (solar.getUTCHours() === 12 && this.lastNoonDay !== day && this.d > this.harbourM) {
      if (this.lastNoonDay !== null) this.ctx.emit('noon', { pos: p, nmRun: this.distSinceNoon / 1852, speedKn: this.speed / MS_PER_KNOT, runner: this });
      this.lastNoonDay = day;
      this.distSinceNoon = 0;
    }
  }

  telemetry() {
    const t = super.telemetry();
    const L = this.leg.path.length;
    return {
      ...t,
      knots: this.speed / MS_PER_KNOT,
      cog: this.heading,
      nmToGo: (L - this.d) / 1852,
      etaS: Math.max(0, (L - this.d) / Math.max(1, this.v.serviceKnots * MS_PER_KNOT)),
      pilot: this.pilot,
    };
  }
}

export function runnerFor(leg, ctx) {
  if (leg.mode === 'fly') return new FlightRunner(leg, ctx);
  if (leg.mode === 'sail') return new SeaRunner(leg, ctx);
  return new RoadRunner(leg, ctx);
}

export function fmtHM(s) {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} hour${h === 1 ? '' : 's'} ${m} minute${m === 1 ? '' : 's'}` : `${m} minute${m === 1 ? '' : 's'}`;
}
