// Shared raster-navigation toolkit for the offline data builders:
// Natural Earth land loading, scanline land rasterisation, clearance-weighted
// grid Dijkstra (ships keep mid-channel) and line-of-sight string pulling.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAND_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson';
const CACHE = join(HERE, '..', '.cache', 'ne_10m_land.geojson');

export async function loadLand(arg) {
  if (arg) return JSON.parse(await readFile(arg, 'utf8'));
  if (!existsSync(CACHE)) {
    console.log(`Downloading ${LAND_URL}`);
    const res = await fetch(LAND_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await mkdir(dirname(CACHE), { recursive: true });
    await writeFile(CACHE, await res.text());
  }
  return JSON.parse(await readFile(CACHE, 'utf8'));
}

// ── Land as a flat list of rings with bounding boxes ──────────────────────
export function landRings(land) {
  const RINGS = [];
  for (const f of land.features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const p of polys) {
      for (const ring of p) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const [x, y] of ring) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        RINGS.push({ ring, minX, minY, maxX, maxY });
      }
    }
  }
  return RINGS;
}

// ── Raster grid ───────────────────────────────────────────────────────────
export class Grid {
  /** Square window of half-size `half` degrees around a centre. */
  static around(rings, [cLon, cLat], half, res) {
    return new Grid(rings, cLon - half, cLat - half, cLon + half, cLat + half, res);
  }
  constructor(rings, lon0, lat0, lon1, lat1, res) {
    this.rings = rings;
    this.res = res;
    this.lon0 = lon0;
    this.lat0 = Math.max(-89.99, lat0);
    this.w = Math.ceil((lon1 - lon0) / res);
    this.h = Math.ceil((Math.min(89.99, lat1) - this.lat0) / res);
    this.land = new Uint8Array(this.w * this.h);
    this.rasterize();
    this.clear = this.clearance();
  }
  lonOf(i) {
    return this.lon0 + (i + 0.5) * this.res;
  }
  latOf(j) {
    return this.lat0 + (j + 0.5) * this.res;
  }
  cellOf([lon, lat]) {
    const i = Math.floor((lon - this.lon0) / this.res);
    const j = Math.floor((lat - this.lat0) / this.res);
    return i >= 0 && j >= 0 && i < this.w && j < this.h ? j * this.w + i : -1;
  }
  coordOf(c) {
    return [this.lonOf(c % this.w), this.latOf(Math.floor(c / this.w))];
  }
  // Scanline even-odd fill. Land polygons are disjoint and their holes are
  // lakes, so global even-odd over every ring is exact. Edges are bucketed by
  // row once, and parity from edges left of the window is counted too.
  rasterize() {
    const { w, h, res, lon0, lat0 } = this;
    const lat1 = lat0 + h * res;
    const lon1 = lon0 + w * res;
    const rows = Array.from({ length: h }, () => []);
    for (const shift of [-360, 0, 360]) {
      for (const r of this.rings) {
        if (r.maxY < lat0 || r.minY > lat1 || r.minX + shift > lon1) continue;
        const ring = r.ring;
        for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
          const [x1, y1] = ring[m];
          const [x2, y2] = ring[k];
          if (y1 === y2) continue;
          const yLo = Math.min(y1, y2);
          const yHi = Math.max(y1, y2);
          const j0 = Math.max(0, Math.ceil((yLo - lat0) / res - 0.5));
          const j1 = Math.min(h - 1, Math.floor((yHi - lat0) / res - 0.5));
          for (let j = j0; j <= j1; j++) {
            const y = lat0 + (j + 0.5) * res;
            if (y < yLo || y >= yHi) continue;
            rows[j].push(x1 + shift + ((y - y1) * (x2 - x1)) / (y2 - y1));
          }
        }
      }
    }
    for (let j = 0; j < h; j++) {
      const xs = rows[j].sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - lon0) / res - 0.5));
        const i1 = Math.min(w - 1, Math.floor((xs[k + 1] - lon0) / res - 0.5));
        for (let i = i0; i <= i1; i++) this.land[j * w + i] = 1;
      }
    }
  }
  // Chamfer distance transform: distance (in cells) from each water cell to land.
  clearance() {
    const { w, h, land } = this;
    const d = new Float32Array(w * h);
    for (let c = 0; c < w * h; c++) d[c] = land[c] ? 0 : 1e9;
    const pass = (dirs, forward) => {
      const start = forward ? 0 : h - 1;
      const step = forward ? 1 : -1;
      for (let j = start; j >= 0 && j < h; j += step) {
        for (let ii = 0; ii < w; ii++) {
          const i = forward ? ii : w - 1 - ii;
          const c = j * w + i;
          for (const [di, dj, cost] of dirs) {
            const ni = i + di;
            const nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
            const v = d[nj * w + ni] + cost;
            if (v < d[c]) d[c] = v;
          }
        }
      }
    };
    pass(
      [
        [-1, 0, 1],
        [0, -1, 1],
        [-1, -1, 1.414],
        [1, -1, 1.414],
      ],
      true,
    );
    pass(
      [
        [1, 0, 1],
        [0, 1, 1],
        [1, 1, 1.414],
        [-1, 1, 1.414],
      ],
      false,
    );
    return d;
  }
  isLand(pt) {
    const c = this.cellOf(pt);
    return c < 0 ? null : this.land[c] === 1;
  }
}

