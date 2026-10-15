#!/usr/bin/env node
// Computes the pilotage approach for every port in js/data/ports.js: the real
// water path from the berth, out through harbour entrances, river mouths and
// fjords, to the nearest shipping lanes of js/data/sealanes.json.
//
// Method: rasterise Natural Earth 1:10m land around the port, then run a
// clearance-weighted Dijkstra (ships prefer mid-channel) in two stages:
//   1. fine grid (~280 m cells) near the berth, to thread narrow entrances;
//   2. coarse grid (~2 km cells) further out, to reach the lanes.
// The resulting cell path is string-pulled into a few straight legs.
// Output: js/data/port-approaches.json  { PORT_ID: [{ via: [[lon,lat]...], km }] }
// where each `via` ends exactly on a shipping-lane graph node.
//
// Usage: npm run build:ports [-- path/to/ne_10m_land.geojson]
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS } from '../js/data/ports.js';
import { distance } from '../js/geo.js';
import { Grid, loadLand, landRings, search, stringPull, trace } from './lib/land.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'js', 'data', 'port-approaches.json');
const ENTRIES_PER_PORT = 3;

const RINGS = landRings(await loadLand(process.argv[2]));

// ── Shipping-lane nodes (every vertex of the lane graph is a join point) ──
const lanes = JSON.parse(await readFile(join(HERE, '..', 'js', 'data', 'sealanes.json'), 'utf8'));
const NODES = [];
for (let i = 0; i < lanes.nodes.length; i += 2) NODES.push([lanes.nodes[i], lanes.nodes[i + 1]]);

const r4 = (v) => Math.round(v * 10000) / 10000;
const pathKm = (pts) => pts.reduce((s, p, i) => (i ? s + distance(pts[i - 1], p) / 1000 : 0), 0);

function nodesNear(pt, radiusDeg) {
  return NODES.filter((n) => Math.abs(n[1] - pt[1]) < radiusDeg && Math.abs(((n[0] - pt[0] + 540) % 360) - 180) < radiusDeg);
}

function approach(port) {
  // Inner-harbour pilot channel (if any) is trusted; the search starts at its end.
  const berth = port.pilot.length ? port.pilot[port.pilot.length - 1] : port.coord;
  const lead = [port.coord, ...port.pilot.slice(0, -1)];
  // Stage 1: fine grid around the berth.
  const fine = Grid.around(RINGS, berth, 0.6, 0.0025);
  let start = fine.cellOf(berth);
  if (fine.land[start]) {
    // Berth sits on the coastline: step to the nearest water cell (<= 3 km).
    let best = -1;
    let bestD = Infinity;
    const r = 12;
    const si = start % fine.w;
    const sj = Math.floor(start / fine.w);
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const c = (sj + dj) * fine.w + (si + di);
        if (fine.land[c] === 0 && di * di + dj * dj < bestD) {
          bestD = di * di + dj * dj;
          best = c;
        }
      }
    }
    if (best < 0) throw new Error(`${port.id}: berth is more than 3 km from water at 1:10m`);
    start = best;
  }
  const nodeCellsFine = new Map();
  for (const n of nodesNear(berth, 0.58)) {
    const c = fine.cellOf(n);
    if (c >= 0) nodeCellsFine.set(c, n);
  }
  const OPEN = 40; // cells (~10 km) of clearance = open sea
  const s1 = search(
    fine,
    start,
    (c) => {
      if (nodeCellsFine.has(c)) return true;
      const i = c % fine.w;
      const j = Math.floor(c / fine.w);
      const edge = i === 0 || j === 0 || i === fine.w - 1 || j === fine.h - 1;
      return edge || fine.clear[c] >= OPEN;
    },
    ENTRIES_PER_PORT * 40,
    new Set(nodeCellsFine.keys()),
  );
  if (!s1.goals.length) throw new Error(`${port.id}: no water route out of the harbour at 1:10m`);

  const nodeGoals = s1.goals.filter((c) => nodeCellsFine.has(c));
  const results = [];
  const toPts = (cells, g) => cells.map((c) => g.coordOf(c));

  if (nodeGoals.length) {
    for (const goal of nodeGoals.slice(0, ENTRIES_PER_PORT)) {
      const pts = [...lead, berth, ...toPts(trace(s1.prev, goal), fine).slice(1, -1), nodeCellsFine.get(goal)];
      results.push(pts);
    }
  }
  if (results.length < ENTRIES_PER_PORT) {
    // Stage 2: from where we reached open water, a coarse grid out to the lanes.
    const exitCell = s1.goals.find((c) => !nodeCellsFine.has(c));
    if (exitCell !== undefined) {
      const exitPt = fine.coordOf(exitCell);
      const head = [...lead, berth, ...toPts(trace(s1.prev, exitCell), fine).slice(1)];
      const near = NODES.map((n) => [n, distance(exitPt, n)]).sort((a, b) => a[1] - b[1]);
      const reach = Math.min(12, Math.max(1.5, near[Math.min(8, near.length - 1)][1] / 111000 + 1));
      const coarse = Grid.around(RINGS, exitPt, reach, reach > 6 ? 0.04 : 0.02);
      const s = coarse.cellOf(exitPt);
      const nodeCells = new Map();
      for (const n of nodesNear(exitPt, reach * 0.98)) {
        const c = coarse.cellOf(n);
        if (c >= 0) nodeCells.set(c, n);
      }
      const force = new Set([...nodeCells.keys(), s]);
      const s2 = search(coarse, s, (c) => nodeCells.has(c), ENTRIES_PER_PORT * 3, force);
      const seenNodes = new Set(results.map((r) => r[r.length - 1].join(',')));
      for (const goal of s2.goals) {
        if (results.length >= ENTRIES_PER_PORT) break;
        const node = nodeCells.get(goal);
        if (seenNodes.has(node.join(','))) continue;
        seenNodes.add(node.join(','));
        const tail = toPts(trace(s2.prev, goal), coarse).slice(1, -1);
        results.push([...head, ...tail, node]);
      }
      results.grids = [fine, coarse];
    }
  }
  if (!results.length) throw new Error(`${port.id}: could not reach the shipping lanes`);
  const grids = results.grids || [fine];
  return results.map((pts) => {
    const pulled = [...lead, ...stringPull(pts.slice(lead.length), grids)].map((p, i, a) =>
      i === a.length - 1 ? p : [r4(p[0]), r4(p[1])],
    );
    return { via: pulled.slice(1), km: Math.round(pathKm(pulled) * 10) / 10 };
  });
}

const out = {};
let failures = 0;
for (const port of PORTS) {
  const t = Date.now();
  try {
    out[port.id] = approach(port);
    const s = out[port.id].map((e) => `${e.km}km/${e.via.length}pts`).join(' ');
    console.log(`${port.id.padEnd(4)} ${s}  (${Date.now() - t} ms)`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${err.message}`);
  }
}
await writeFile(OUT, JSON.stringify(out));
console.log(`Wrote ${OUT} (${Object.keys(out).length} ports, ${failures} failures)`);
if (failures) process.exitCode = 1;
