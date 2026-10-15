#!/usr/bin/env node
// Builds js/data/sealanes.json: a compact routing graph of the world's real
// shipping lanes, from Eurostat's maritime network ("marnet") as packaged by
// searoute-js. Includes the Suez, Panama and Kiel canals, the major straits
// (Gibraltar, Malacca, Hormuz, Bab-el-Mandeb, Dover...) and ocean lanes.
//
// Every polyline vertex becomes a graph vertex (shared coordinates = junctions)
// and every segment an edge [a, b, km]. The antimeridian is stitched by merging
// lon=-180 into lon=+180.
//
// Repair pass: marnet is drawn at a coarse scale, so some segments clip islands
// and headlands (Canaries, Madeira, Hawaii, Zhoushan...). Each segment is
// checked against Natural Earth 1:10m land (~1 km mask); clipping segments are
// re-threaded around the coast with a clearance-weighted grid search. Segments
// with no water alternative are real canals (Panama, Suez, Kiel, Corinth) and
// are kept as-is.
//
// Usage: npm run build:sealanes [-- path/to/ne_10m_land.geojson]
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distance, intermediate } from '../js/geo.js';
import { LandMask, gridFromMask, landRings, loadLand, search, stringPull, trace } from './lib/land.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SRC = join(dirname(require.resolve('searoute-js/package.json')), 'data', 'marnet_densified.json');
const OUT = join(HERE, '..', 'js', 'data', 'sealanes.json');

const r3 = (v) => Math.round(v * 1000) / 1000;
const keyOf = ([lon, lat]) => `${lon <= -179.9995 ? 180 : r3(lon)},${r3(lat)}`;

const fc = JSON.parse(await readFile(SRC, 'utf8'));
const coordOf = new Map(); // key -> [lon, lat]
const adj = new Map(); // key -> Set(key)
const link = (a, b) => {
  if (a === b) return;
  if (!adj.has(a)) adj.set(a, new Set());
  if (!adj.has(b)) adj.set(b, new Set());
  adj.get(a).add(b);
  adj.get(b).add(a);
};

for (const f of fc.features) {
  const cs = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const line of cs) {
    let prev = null;
    for (const p of line) {
      const k = keyOf(p);
      if (!coordOf.has(k)) coordOf.set(k, [k.startsWith('180,') ? 180 : r3(p[0]), r3(p[1])]);
      if (prev) link(prev, k);
      prev = k;
    }
  }
}

// Every vertex is a graph node: ports may join a lane anywhere along it.
const nodeIndex = new Map();
const nodes = [];
for (const k of adj.keys()) {
  nodeIndex.set(k, nodes.length / 2);
  nodes.push(...coordOf.get(k));
}
const edges = [];
for (const [a, nbrs] of adj) {
  for (const b of nbrs) {
    const ia = nodeIndex.get(a);
    const ib = nodeIndex.get(b);
    if (ia < ib) edges.push([ia, ib, Math.round((distance(coordOf.get(a), coordOf.get(b)) / 1000) * 10) / 10]);
  }
}

// ── Repair pass ──────────────────────────────────────────────────────────
console.log('Rasterising 1:10m land...');
const mask = new LandMask(landRings(await loadLand(process.argv[2])), 0.01);
const at = (i) => [nodes[2 * i], nodes[2 * i + 1]];
const along = (A, B, f) => (distance(A, B) > 60000 ? intermediate(A, B, f) : [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f]);
function clips(A, B) {
  const n = Math.max(2, Math.ceil(distance(A, B) / 500));
  for (let k = 1; k < n; k++) if (mask.isLand(along(A, B, k / n))) return true;
  return false;
}
// Long ocean legs are first split along their great circle (~250 km pieces)
// so each piece can be checked and, if needed, re-threaded in a small window.
for (let k = edges.length - 1; k >= 0; k--) {
  const [a, b] = edges[k];
  const A = at(a);
  const B = at(b);
  const d = distance(A, B);
  if (d <= 500000) continue;
  const n = Math.ceil(d / 250000);
  let prev = a;
  const pieces = [];
  for (let s = 1; s <= n; s++) {
    let idx = b;
    if (s < n) {
      const p = intermediate(A, B, s / n);
      idx = nodes.length / 2;
      nodes.push(Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000);
    }
    pieces.push([prev, idx, Math.round((d / n / 1000) * 10) / 10]);
    prev = idx;
  }
  edges.splice(k, 1, ...pieces);
}

let repaired = 0;
const canals = [];
const kept = [];
for (const e of edges) {
  const A = at(e[0]);
  let B = at(e[1]);
  if (B[0] - A[0] > 180) B = [B[0] - 360, B[1]];
  if (A[0] - B[0] > 180) B = [B[0] + 360, B[1]];
  if (!clips(A, B)) {
    kept.push(e);
    continue;
  }
  const span = Math.max(Math.abs(B[0] - A[0]), Math.abs(B[1] - A[1]));
  const m = Math.max(0.3, span * 0.35);
  const grid =
    span > 25
      ? null
      : gridFromMask(mask, Math.min(A[0], B[0]) - m, Math.min(A[1], B[1]) - m, Math.max(A[0], B[0]) + m, Math.max(A[1], B[1]) + m);
  const sa = grid && grid.cellOf(A);
  const sb = grid && grid.cellOf(B);
  const found = grid && sa >= 0 && sb >= 0 ? search(grid, sa, (c) => c === sb, 1, new Set([sa, sb])) : { goals: [] };
  if (!found.goals.length) {
    canals.push(A.map((v) => v.toFixed(2)).join(','));
    kept.push(e);
    continue;
  }
  const cells = trace(found.prev, sb).map((c) => grid.coordOf(c));
  const pulled = stringPull([A, ...cells.slice(1, -1), B], [grid]);
  let prev = e[0];
  for (let k = 1; k < pulled.length; k++) {
    let idx;
    if (k === pulled.length - 1) idx = e[1];
    else {
      idx = nodes.length / 2;
      const p = pulled[k];
      nodes.push(Math.round((((p[0] + 540) % 360) - 180) * 1000) / 1000, Math.round(p[1] * 1000) / 1000);
    }
    kept.push([prev, idx, Math.round((distance(pulled[k - 1], pulled[k]) / 1000) * 10) / 10]);
    prev = idx;
  }
  repaired++;
}
edges.length = 0;
edges.push(...kept);
console.log(`Repaired ${repaired} land-clipping segments; kept ${canals.length} canal/strait segments as-is: ${canals.join(' ')}`);

const out = {
  attribution: 'Maritime network: Eurostat SeaRoute (marnet), via searoute-js. Not for navigation.',
  nodes,
  edges,
};
await writeFile(OUT, JSON.stringify(out));
console.log(`Wrote ${OUT}: ${nodes.length / 2} nodes, ${edges.length} edges, ${(JSON.stringify(out).length / 1024).toFixed(0)} KiB`);
