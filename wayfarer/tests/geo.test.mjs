import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distance,
  bearing,
  intermediate,
  destination,
  greatCircle,
  Path,
  headingDelta,
  decodePolyline,
  pointInGeometry,
  sunElevation,
  nightPolygon,
  isaTemperature,
  formatCoord,
  normalizeLon,
} from '../js/geo.js';

const LHR = [-0.4543, 51.47];
const JFK = [-73.7781, 40.6413];

test('great-circle distance matches published LHR–JFK (5,540 km)', () => {
  assert.ok(Math.abs(distance(LHR, JFK) / 1000 - 5540) < 15);
});

test('initial bearing LHR→JFK is west-northwest (~288°)', () => {
  assert.ok(Math.abs(bearing(LHR, JFK) - 288.2) < 1.5);
});

test('intermediate & destination are consistent', () => {
  const mid = intermediate(LHR, JFK, 0.5);
  assert.ok(Math.abs(distance(LHR, mid) - distance(mid, JFK)) < 1);
  const d = destination(LHR, bearing(LHR, JFK), distance(LHR, JFK));
  assert.ok(distance(d, JFK) < 50);
});

test('great circles across the antimeridian are unwrapped (continuous)', () => {
  const line = greatCircle([139.78, 35.55], [-122.38, 37.62]);
  for (let i = 1; i < line.length; i++) assert.ok(Math.abs(line[i][0] - line[i - 1][0]) < 180);
  assert.ok(line.at(-1)[0] > 180, 'Tokyo→SFO continues east past 180°');
});

test('Path.at interpolates position and heading', () => {
  const p = new Path([
    [0, 0],
    [1, 0],
    [1, 1],
  ]);
  const q = p.at(p.length / 4);
  assert.ok(Math.abs(q.pos[0] - 0.5) < 0.01);
  assert.ok(Math.abs(q.heading - 90) < 0.5);
  assert.deepEqual(p.at(-5).pos, [0, 0]);
  assert.ok(distance(p.at(p.length + 10).pos, [1, 1]) < 1);
  const s = p.slice(0, p.length / 2);
  assert.ok(s.length >= 2);
});

test('headingDelta takes the short way round', () => {
  assert.equal(headingDelta(350, 10), 20);
  assert.equal(headingDelta(10, 350), -20);
  assert.equal(headingDelta(0, 180), 180);
});

test('decodes OSRM/Google polylines', () => {
  // Example from Google's polyline algorithm documentation.
  const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
  assert.deepEqual(
    pts.map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)]),
    [
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ],
  );
});

test('point in polygon respects holes', () => {
  const g = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
        [4, 4],
      ],
    ],
  };
  assert.ok(pointInGeometry([1, 1], g));
  assert.ok(!pointInGeometry([5, 5], g));
  assert.ok(!pointInGeometry([11, 5], g));
});

test('sun elevation: high at noon on the June solstice in the tropics, negative at midnight', () => {
  const noon = new Date('2026-06-21T12:00:00Z');
  assert.ok(sunElevation([0, 23.44], noon) > 85);
  assert.ok(sunElevation([0, 51.5], new Date('2026-06-21T00:00:00Z')) < 0);
});

test('night polygon classifies the planet correctly incl. twilight bands', () => {
  for (const [iso, dep] of [
    ['2026-06-21T12:00:00Z', 0],
    ['2026-03-20T18:00:00Z', -12],
    ['2026-12-21T03:00:00Z', -6],
  ]) {
    const date = new Date(iso);
    const poly = nightPolygon(date, dep);
    let bad = 0;
    for (let lat = -80; lat <= 80; lat += 10) {
      for (let lon = -180; lon < 180; lon += 10) {
        const el = sunElevation([lon, lat], date);
        if (Math.abs(el - dep) < 1.5) continue;
        const inside = [0, 360, -360].some((k) => pointInGeometry([lon + k, lat], poly.geometry));
        if (inside !== el < dep) bad++;
      }
    }
    assert.equal(bad, 0, `${iso} @ ${dep}°`);
  }
});

test('ISA temperature: 15 °C at sea level, −56.5 °C above the tropopause', () => {
  assert.equal(isaTemperature(0), 15);
  assert.equal(isaTemperature(12000), -56.5);
});

test('formatting helpers', () => {
  assert.equal(formatCoord([-0.4543, 51.47]), '51°28′N 0°27′W');
  assert.equal(normalizeLon(190), -170);
});
