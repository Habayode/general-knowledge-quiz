#!/usr/bin/env node
// Builds js/data/countries.json from Natural Earth 1:50m Admin-0 countries.
//
// The output powers offline, rate-limit-free reverse geocoding inside the game:
// border crossings, "Welcome to <country>" signs, passport stamps and continent
// tracking. Natural Earth is public domain (https://www.naturalearthdata.com).
//
// Usage: npm run build:countries [-- path/to/ne_50m_admin_0_countries.geojson]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mapshaper from 'mapshaper';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';
const CACHE = join(HERE, '.cache', 'ne_50m_admin_0_countries.geojson');
const OUT = join(HERE, '..', 'js', 'data', 'countries.json');

async function source() {
  const arg = process.argv[2];
  if (arg) return readFile(arg, 'utf8');
  if (!existsSync(CACHE)) {
    console.log(`Downloading ${SRC_URL}`);
    const res = await fetch(SRC_URL);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    await mkdir(dirname(CACHE), { recursive: true });
    await writeFile(CACHE, await res.text());
  }
  return readFile(CACHE, 'utf8');
}

const raw = JSON.parse(await source());

// Natural Earth files ocean island states under "Seven seas"; assign the
// continent they are conventionally counted with.
const SEVEN_SEAS = {
  MV: 'Asia',
  IO: 'Asia',
  MU: 'Africa',
  SC: 'Africa',
  SH: 'Africa',
  TF: 'Antarctica',
  HM: 'Antarctica',
  GS: 'South America',
};

// Natural Earth marks a few ISO codes as -99 (France, Norway, Kosovo...) or
// as compound codes (Taiwan: CN-TW).
// ISO_A2_EH carries the "everyday" code; fall back to it.
for (const f of raw.features) {
  const p = f.properties;
  const iso = [p.ISO_A2, p.ISO_A2_EH].find((c) => /^[A-Z]{2}$/.test(c || '')) || p.ADM0_A3.slice(0, 2);
  f.properties = {
    n: p.NAME_LONG || p.NAME,
    iso,
    c: p.CONTINENT === 'Seven seas (open ocean)' ? SEVEN_SEAS[iso] || 'Oceania' : p.CONTINENT,
  };
}

const out = await mapshaper.applyCommands(
  '-i in.json -explode -simplify 22% weighted keep-shapes -dissolve n,iso,c -o out.json precision=0.001 format=geojson',
  { 'in.json': JSON.stringify(raw) },
);
const fc = JSON.parse(out['out.json']);
// Each island is simplified separately (explode → keep-shapes → dissolve) so
// small islands such as New Providence (Nassau) survive simplification.
fc.features = fc.features.filter((f) => f.geometry);
fc.features.sort((a, b) => a.properties.n.localeCompare(b.properties.n));
fc.attribution = 'Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com';
await writeFile(OUT, JSON.stringify(fc));
console.log(`Wrote ${OUT}: ${fc.features.length} countries, ${(JSON.stringify(fc).length / 1024).toFixed(0)} KiB`);
