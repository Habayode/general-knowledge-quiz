import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Clock } from '../js/sim.js';
import { expandLeg, airportPlace, portPlace, nearestAirports, harbourZoneM } from '../js/planner.js';
import { AIRPORT_BY_IATA } from '../js/data/airports.js';
import { PORT_BY_ID } from '../js/data/ports.js';

test('clock: waits resolve at the right sim time, scaled by time compression', async () => {
  const c = new Clock(0);
  c.scale = 60;
  let done = false;
  c.wait(90).then(() => (done = true));
  const second = () => [0, 1, 2, 3].forEach(() => c.tick(250)); // frames are capped at 250 ms
  second(); // 60 sim-seconds
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(c.simMs, 60000);
  second();
  await Promise.resolve();
  assert.equal(done, true);
  assert.equal(c.simMs, 120000);
});

test('clock: skipWait jumps exactly to the next event; tickers get ≤1 s steps', async () => {
  const c = new Clock(0);
  let done = false;
  c.wait(3600).then(() => (done = true));
  let maxStep = 0;
  let steps = 0;
  c.until((dt) => {
    maxStep = Math.max(maxStep, dt);
    return ++steps >= 5000;
  });
  c.skipWait();
  await Promise.resolve();
  assert.ok(done);
  assert.ok(maxStep <= 1);
});

test('clock: pause stops time', () => {
  const c = new Clock(0);
  c.paused = true;
  c.tick(1000);
  assert.equal(c.simMs, 0);
});

const city = (name, coord, iso) => ({ kind: 'place', name, coord, iso });

test('a flight between cities adds airport transfers, like real life', () => {
  const legs = expandLeg(city('Ikeja', [3.35, 6.6], 'NG'), city('London', [-0.13, 51.5], 'GB'), 'fly');
  assert.deepEqual(
    legs.map((l) => l.mode),
    ['drive', 'fly', 'drive'],
  );
  assert.equal(legs[1].from.iata, 'LOS');
  assert.ok(['LHR', 'LGW'].includes(legs[1].to.iata));
});

test('airport-to-airport flights need no transfers; same-airport flights are refused', () => {
  const lhr = airportPlace(AIRPORT_BY_IATA.get('LHR'));
  const cdg = airportPlace(AIRPORT_BY_IATA.get('CDG'));
  assert.equal(expandLeg(lhr, cdg, 'fly').length, 1);
  assert.throws(() => expandLeg(city('Lagos', [3.38, 6.52], 'NG'), city('Ikeja', [3.35, 6.6], 'NG'), 'fly'));
});

test('ship legs connect ports', () => {
  const legs = expandLeg(portPlace(PORT_BY_ID.get('DOV')), portPlace(PORT_BY_ID.get('CQF')), 'sail');
  assert.equal(legs.length, 1);
  assert.equal(nearestAirports([3.38, 6.52], 1)[0][0].iata, 'LOS');
});

test('harbour zone scales with voyage length', () => {
  assert.equal(harbourZoneM(42000), 4000);
  assert.equal(harbourZoneM(5000000), 12000);
});
