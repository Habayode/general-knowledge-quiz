// Itinerary planning: turns "from A to B by <mode>" into concrete, routed legs.
// A flight between two cities becomes: drive to the departure airport → fly →
// drive from the arrival airport, exactly as in real life. Same for ships.
import { AIRPORTS } from './data/airports.js';
import { PORTS } from './data/ports.js';
import { VEHICLES, aircraftFor, vesselFor } from './data/vehicles.js';
import { distance, Path } from './geo.js';
import { planFlight, alongTrackWind, routeMidpoint } from './flight.js';
import { roadRoute, windsAloft, ServiceError } from './services.js';
import { SeaGraph } from './sea.js';

export const MODES = {
  drive: { label: 'Drive', icon: '🚗', vehicles: ['sedan', 'suv', 'ev'] },
  motorbike: { label: 'Motorbike', icon: '🏍️', vehicles: ['motorbike'] },
  bike: { label: 'Cycle', icon: '🚲', vehicles: ['bicycle'] },
  walk: { label: 'Walk', icon: '🚶', vehicles: ['walk'] },
  fly: { label: 'Fly', icon: '✈️', vehicles: ['auto'] },
  sail: { label: 'Ship', icon: '🚢', vehicles: ['auto'] },
};

let seaGraphPromise = null;
/** Lazily load the shipping-lane graph and port approaches (~250 KB gzipped). */
export function loadSeaGraph() {
  if (!seaGraphPromise) {
    const get = (f) => fetch(new URL(`./data/${f}`, import.meta.url)).then((r) => r.json());
    seaGraphPromise = Promise.all([get('sealanes.json'), get('port-approaches.json')]).then(
      ([lanes, approaches]) => new SeaGraph(lanes, approaches),
    );
    seaGraphPromise.catch(() => (seaGraphPromise = null));
  }
  return seaGraphPromise;
}

export function airportPlace(a) {
  return { kind: 'airport', id: a.iata, iata: a.iata, city: a.city, name: `${a.city} ${a.iata}`, label: `${a.name} (${a.iata})`, coord: a.coord, iso: a.iso, tz: a.tz, airport: a };
}

export function portPlace(p) {
  return { kind: 'port', id: p.id, city: p.city, name: p.city, label: p.name, coord: p.coord, iso: p.iso, port: p };
}

export function nearestAirports(coord, n = 3) {
  return AIRPORTS.map((a) => [a, distance(coord, a.coord)])
    .sort((x, y) => x[1] - y[1])
    .slice(0, n);
}

export function nearestPorts(coord, n = 3) {
  return PORTS.map((p) => [p, distance(coord, p.coord)])
    .sort((x, y) => x[1] - y[1])
    .slice(0, n);
}

const isRoad = (mode) => mode === 'drive' || mode === 'motorbike' || mode === 'bike' || mode === 'walk';

/** Default vehicle for a road mode. */
export function defaultVehicle(mode) {
  return { drive: 'sedan', motorbike: 'motorbike', bike: 'bicycle', walk: 'walk' }[mode];
}

/**
 * Expand a user leg into concrete legs, inserting ground transfers to/from
 * terminals when the stop is not itself an airport/port.
 * @param {object} from Place
 * @param {object} to Place
 * @param {string} mode one of MODES
 * @param {object} opts { vehicle, transferVehicle }
 */
export function expandLeg(from, to, mode, opts = {}) {
  const transfer = opts.transferVehicle || 'sedan';
  if (isRoad(mode)) return [{ mode, vehicle: opts.vehicle || defaultVehicle(mode), from, to }];

  const pick = mode === 'fly' ? nearestAirports : nearestPorts;
  const asTerminal = mode === 'fly' ? airportPlace : portPlace;
  const kind = mode === 'fly' ? 'airport' : 'port';
  const depart = from.kind === kind ? from : asTerminal(pick(from.coord, 1)[0][0]);
  const arrive = to.kind === kind ? to : asTerminal(pick(to.coord, 1)[0][0]);
  if (depart.id === arrive.id) {
    throw new PlanError(
      mode === 'fly'
        ? `Both places are served by ${depart.label}. Too close to fly: drive instead.`
        : `Both places use the same port (${depart.label}). Drive instead.`,
    );
  }
  const legs = [];
  if (from.kind !== kind && distance(from.coord, depart.coord) > 500) {
    legs.push({ mode: 'drive', vehicle: transfer, from, to: depart, transfer: true });
  }
  legs.push({ mode, vehicle: 'auto', from: depart, to: arrive });
  if (to.kind !== kind && distance(arrive.coord, to.coord) > 500) {
    legs.push({ mode: 'drive', vehicle: transfer, from: arrive, to, transfer: true });
  }
  return legs;
}

