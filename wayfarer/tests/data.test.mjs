import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AIRPORTS } from '../js/data/airports.js';
import { PORTS } from '../js/data/ports.js';
import { LANDMARKS } from '../js/data/landmarks.js';
import { VEHICLES } from '../js/data/vehicles.js';
import { CountryIndex } from '../js/countries.js';
import { needsPassportControl, needsCustoms, drivesOnLeft, CARRIER } from '../js/data/countries-info.js';
import { destination } from '../js/geo.js';

const countries = new CountryIndex(JSON.parse(readFileSync(new URL('../js/data/countries.json', import.meta.url))));

/** Inside its country, or within `km` of it (coastal sites vs simplified borders). */
function nearCountry(coord, iso, km) {
  for (let r = 0; r <= km; r += 2) {
    for (let b = 0; b < 360; b += r ? 15 : 360) {
      const c = countries.lookup(r ? destination(coord, b, r * 1000) : coord);
      if (c?.iso === iso) return true;
    }
  }
  return false;
}

// Territories that Natural Earth folds into a parent at 1:50m, or Antarctica.
const PARENT = { HK: ['HK', 'CN'], PR: ['PR', 'US'], PF: ['PF', 'FR'], VA: ['VA', 'IT'], AQ: ['AQ'] };
const ok = (coord, iso, km) => (PARENT[iso] || [iso]).some((i) => nearCountry(coord, i, km));

test('unique codes', () => {
  const iata = AIRPORTS.map((a) => a.iata);
  assert.equal(new Set(iata).size, iata.length);
  assert.equal(new Set(AIRPORTS.map((a) => a.icao)).size, AIRPORTS.length);
  assert.equal(new Set(PORTS.map((p) => p.id)).size, PORTS.length);
  assert.equal(new Set(LANDMARKS.map((l) => l.id)).size, LANDMARKS.length);
});

test('every airport lies in its country and has a valid IANA time zone', () => {
  for (const a of AIRPORTS) {
    assert.match(a.iata, /^[A-Z]{3}$/);
    assert.match(a.icao, /^[A-Z]{4}$/);
    assert.ok(ok(a.coord, a.iso, 24), `${a.iata} not in ${a.iso}`);
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: a.tz }), a.tz);
  }
});

test('every port and landmark lies in (or just off the coast of) its country', () => {
  const absentAt50m = new Set(['JTR']); // Fira's caldera berth falls outside Santorini's simplified outline
  for (const p of PORTS) if (!absentAt50m.has(p.id)) assert.ok(ok(p.coord, p.iso, 26), `${p.id} not in ${p.iso}`);
  // Heart Reef lies ~60 km out to sea; Bora Bora is too small for 1:50m outlines.
  const offshore = new Set(['great-barrier-reef', 'bora-bora']);
  for (const l of LANDMARKS) if (!offshore.has(l.id)) assert.ok(ok(l.coord, l.iso, 26), `${l.id} not in ${l.iso}`);
});

test('every airport country has a departure carrier or a fallback', () => {
  const missing = [...new Set(AIRPORTS.map((a) => a.iso))].filter((iso) => !CARRIER[iso] && iso !== 'US');
  assert.deepEqual(missing, []);
});

test('border rules', () => {
  assert.equal(needsPassportControl('FR', 'DE'), false, 'Schengen');
  assert.equal(needsPassportControl('GB', 'IE'), false, 'Common Travel Area');
  assert.equal(needsPassportControl('GB', 'FR'), true);
  assert.equal(needsPassportControl('NG', 'GH'), true);
  assert.equal(needsCustoms('FR', 'IE'), false, 'EU customs union');
  assert.equal(needsCustoms('CH', 'FR'), true, 'Switzerland is Schengen but not EU customs');
  assert.equal(drivesOnLeft('GB'), true);
  assert.equal(drivesOnLeft('NG'), false);
  assert.equal(drivesOnLeft('JP'), true);
});

test('vehicle specs are complete for their mode', () => {
  for (const [k, v] of Object.entries(VEHICLES)) {
    if (v.mode === 'fly') assert.ok(v.cruiseMach && v.cruiseFL && v.v2Kts && v.approachKts, k);
    if (v.mode === 'sail') assert.ok(v.serviceKnots, k);
    if (v.mode === 'drive') assert.ok(v.topSpeedKmh && (v.lPer100 || v.kWhPer100), k);
  }
});

test('offline country lookup', () => {
  assert.equal(countries.lookup([3.38, 6.52]).iso, 'NG');
  assert.equal(countries.lookup([2.35, 48.86]).iso, 'FR');
  assert.equal(countries.lookup([-30, 30]), null, 'mid-Atlantic');
  assert.equal(countries.lookup([2.35, 48.86]).continent, 'Europe');
  assert.equal(countries.get('MV').continent, 'Asia');
  assert.equal(countries.get('MU').continent, 'Africa');
});
