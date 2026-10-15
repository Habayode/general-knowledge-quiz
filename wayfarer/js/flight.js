// Flight planning and vertical/speed profile. Pure module, unit-tested.
//
// Real-world conventions modelled:
//  • Great-circle routing between airport reference points.
//  • Semicircular (RVSM) cruising levels: eastbound tracks (000–179°) fly odd
//    thousands (FL350, 370, 390...), westbound tracks even (FL340, 360...).
//  • Climb ≈ 4.2 NM per 1,000 ft; descent on a 3° path ≈ 3 NM per 1,000 ft
//    plus ~10 NM to decelerate. Short sectors cap the cruise level so both fit.
//  • 250 kt below 10,000 ft, then climb speed blending into cruise Mach.
//  • Winds aloft (250 hPa, from Open-Meteo) give a tail/headwind component.
import { KM_PER_NM, MS_PER_KNOT, Path, bearing, distance, greatCircle, speedOfSound } from './geo.js';
import { VEHICLES } from './data/vehicles.js';

const FT = 0.3048;

/** Highest semicircular flight level not above `maxFL` for a given true track. */
export function semicircularLevel(trackDeg, maxFL) {
  const east = trackDeg >= 0 && trackDeg < 180;
  let fl = Math.floor(maxFL / 10) * 10;
  // East: odd tens of FL in thousands of feet (e.g. 350, 370); West: even (340, 360).
  while (fl > 0 && ((fl / 10) % 2 === 1) !== east) fl -= 10;
  return Math.max(east ? 30 : 40, fl);
}

/** Cruise true airspeed (kt): cruise Mach at altitude; 250 kt rule below FL100. */
export function cruiseTasAt(cruiseFt, ac) {
  if (cruiseFt <= 10000) return 250 * (1 + 0.02 * (cruiseFt / 1000));
  return (ac.cruiseMach * speedOfSound(cruiseFt * FT)) / MS_PER_KNOT;
}

/** True airspeed in knots at altitude (ft) for the climb/descent schedule. */
export function scheduleTas(altFt, ac, cruiseFt) {
  const cruiseTas = cruiseTasAt(cruiseFt, ac);
  if (altFt <= 10000) {
    // 250 KIAS below FL100; TAS rises ~2 %/1,000 ft. Blend from V2 near the ground.
    const tas250 = 250 * (1 + 0.02 * (altFt / 1000));
    const k = Math.min(1, altFt / 3000);
    return ac.v2Kts + (tas250 - ac.v2Kts) * k;
  }
  const at10 = 250 * 1.2;
  const f = Math.min(1, (altFt - 10000) / Math.max(1, cruiseFt - 10000));
  return at10 + (cruiseTas - at10) * f;
}

/**
 * Build a flight plan.
 * @param {object} from  airport { iata, coord }
 * @param {object} to    airport
 * @param {object} opts  { aircraft: key, windKts: along-track component (+tail) }
 */