/**
 * Suggest a realistic multimodal plan between two places, like a travel agent:
 * drive if it's a sensible road trip, otherwise fly (with airport transfers).
 */
export function suggestPlan(from, to, { prefer = 'auto' } = {}) {
  const km = distance(from.coord, to.coord) / 1000;
  if (prefer === 'sail') return expandLeg(from, to, 'sail');
  if (prefer === 'drive' || (prefer === 'auto' && km < 650)) return expandLeg(from, to, 'drive');
  try {
    return expandLeg(from, to, 'fly');
  } catch {
    return expandLeg(from, to, 'drive');
  }
}

export class PlanError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'PlanError';
  }
}

/**
 * Resolve geometry, timing and costs for a concrete leg (network calls happen here).
 * Mutates and returns the leg with { path, route|plan|voyage, distanceM, durationS }.
 */
export async function resolveLeg(leg) {
  if (isRoad(leg.mode)) {
    const v = VEHICLES[leg.vehicle];
    let route;
    try {
      route = await roadRoute(v.profile, leg.from.coord, leg.to.coord);
    } catch (err) {
      throw new PlanError(
        /No road/.test(err.message)
          ? `There is no road between ${leg.from.name} and ${leg.to.name}. Add a flight or ship leg.`
          : `Road routing is unavailable right now (${err.message}). Please try again.`,
      );
    }
    // Snap the endpoints exactly onto the stops (OSRM snaps to nearest road).
    leg.route = route;
    leg.path = new Path(route.coords);
    leg.distanceM = route.distanceM;
    leg.durationS = adjustRoadDuration(route.durationS, leg.vehicle, route.distanceM);
    return leg;
  }

  if (leg.mode === 'fly') {
    const probe = planFlight(leg.from.airport, leg.to.airport, { aircraft: 'a320neo' });
    const aircraft = aircraftFor(probe.distanceKm);
    let windKts = 0;
    let wind = null;
    try {
      wind = await windsAloft(routeMidpoint(probe));
      windKts = alongTrackWind(probe.track, wind.fromDeg, wind.kts);
    } catch {
      // Winds aloft are a nicety; fly still-air if Open-Meteo is unreachable.
    }
    const plan = planFlight(leg.from.airport, leg.to.airport, { aircraft, windKts });
    plan.wind = wind;
    leg.vehicle = aircraft;
    leg.plan = plan;
    leg.path = plan.path;
    leg.distanceM = plan.path.length;
    leg.durationS = plan.blockS;
    return leg;
  }

  if (leg.mode === 'sail') {
    const graph = await loadSeaGraph();
    const voyage = graph.route(
      { id: leg.from.id, coord: leg.from.coord },
      { id: leg.to.id, coord: leg.to.coord },
    );
    if (!voyage) throw new PlanError(`No sea route between ${leg.from.label} and ${leg.to.label}.`);
    const vesselKey = vesselFor(voyage.km, leg.to.iso, leg.from.iso);
    leg.vehicle = vesselKey;
    leg.voyage = voyage;
    leg.path = new Path(voyage.coords);
    leg.distanceM = leg.path.length;
    const v = VEHICLES[vesselKey];
    // Harbour legs at ~8 kn, the rest at service speed (same model as SeaRunner).
    const harbourM = 2 * harbourZoneM(leg.distanceM);
    leg.durationS = 600 + harbourM / (8 * 0.514444) + (leg.distanceM - harbourM) / (v.serviceKnots * 0.514444);
    return leg;
  }
  throw new PlanError(`Unknown mode ${leg.mode}`);
}

/** Length of the slow harbour zone at each end of a voyage. */
export function harbourZoneM(totalM) {
  return totalM < 100000 ? Math.min(totalM * 0.1, 4000) : Math.min(totalM * 0.2, 12000);
}

/** OSRM car speeds are car speeds: scale for motorbikes (filtering) and sanity. */
function adjustRoadDuration(durationS, vehicle) {
  if (vehicle === 'motorbike') return durationS * 0.95;
  return durationS;
}

export { ServiceError };
