// Geodesy and path utilities. Pure functions, no DOM: unit-tested in tests/geo.test.mjs.
// Coordinates are [lon, lat] in degrees (GeoJSON order) everywhere in the codebase.

export const EARTH_RADIUS_M = 6371008.8; // IUGG mean radius
export const KM_PER_NM = 1.852;
export const MS_PER_KNOT = 0.514444;
export const FT_PER_M = 3.28084;

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in metres (haversine). */
export function distance(a, b) {
  const φ1 = toRad(a[1]);
  const φ2 = toRad(b[1]);
  const dφ = φ2 - φ1;
  const dλ = toRad(b[0] - a[0]);
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial true bearing from a to b, degrees 0..360. */
export function bearing(a, b) {
  const φ1 = toRad(a[1]);
  const φ2 = toRad(b[1]);
  const dλ = toRad(b[0] - a[0]);
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point at fraction f along the great circle from a to b (spherical slerp). */
export function intermediate(a, b, f) {
  const φ1 = toRad(a[1]);
  const λ1 = toRad(a[0]);
  const φ2 = toRad(b[1]);
  const λ2 = toRad(b[0]);
  const δ = distance(a, b) / EARTH_RADIUS_M;
  if (δ < 1e-12) return [a[0], a[1]];
  const A = Math.sin((1 - f) * δ) / Math.sin(δ);
  const B = Math.sin(f * δ) / Math.sin(δ);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return [toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.hypot(x, y)))];
}

/** Destination point given start, bearing (deg) and distance (m). */
export function destination(p, brng, dist) {
  const δ = dist / EARTH_RADIUS_M;
  const θ = toRad(brng);
  const φ1 = toRad(p[1]);
  const λ1 = toRad(p[0]);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [normalizeLon(toDeg(λ2)), toDeg(φ2)];
}

export function normalizeLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Densified great-circle line from a to b, one vertex every `stepM` metres.
 * Longitudes are unwrapped (may exceed ±180) so the line renders continuously
 * across the antimeridian in MapLibre.
 */
export function greatCircle(a, b, stepM = 50000) {
  const n = Math.max(2, Math.ceil(distance(a, b) / stepM) + 1);
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(intermediate(a, b, i / (n - 1)));
  return unwrapLongitudes(pts);
}

/** Make consecutive longitudes continuous (no ±360 jumps). */
export function unwrapLongitudes(pts) {
  const out = [pts[0].slice()];
  for (let i = 1; i < pts.length; i++) {
    let lon = pts[i][0];
    const prev = out[i - 1][0];
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    out.push([lon, pts[i][1], ...pts[i].slice(2)]);
  }
  return out;
}

/**
 * A measured polyline: cumulative distances for O(log n) position lookup.
 * The heart of the simulation: every vehicle advances along one of these.
 */
export class Path {
  constructor(coords) {
    if (!coords || coords.length < 2) throw new Error('Path needs at least two coordinates');
    this.coords = coords;
    this.cum = new Float64Array(coords.length);
    for (let i = 1; i < coords.length; i++) this.cum[i] = this.cum[i - 1] + distance(coords[i - 1], coords[i]);
    this.length = this.cum[coords.length - 1];
  }

