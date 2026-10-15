// Offline reverse geocoding to country / continent from Natural Earth polygons
// (js/data/countries.json). Powers border crossings, passport stamps and the
// continents tally without any rate-limited web API.
import { bbox, normalizeLon, pointInGeometry } from './geo.js';

export class CountryIndex {
  constructor(fc) {
    this.items = fc.features.filter((f) => f.geometry).map((f) => {
      const g = f.geometry;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      return {
        ...f.properties,
        geom: g,
        boxes: polys.map((p) => bbox(p[0])),
      };
    });
    this.byIso = new Map(this.items.map((c) => [c.iso, c]));
    this.last = null;
  }

  /** Country at a point, or null at sea. Checks the previous hit first (vehicles move continuously). */
  lookup([lon, lat]) {
    const p = [normalizeLon(lon), lat];
    const inBoxes = (c) => c.boxes.some((b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]);
    if (this.last && inBoxes(this.last) && pointInGeometry(p, this.last.geom)) return this.view(this.last);
    for (const c of this.items) {
      if (c !== this.last && inBoxes(c) && pointInGeometry(p, c.geom)) {
        this.last = c;
        return this.view(c);
      }
    }
    return null;
  }

  view(c) {
    return { name: c.n, iso: c.iso, continent: c.c };
  }

  get(iso) {
    const c = this.byIso.get(iso);
    return c ? this.view(c) : null;
  }
}

/** Regional-indicator flag emoji for an ISO 3166-1 alpha-2 code. */
export function flag(iso) {
  if (!iso || iso.length !== 2 || iso === 'AQ') return iso === 'AQ' ? '🇦🇶' : '🏳️';
  return String.fromCodePoint(...[...iso.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