export class Heap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, val) {
    const { k, v } = this;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i], v[p], v[i]] = [k[i], k[p], v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const { k, v } = this;
    const top = v[0];
    const lk = k.pop();
    const lv = v.pop();
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i], v[m], v[i]] = [k[i], k[m], v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Clearance-weighted Dijkstra from `start` cell. `isGoal(cell)` returns truthy
 * for target cells; collects up to `want` goals. Returns { goals, prev }.
 */
export function search(grid, start, isGoal, want, forceWater = new Set()) {
  const { w, h, land, clear } = grid;
  const n = w * h;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new Heap();
  const kx = Math.cos((grid.latOf(Math.floor(start / w)) * Math.PI) / 180);
  dist[start] = 0;
  heap.push(0, start);
  const goals = [];
  const water = (c) => !land[c] || forceWater.has(c);
  while (heap.size && goals.length < want) {
    const u = heap.pop();
    const du = dist[u];
    if (du > dist[u]) continue;
    if (u !== start && isGoal(u)) {
      goals.push(u);
      continue; // do not expand through a goal
    }
    const ui = u % w;
    const uj = (u - ui) / w;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const vi = ui + di;
        const vj = uj + dj;
        if (vi < 0 || vj < 0 || vi >= w || vj >= h) continue;
        const v = vj * w + vi;
        if (!water(v)) continue;
        // No corner-cutting between two land cells.
        if (di && dj && !water(uj * w + vi) && !water(vj * w + ui)) continue;
        const step = Math.hypot(di * kx, dj);
        const penalty = 1 + 3 / Math.max(1, clear[v]);
        const nd = du + step * penalty;
        if (nd < dist[v]) {
          dist[v] = nd;
          prev[v] = u;
          heap.push(nd, v);
        }
      }
    }
  }
  return { goals, prev };
}

export function trace(prev, goal) {
  const out = [];
  for (let c = goal; c >= 0; c = prev[c]) out.push(c);
  return out.reverse();
}

/** Line of sight across water, sampled every ~quarter cell on whichever grid covers the point. */
export function visible(a, b, grids) {
  const res = Math.min(...grids.map((g) => g.res));
  const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (res / 4));
  for (let s = 1; s < steps; s++) {
    const p = [a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps];
    for (const g of grids) {
      const l = g.isLand(p);
      if (l === null) continue;
      if (l) return false;
      break;
    }
  }
  return true;
}

export function stringPull(pts, grids) {
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = i + 1;
    while (j + 1 < pts.length && visible(pts[i], pts[j + 1], grids)) j++;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

/**
 * Global land bitmask at `res` degrees (default 0.01° ≈ 1.1 km), rasterised once
 * with banded scanlines. Fast isLand() lookups for validating long tracks.
 */
export class LandMask {
  constructor(rings, res = 0.01) {
    this.res = res;
    this.w = Math.round(360 / res);
    this.h = Math.round(180 / res);
    this.rowBytes = Math.ceil(this.w / 8);
    this.bits = new Uint8Array(this.rowBytes * this.h);
    const BAND = 400;
    for (let j0 = 0; j0 < this.h; j0 += BAND) {
      const j1 = Math.min(this.h, j0 + BAND);
      const yLo = -90 + j0 * res;
      const yHi = -90 + j1 * res;
      const rows = Array.from({ length: j1 - j0 }, () => []);
      for (const r of rings) {
        if (r.maxY < yLo || r.minY > yHi) continue;
        const ring = r.ring;
        for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
          const [x1, y1] = ring[m];
          const [x2, y2] = ring[k];
          if (y1 === y2) continue;
          const lo = Math.min(y1, y2);
          const hi = Math.max(y1, y2);
          if (hi < yLo || lo > yHi) continue;
          const a = Math.max(j0, Math.ceil((lo + 90) / res - 0.5));
          const b = Math.min(j1 - 1, Math.floor((hi + 90) / res - 0.5));
          for (let j = a; j <= b; j++) {
            const y = -90 + (j + 0.5) * res;
            if (y < lo || y >= hi) continue;
            rows[j - j0].push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
          }
        }
      }
      for (let jj = 0; jj < rows.length; jj++) {
        const xs = rows[jj].sort((p, q) => p - q);
        const base = (j0 + jj) * this.rowBytes;
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const i0 = Math.max(0, Math.ceil((xs[k] + 180) / res - 0.5));
          const i1 = Math.min(this.w - 1, Math.floor((xs[k + 1] + 180) / res - 0.5));
          for (let i = i0; i <= i1; i++) this.bits[base + (i >> 3)] |= 1 << (i & 7);
        }
      }
    }
  }
  cell(lon, lat) {
    const i = Math.floor(((((lon + 180) % 360) + 360) % 360) / this.res);
    const j = Math.floor((lat + 90) / this.res);
    return [Math.min(this.w - 1, i), Math.max(0, Math.min(this.h - 1, j))];
  }
  isLandCell(i, j) {
    const ii = ((i % this.w) + this.w) % this.w;
    if (j < 0 || j >= this.h) return true;
    return (this.bits[j * this.rowBytes + (ii >> 3)] >> (ii & 7)) & 1;
  }
  isLand([lon, lat]) {
    const [i, j] = this.cell(lon, lat);
    return this.isLandCell(i, j) === 1;
  }
}

/** A Grid window backed by a LandMask (no re-rasterisation). */
export function gridFromMask(mask, lon0, lat0, lon1, lat1) {
  const g = Object.create(Grid.prototype);
  g.res = mask.res;
  const [i0, j0] = [Math.floor((lon0 + 180) / mask.res), Math.max(0, Math.floor((lat0 + 90) / mask.res))];
  const j1 = Math.min(mask.h, Math.ceil((lat1 + 90) / mask.res));
  g.w = Math.ceil((lon1 - lon0) / mask.res);
  g.h = j1 - j0;
  g.lon0 = -180 + i0 * mask.res;
  g.lat0 = -90 + j0 * mask.res;
  g.land = new Uint8Array(g.w * g.h);
  for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) g.land[j * g.w + i] = mask.isLandCell(i0 + i, j0 + j);
  g.clear = g.clearance();
  return g;
}
