import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SeaGraph } from '../js/sea.js';
import { PORTS, PORT_BY_ID as P } from '../js/data/ports.js';
import { CountryIndex } from '../js/countries.js';
import { distance, intermediate, destination } from '../js/geo.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../js/data/${f}`, import.meta.url)));
const graph = new SeaGraph(load('sealanes.json'), load('port-approaches.json'));
const countries = new CountryIndex(load('countries.json'));

// Real canals and straits that are land at 1:50m scale (ships do sail them).
const WATERWAYS = [
  [-80.1, 8.7, -79.3, 9.5], // Panama Canal
  [32.1, 29.8, 32.7, 31.4], // Suez Canal
  [9.0, 53.8, 10.3, 54.5], // Kiel Canal
  [26.0, 39.9, 29.3, 41.3], // Dardanelles, Marmara, Bosphorus
  [22.8, 37.8, 23.2, 38.0], // Corinth Canal
  [10.4, 59.0, 10.8, 59.9], // Oslofjord incl. Drøbak Sound (1.5 km wide)
];
const inWaterway = ([x, y]) => WATERWAYS.some(([a, b, c, d]) => x >= a && x <= c && y >= b && y <= d);

/** "Deep land": the point and four points 3 km around it are all on land. */
function deepLand(p) {
  if (inWaterway(p) || !countries.lookup(p)) return false;
  return [0, 90, 180, 270].every((b) => countries.lookup(destination(p, b, 3000)));
}

/**
 * Lane-portion land check. The last ~30 km into each berth (inner harbours
 * narrower than 1:50m coastlines) is validated at 1:10m by tools/build-ports.mjs.
 */
function landSamples(coords) {
  const hits = [];
  const ends = [coords[0], coords[coords.length - 1]];
  for (let i = 1; i < coords.length; i++) {
    const n = Math.max(1, Math.ceil(distance(coords[i - 1], coords[i]) / 5000));
    for (let k = 0; k < n; k++) {
      const p = intermediate(coords[i - 1], coords[i], k / n);
      if (ends.some((e) => distance(e, p) < 30000)) continue;
      if (deepLand(p)) hits.push(p.map((v) => v.toFixed(2)).join(','));
    }
  }
  return hits;
}

const route = (a, b) => graph.route(P.get(a), P.get(b));

test('every port has surveyed approaches ending on the lane network', () => {
  const approaches = load('port-approaches.json');
  for (const p of PORTS) {
    assert.ok(approaches[p.id]?.length, `${p.id} has approaches`);
    assert.ok(graph.entries(p).length, `${p.id} joins the lanes`);
  }
});

test('Shanghai → Rotterdam goes via Malacca and Suez (~10,500 nmi)', () => {
  const r = route('SHA', 'HVH');
  assert.ok(r.km > 18500 && r.km < 21000, `${r.km} km`);
  assert.ok(
    r.coords.some(([x, y]) => x > 32.2 && x < 32.7 && y > 29.9 && y < 31.3),
    'transits Suez',
  );
  assert.ok(
    r.coords.some(([x, y]) => x > 100 && x < 104 && y > 1 && y < 6),
    'transits Malacca',
  );
});

test('New York → Los Angeles transits the Panama Canal', () => {
  const r = route('NYC', 'LAX');
  assert.ok(r.km > 8500 && r.km < 10000, `${r.km} km`);
  assert.ok(r.coords.some(([x, y]) => x > -80.1 && x < -79.3 && y > 8.7 && y < 9.5));
});

test('Yokohama → San Francisco crosses the antimeridian continuously', () => {
  const r = route('YOK', 'SFO');
  for (let i = 1; i < r.coords.length; i++) assert.ok(Math.abs(r.coords[i][0] - r.coords[i - 1][0]) < 180);
  assert.ok(r.km > 8000 && r.km < 9500);
});

test('short ferry crossings stay short', () => {
  assert.ok(route('DOV', 'CQF').km < 70);
  assert.ok(route('TAR', 'TNG').km < 60);
  assert.ok(route('HEL', 'TLL').km < 120);
});

test('voyages never sail across land', () => {
  const pairs = [
    ['SOU', 'NYC'],
    ['LOS', 'SOU'],
    ['SHA', 'HVH'],
    ['NYC', 'LAX'],
    ['YOK', 'SFO'],
    ['SYD', 'AKL'],
    ['WLG', 'PCN'],
    ['VCE', 'DBV'],
    ['USH', 'LKY'],
    ['BUE', 'MVD'],
    ['SIN', 'HKG'],
    ['DXB', 'BOM'],
    ['CPT', 'DUR'],
    ['MIA', 'NAS'],
    ['OSL', 'KEL'],
    ['GOT', 'CPH'],
    ['BGO', 'RKV'],
    ['HNL', 'PPT'],
    ['RIO', 'LIS'],
    ['IST', 'PIR'],
  ];
  for (const [a, b] of pairs) {
    const r = route(a, b);
    assert.ok(r, `${a}-${b} routable`);
    assert.deepEqual(landSamples(r.coords), [], `${a}-${b} crosses land`);
  }
});
