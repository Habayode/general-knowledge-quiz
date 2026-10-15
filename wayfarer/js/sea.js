// Maritime routing over the real shipping-lane graph (js/data/sealanes.json),
// joined to each port by its precomputed pilotage approach
// (js/data/port-approaches.json). Pure module, unit-tested in tests/sea.test.mjs.
import { distance, greatCircle, unwrapLongitudes } from './geo.js';

class MinHeap {
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

const keyOf = (lon, lat) => `${Math.round(lon * 1000)},${Math.round(lat * 1000)}`;

export class SeaGraph {
  /**
   * @param {{nodes:number[], edges:[number,number,number][], attribution:string}} lanes
   * @param {Record<string, {via:[number,number][], km:number}[]>} [approaches]
   */
  constructor(lanes, approaches = {}) {
    const n = lanes.nodes.length / 2;
    this.n = n;
    this.lon = new Float64Array(n);
    this.lat = new Float64Array(n);
    this.byKey = new Map();
    for (let i = 0; i < n; i++) {
      this.lon[i] = lanes.nodes[2 * i];
      this.lat[i] = lanes.nodes[2 * i + 1];
      this.byKey.set(keyOf(this.lon[i], this.lat[i]), i);
    }
    this.adj = Array.from({ length: n }, () => []);
    for (const [a, b, km] of lanes.edges) {
      this.adj[a].push(b, km);
      this.adj[b].push(a, km);
    }
    this.approaches = approaches;
    this.attribution = lanes.attribution;
  }

  /** Nearest lane vertices to a point: [[index, metres], ...] closest first. */
  nearest(pt, count = 4) {
    const best = [];
    for (let i = 0; i < this.n; i++) {
      const d = distance(pt, [this.lon[i], this.lat[i]]);
      if (best.length < count || d < best[best.length - 1][1]) {
        best.push([i, d]);
        best.sort((x, y) => x[1] - y[1]);
        if (best.length > count) best.pop();
      }
    }
    return best;
  }

  /**
   * Ways for a ship at `place` to join the lanes: [{ node, km, path }], where
   * path runs from the place to the node. Ports use their surveyed approaches;
   * any other point falls back to a straight run to the nearest lanes.
   */
  entries(place) {
    const surveyed = place.id && this.approaches[place.id];
    if (surveyed) {
      const out = [];
      for (const { via, km } of surveyed) {
        const end = via[via.length - 1];
        const node = this.byKey.get(keyOf(end[0], end[1]));
        if (node !== undefined) out.push({ node, km, path: [place.coord, ...via] });
      }
      if (out.length) return out;
    }
    return this.nearest(place.coord, 4).map(([node, m]) => ({
      node,
      km: m / 1000,
      path: [place.coord, [this.lon[node], this.lat[node]]],
    }));
  }

  /**
   * Shortest sea route between two places ({coord, id?}).
   * Multi-source / multi-target Dijkstra seeded with each approach's length.
   * Returns { coords, km } (coords densified along great circles, longitudes
   * unwrapped across the antimeridian) or null if the lanes are not connected.
   */
  route(from, to) {
    const starts = this.entries(from);
    const ends = new Map();
    for (const e of this.entries(to)) {
      const prev = ends.get(e.node);
      if (!prev || e.km < prev.km) ends.set(e.node, e);
    }
    const dist = new Float64Array(this.n).fill(Infinity);
    const prev = new Int32Array(this.n).fill(-1);
    const seed = new Map();
    const heap = new MinHeap();
    for (const s of starts) {
      if (s.km < dist[s.node]) {
        dist[s.node] = s.km;
        seed.set(s.node, s);
        heap.push(s.km, s.node);
      }
    }
    let bestEnd = -1;
    let bestTotal = Infinity;
    while (heap.size) {
      const u = heap.pop();
      const du = dist[u];
      if (du >= bestTotal) break;
      const end = ends.get(u);
      if (end && du + end.km < bestTotal) {
        bestTotal = du + end.km;
        bestEnd = u;
      }
      const a = this.adj[u];
      for (let k = 0; k < a.length; k += 2) {
        const v = a[k];
        const nd = du + a[k + 1];
        if (nd < dist[v]) {
          dist[v] = nd;
          prev[v] = u;
          heap.push(nd, v);
        }
      }
    }
    if (bestEnd < 0) return null;

    const lane = [];
    let v = bestEnd;
    while (v >= 0) {
      lane.push([this.lon[v], this.lat[v]]);
      if (prev[v] < 0) break;
      v = prev[v];
    }
    lane.reverse();
    const head = seed.get(v).path;
    const tail = ends.get(bestEnd).path.slice().reverse();
    const raw = dedupe([...head, ...lane.slice(1, -1), ...tail]);
    return { coords: densify(unwrapLongitudes(raw)), km: bestTotal };
  }
}

function dedupe(coords) {
  return coords.filter((c, i) => i === 0 || c[0] !== coords[i - 1][0] || c[1] !== coords[i - 1][1]);
}

/** Long ocean legs follow the great circle; short legs stay as surveyed. */
function densify(coords, maxM = 60000) {
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    if (distance(a, b) > maxM) {
      // greatCircle() starts from the normalised longitude; re-align to `a`.
      const gc = greatCircle(a, b, maxM / 2);
      const off = a[0] - gc[0][0];
      for (let k = 1; k < gc.length; k++) out.push([gc[k][0] + off, gc[k][1]]);
    } else {
      out.push(b);
    }
  }
  return unwrapLongitudes(out);
}
