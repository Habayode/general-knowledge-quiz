// Deterministic stand-ins for every external service, so end-to-end tests run
// offline and reproducibly. Shapes mirror the real APIs (OSRM v1, Photon,
// Open-Meteo, Wikipedia REST/Action) closely enough to exercise real parsing.
import { deflateSync } from 'node:zlib';

// ── PNG tiles ─────────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export const SAT_TILE = png(256, 256, (x, y) => {
  const n = ((x * 7 + y * 13) % 17) - 8;
  return [34 + n, 74 + n, 52 + n];
});
export const NIGHT_TILE = png(256, 256, () => [0, 0, 0]);
export const TERRAIN_TILE = png(256, 256, () => [128, 0, 0]); // terrarium 0 m

// ── OSRM ──────────────────────────────────────────────────────────────────
function encodePolyline(coords, precision = 6) {
  const f = 10 ** precision;
  let out = '';
  let pLat = 0;
  let pLon = 0;
  const enc = (v) => {
    let s = v < 0 ? ~(v << 1) : v << 1;
    let str = '';
    while (s >= 0x20) {
      str += String.fromCharCode((0x20 | (s & 0x1f)) + 63);
      s >>= 5;
    }
    return str + String.fromCharCode(s + 63);
  };
  for (const [lon, lat] of coords) {
    const la = Math.round(lat * f);
    const lo = Math.round(lon * f);
    out += enc(la - pLat) + enc(lo - pLon);
    pLat = la;
    pLon = lo;
  }
  return out;
}
const hav = (a, b) => {
  const R = 6371008.8;
  const r = Math.PI / 180;
  const h = Math.sin(((b[1] - a[1]) * r) / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/** A plausible road route between two points: gentle curves, varied speeds, real step types. */
export function osrmRoute(url) {
  const m = url.match(/driving\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)/);
  const a = [Number(m[1]), Number(m[2])];
  const b = [Number(m[3]), Number(m[4])];
  const crow = hav(a, b);
  if (crow > 3_000_000) return { code: 'NoRoute', message: 'Impossible route between points', routes: [] };
  const n = Math.max(40, Math.min(1500, Math.round(crow / 400)));
  const coords = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const wob = Math.sin(t * Math.PI * 6) * 0.004 * Math.min(1, crow / 20000);
    coords.push([a[0] + (b[0] - a[0]) * t + wob, a[1] + (b[1] - a[1]) * t - wob * 0.6]);
  }
  const dist = [];
  const dur = [];
  for (let i = 1; i < coords.length; i++) {
    const d = hav(coords[i - 1], coords[i]);
    const t = i / coords.length;
    const v = t < 0.08 || t > 0.92 ? 11 : t > 0.3 && t < 0.7 ? 31 : 22; // town → highway → town
    dist.push(d);
    dur.push(d / v);
  }
  const total = dist.reduce((s, x) => s + x, 0);
  const totalDur = dur.reduce((s, x) => s + x, 0);
  const types = [
    { type: 'depart', bearing_after: 90, name: 'Harbour Road' },
    { type: 'turn', modifier: 'right', name: 'Market Street' },
    { type: 'roundabout', modifier: 'straight', exit: 2, name: 'Ring Road' },
    { type: 'on ramp', modifier: 'slight right', name: 'Expressway', ref: 'E1' },
    { type: 'off ramp', modifier: 'slight right', exits: '12', destinations: 'City Centre' },
    { type: 'turn', modifier: 'left', name: 'Station Avenue' },
    { type: 'arrive', name: '' },
  ];
  const steps = types.map((s, k) => {
    const idx = Math.min(coords.length - 1, Math.round((k / (types.length - 1)) * (coords.length - 1)));
    return { distance: total / (types.length - 1), duration: totalDur / (types.length - 1), name: s.name || '', ref: s.ref, destinations: s.destinations, exits: s.exits, maneuver: { type: s.type, modifier: s.modifier, exit: s.exit, bearing_after: s.bearing_after || 0, location: coords[idx] } };
  });
  steps[steps.length - 1].distance = 0;
  return {
    code: 'Ok',
    routes: [{ geometry: encodePolyline(coords), distance: total, duration: totalDur, legs: [{ steps, annotation: { distance: dist, duration: dur } }] }],
  };
}

// ── Photon ────────────────────────────────────────────────────────────────
const PLACES = {
  lagos: ['Lagos', 'Lagos State', 'Nigeria', 'NG', [3.3792, 6.5244]],
  ikeja: ['Ikeja', 'Lagos State', 'Nigeria', 'NG', [3.3515, 6.6018]],
  london: ['London', 'England', 'United Kingdom', 'GB', [-0.1276, 51.5072]],
  paris: ['Paris', 'Île-de-France', 'France', 'FR', [2.3522, 48.8566]],
  dover: ['Dover', 'England', 'United Kingdom', 'GB', [1.3134, 51.1279]],
  calais: ['Calais', 'Hauts-de-France', 'France', 'FR', [1.8587, 50.9513]],
  brussels: ['Brussels', 'Brussels-Capital', 'Belgium', 'BE', [4.3517, 50.8503]],
};
export function photon(url) {
  const u = new URL(url);
  if (u.pathname.includes('reverse')) {
    return { features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [Number(u.searchParams.get('lon')), Number(u.searchParams.get('lat'))] }, properties: { name: 'Testville', city: 'Testville', state: 'Test Region', country: 'Testland' } }] };
  }
  const q = (u.searchParams.get('q') || '').toLowerCase();
  const hits = Object.entries(PLACES).filter(([k]) => k.startsWith(q.slice(0, 4)));
  return {
    features: hits.map(([, [name, state, country, cc, coord]]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coord }, properties: { name, city: name, state, country, countrycode: cc } })),
  };
}

// ── Open-Meteo ────────────────────────────────────────────────────────────
export function meteo(url) {
  const u = new URL(url);
  if (u.searchParams.get('hourly')?.includes('250hPa')) {
    return { hourly: { wind_speed_250hPa: Array(24).fill(85), wind_direction_250hPa: Array(24).fill(255) } };
  }
  return {
    timezone: 'Africa/Lagos',
    utc_offset_seconds: 3600,
    current: { temperature_2m: 27.4, apparent_temperature: 30.1, relative_humidity_2m: 74, weather_code: 2, wind_speed_10m: 12, wind_direction_10m: 220, wind_gusts_10m: 25, cloud_cover: 40, visibility: 10000, is_day: 1, pressure_msl: 1011 },
  };
}

// ── Wikipedia ─────────────────────────────────────────────────────────────
export function wiki(url) {
  if (url.includes('list=geosearch')) {
    const m = url.match(/gscoord=([-\d.]+)%7C([-\d.]+)|gscoord=([-\d.]+)\|([-\d.]+)/);
    const lat = Number(m[1] || m[3]);
    const lon = Number(m[2] || m[4]);
    return { query: { geosearch: [{ pageid: 1, title: `Historic Site ${lat.toFixed(2)}`, lat: lat + 0.01, lon: lon + 0.01, dist: 1450 }] } };
  }
  const title = decodeURIComponent(url.split('/summary/')[1] || 'Page');
  return {
    title: title.replace(/_/g, ' '),
    description: 'Landmark',
    extract: `${title.replace(/_/g, ' ')} is a world-famous landmark visited by millions of travellers every year.`,
    content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${title}` } },
  };
}