export function planFlight(from, to, { aircraft, windKts = 0 } = {}) {
  const ac = VEHICLES[aircraft];
  if (!ac || ac.mode !== 'fly') throw new Error(`Unknown aircraft ${aircraft}`);
  const coords = greatCircle(from.coord, to.coord, 25000);
  const path = new Path(coords);
  const distM = path.length;
  const distNm = distM / 1000 / KM_PER_NM;
  const track = bearing(from.coord, to.coord);

  // Highest level whose climb + descent fit in ~85 % of the sector.
  const fitFL = Math.floor(((distNm * 0.85) / (4.2 + 3.0)) * 10);
  const maxFL = Math.min(ac.cruiseFL[ac.cruiseFL.length - 1], fitFL);
  const cruiseFL = semicircularLevel(track, Math.max(maxFL, 60));
  const cruiseFt = cruiseFL * 100;

  const takeoffRollM = 2200;
  const landingRollM = 1600;
  const climbM = Math.min(distM * 0.45, (cruiseFt / 1000) * 4.2 * KM_PER_NM * 1000);
  const descentM = Math.min(distM * 0.45, ((cruiseFt / 1000) * 3.0 + 10) * KM_PER_NM * 1000);
  const tod = distM - descentM; // top of descent

  const cruiseTas = cruiseTasAt(cruiseFt, ac);
  const wind = Math.max(-180, Math.min(220, windKts));

  /** Altitude (ft) at distance d along the track. */
  function altitudeAt(d) {
    if (d <= takeoffRollM || d >= distM - landingRollM) return 0;
    if (d < climbM) return cruiseFt * Math.pow((d - takeoffRollM) / (climbM - takeoffRollM), 0.7);
    if (d > tod) return cruiseFt * ((distM - landingRollM - d) / (descentM - landingRollM));
    return cruiseFt;
  }

  /** True airspeed (kt) at distance d. */
  function tasAt(d) {
    if (d <= takeoffRollM) return Math.max(20, ac.v2Kts * Math.sqrt(d / takeoffRollM));
    if (d >= distM - landingRollM) {
      const f = (distM - d) / landingRollM;
      return 15 + (ac.approachKts - 15) * Math.sqrt(Math.max(0, f));
    }
    const alt = altitudeAt(d);
    if (d >= tod) {
      // Final ~10 NM: slow to approach speed.
      const toGo = distM - landingRollM - d;
      const finalM = 10 * KM_PER_NM * 1000;
      const sched = Math.min(cruiseTas, scheduleTas(alt, ac, cruiseFt));
      if (toGo < finalM) return ac.approachKts + (sched - ac.approachKts) * (toGo / finalM);
      return sched;
    }
    if (d < climbM) return Math.min(cruiseTas, scheduleTas(alt, ac, cruiseFt));
    return cruiseTas;
  }

  /** Ground speed (kt): wind scales in with altitude. */
  function groundSpeedAt(d) {
    const alt = altitudeAt(d);
    return Math.max(10, tasAt(d) + wind * Math.min(1, alt / cruiseFt));
  }

  // Integrate airborne time (s) at 500 m resolution for schedules and ETAs.
  const STEP = 500;
  const n = Math.ceil(distM / STEP);
  const timeAt = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const d = Math.min(distM, i * STEP);
    const mid = d - STEP / 2;
    timeAt[i] = timeAt[i - 1] + (d - (i - 1) * STEP) / (groundSpeedAt(mid) * MS_PER_KNOT);
  }
  const airborneS = timeAt[n];
  const taxiOutS = (distM > 1500000 ? 18 : 14) * 60;
  const taxiInS = 8 * 60;

  return {
    from,
    to,
    aircraft,
    ac,
    coords,
    path,
    distanceKm: distM / 1000,
    distanceNm: distNm,
    track,
    cruiseFL,
    cruiseFt,
    cruiseTas,
    cruiseMach: ac.cruiseMach,
    windKts: wind,
    climbM,
    tod,
    takeoffRollM,
    landingRollM,
    taxiOutS,
    taxiInS,
    airborneS,
    blockS: taxiOutS + airborneS + taxiInS,
    altitudeAt,
    tasAt,
    groundSpeedAt,
    /** Seconds airborne remaining from distance d. */
    remainingS(d) {
      const i = Math.min(n, Math.max(0, Math.floor(d / STEP)));
      return Math.max(0, airborneS - timeAt[i]);
    },
    fuelKg: ac.burnKgPerH * (airborneS / 3600) * 1.05 + 2500,
  };
}

/** Flight phase label (ATC/airline terminology) at distance d. */
export function flightPhase(plan, d) {
  if (d <= 0) return 'Taxi';
  if (d < plan.takeoffRollM) return 'Takeoff roll';
  const alt = plan.altitudeAt(d);
  if (d < plan.climbM) return alt < 10000 ? 'Initial climb' : 'Climb';
  if (d < plan.tod) return 'Cruise';
  if (d >= plan.path.length - plan.landingRollM) return 'Landing rollout';
  const toGo = plan.path.length - plan.landingRollM - d;
  if (toGo < 18520) return 'Final approach';
  if (alt < 10000) return 'Approach';
  return 'Descent';
}

/** Along-track wind component (kt, + = tailwind) from wind "from" direction and speed. */
export function alongTrackWind(trackDeg, windFromDeg, windKts) {
  const toward = (windFromDeg + 180) % 360;
  return windKts * Math.cos(((toward - trackDeg) * Math.PI) / 180);
}

/** Economy fare estimate in USD (distance-banded, like real fare construction). */
export function estimateFare(km, cabin = 'economy') {
  const base = km < 1500 ? 55 + km * 0.12 : km < 5000 ? 120 + km * 0.085 : 220 + km * 0.07;
  const mult = { economy: 1, premium: 1.9, business: 4.2, first: 7.5 }[cabin] ?? 1;
  return Math.round((base * mult) / 5) * 5;
}

/** Deterministic small hash for flight numbers, gates and seats. */
export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Midpoint of the great circle (for winds-aloft sampling). */
export function routeMidpoint(plan) {
  return plan.path.at(plan.path.length / 2).pos;
}

export { distance };
