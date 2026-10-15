import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFlight, semicircularLevel, flightPhase, alongTrackWind, estimateFare } from '../js/flight.js';
import { AIRPORT_BY_IATA as A } from '../js/data/airports.js';
import { aircraftFor } from '../js/data/vehicles.js';

const plan = (from, to, windKts = 0) => {
  const probe = planFlight(A.get(from), A.get(to), { aircraft: 'a320neo' });
  return planFlight(A.get(from), A.get(to), { aircraft: aircraftFor(probe.distanceKm), windKts });
};
const hours = (s) => s / 3600;

test('semicircular rule: eastbound odd, westbound even flight levels', () => {
  assert.equal(semicircularLevel(90, 410), 410);
  assert.equal(semicircularLevel(90, 400), 390);
  assert.equal(semicircularLevel(270, 410), 400);
  assert.equal(semicircularLevel(270, 390), 380);
});

test('block times are realistic for well-known sectors', () => {
  // Published schedules (gate to gate), allowing for wind and routing.
  const cases = [
    ['LOS', 'LHR', 5.8, 7.0],
    ['ABV', 'LOS', 0.9, 1.4],
    ['SYD', 'MEL', 1.2, 1.7],
    ['SIN', 'EWR', 16.5, 19.0],
  ];
  for (const [a, b, lo, hi] of cases) {
    const h = hours(plan(a, b).blockS);
    assert.ok(h >= lo && h <= hi, `${a}-${b}: ${h.toFixed(2)} h`);
  }
});

test('the jet stream makes eastbound transatlantic faster', () => {
  const west = plan('LHR', 'JFK', -70);
  const east = plan('JFK', 'LHR', 90);
  assert.ok(east.airborneS < west.airborneS - 3600);
});

test('profile: climbs, cruises at the planned level, descends to the runway', () => {
  const p = plan('LOS', 'LHR');
  assert.equal(p.altitudeAt(0), 0);
  assert.equal(p.altitudeAt(p.path.length / 2), p.cruiseFt);
  assert.equal(p.altitudeAt(p.path.length), 0);
  assert.equal(flightPhase(p, p.path.length / 2), 'Cruise');
  assert.equal(flightPhase(p, 1000), 'Takeoff roll');
  assert.ok(p.tasAt(p.path.length / 2) > 470 && p.tasAt(p.path.length / 2) < 510, 'Mach 0.85 ≈ 488 kt TAS at FL400');
  assert.ok(p.remainingS(0) >= p.remainingS(p.path.length / 2));
});

test('short sectors cap the cruise level so climb and descent fit', () => {
  const p = plan('ABV', 'LOS');
  assert.ok(p.cruiseFL <= 330);
  assert.ok(p.climbM + (p.path.length - p.tod) <= p.path.length);
});

test('aircraft selection by range', () => {
  assert.equal(aircraftFor(800), 'a320neo');
  assert.equal(aircraftFor(7000), 'b787');
  assert.equal(aircraftFor(15000), 'a350ulr');
});

test('wind components and fares', () => {
  assert.ok(Math.abs(alongTrackWind(90, 270, 100) - 100) < 1e-9, 'westerly wind is a tailwind eastbound');
  assert.ok(Math.abs(alongTrackWind(270, 270, 100) + 100) < 1e-9);
  assert.ok(estimateFare(5000, 'business') > 3 * estimateFare(5000));
});