  /** Index i such that cum[i] <= d < cum[i+1]. */
  segmentAt(d) {
    const { cum } = this;
    if (d <= 0) return 0;
    if (d >= this.length) return cum.length - 2;
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Position, heading and segment index at distance d (metres) along the path. */
  at(d) {
    const i = this.segmentAt(d);
    const a = this.coords[i];
    const b = this.coords[i + 1];
    const seg = this.cum[i + 1] - this.cum[i];
    const f = seg > 0 ? Math.min(1, Math.max(0, (d - this.cum[i]) / seg)) : 0;
    const pos = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    return { pos, heading: bearing(a, b), index: i };
  }

  /** Smoothed heading: bearing between points `look` metres behind and ahead. */
  headingAt(d, look = 60) {
    const p0 = this.at(Math.max(0, d - look)).pos;
    const p1 = this.at(Math.min(this.length, d + look)).pos;
    if (p0[0] === p1[0] && p0[1] === p1[1]) return this.at(d).heading;
    return bearing(p0, p1);
  }

  /** Coordinates of the path from distance d0 to d1 (for "travelled" trails). */
  slice(d0, d1) {
    const s = Math.max(0, Math.min(d0, d1));
    const e = Math.min(this.length, Math.max(d0, d1));
    const i0 = this.segmentAt(s);
    const i1 = this.segmentAt(e);
    const out = [this.at(s).pos];
    for (let i = i0 + 1; i <= i1; i++) out.push(this.coords[i]);
    out.push(this.at(e).pos);
    return out;
  }
}

/** Signed smallest difference between two headings, degrees in (-180, 180]. */
export function headingDelta(from, to) {
  let d = ((((to - from) % 360) + 540) % 360) - 180;
  if (d === -180) d = 180;
  return d;
}

/** Ray-casting point-in-ring. Ring: array of [lon, lat]. */
export function pointInRing(pt, ring) {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point in GeoJSON Polygon/MultiPolygon geometry (holes respected). */
export function pointInGeometry(pt, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  for (const rings of polys) {
    if (!pointInRing(pt, rings[0])) continue;
    let inHole = false;
    for (let h = 1; h < rings.length; h++) {
      if (pointInRing(pt, rings[h])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/** Bounding box [minLon, minLat, maxLon, maxLat] of coordinates. */
export function bbox(coords) {
  let a = Infinity;
  let b = Infinity;
  let c = -Infinity;
  let d = -Infinity;
  for (const [x, y] of coords) {
    if (x < a) a = x;
    if (y < b) b = y;
    if (x > c) c = x;
    if (y > d) d = y;
  }
  return [a, b, c, d];
}

/** Decode a Google/OSRM encoded polyline (precision 5 or 6) to [lon, lat]. */
export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const out = [];
  let lat = 0;
  let lon = 0;
  let i = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = str.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lon += delta;
    }
    out.push([lon / factor, lat / factor]);
  }
  return out;
}

/** Compass point name for a bearing. */
export function compass(deg) {
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** Degrees-minutes formatted coordinate, e.g. 51°28′N 0°27′W. */
export function formatCoord([lon, lat]) {
  const f = (v, pos, neg) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = Math.floor((a - d) * 60);
    return `${d}°${String(m).padStart(2, '0')}′${v >= 0 ? pos : neg}`;
  };
  return `${f(lat, 'N', 'S')} ${f(normalizeLon(lon), 'E', 'W')}`;
}

/**
 * International Standard Atmosphere temperature (°C) at altitude (m).
 * Used for the "outside air temperature" readout on the in-flight map.
 */
export function isaTemperature(altM) {
  return altM < 11000 ? 15 - 0.0065 * altM : -56.5;
}

/** Local speed of sound (m/s) at altitude, for Mach number display. */
export function speedOfSound(altM) {
  return Math.sqrt(1.4 * 287.05 * (isaTemperature(altM) + 273.15));
}

/** Solar declination and subsolar longitude (degrees) at an instant. */
export function subsolar(date) {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const λ = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const ε = (23.439 - 0.0000004 * n) * rad;
  const δ = Math.asin(Math.sin(ε) * Math.sin(λ));
  const α = Math.atan2(Math.cos(ε) * Math.sin(λ), Math.cos(λ));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  return { decl: δ / rad, lon: normalizeLon(α / rad - gmst * 15) };
}

/**
 * Polygon of the region where the sun is below `depression` degrees
 * (0 = night side of the terminator, -6 civil, -12 nautical, -18 astronomical).
 * That region is a spherical cap centred on the antisolar point with angular
 * radius 90° + depression; caps that enclose a pole are closed through it.
 */
export function nightPolygon(date, depression = 0, step = 3) {
  const { decl, lon: sunLon } = subsolar(date);
  const centre = [normalizeLon(sunLon + 180), -decl];
  const radiusM = (((90 + depression) * Math.PI) / 180) * EARTH_RADIUS_M;
  const pts = [];
  for (let b = 0; b <= 360; b += step) pts.push(destination(centre, b, radiusM));
  const ring = unwrapLongitudes(pts);
  const span = ring[ring.length - 1][0] - ring[0][0];
  if (Math.abs(span) > 180) {
    // Encloses a pole: the antisolar point is in the hemisphere of that pole.
    const pole = centre[1] < 0 ? -89.99 : 89.99;
    const last = ring[ring.length - 1][0];
    ring.push([last, pole], [ring[0][0], pole], ring[0]);
  } else {
    ring[ring.length - 1] = ring[0];
  }
  return { type: 'Feature', properties: { depression }, geometry: { type: 'Polygon', coordinates: [ring] } };
}

/** Sun elevation (degrees) at a location and instant: NOAA simplified algorithm. */
export function sunElevation([lon, lat], date) {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const λ = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const ε = (23.439 - 0.0000004 * n) * rad;
  const δ = Math.asin(Math.sin(ε) * Math.sin(λ));
  const α = Math.atan2(Math.cos(ε) * Math.sin(λ), Math.cos(λ));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const H = (gmst * 15 + lon) * rad - α;
  const φ = lat * rad;
  return Math.asin(Math.sin(φ) * Math.sin(δ) + Math.cos(φ) * Math.cos(δ) * Math.cos(H)) / rad;
}
