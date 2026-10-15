// Live web services. All are free, key-less, CORS-enabled public APIs:
//   • OSRM (OpenStreetMap road network): real driving / cycling / walking routes
//   • Photon (Komoot) + Nominatim: place search & reverse geocoding (OSM data)
//   • Open-Meteo: current weather and winds aloft (250 hPa jet-stream level)
//   • Wikipedia REST & Action APIs: landmark summaries, photos, nearby places
// Every call has a timeout, a small in-memory cache and a polite rate limit.
import { decodePolyline } from './geo.js';

export const ENDPOINTS = {
  osrm: {
    car: ['https://router.project-osrm.org/route/v1/driving', 'https://routing.openstreetmap.de/routed-car/route/v1/driving'],
    bike: ['https://routing.openstreetmap.de/routed-bike/route/v1/driving'],
    foot: ['https://routing.openstreetmap.de/routed-foot/route/v1/driving'],
  },
  photon: 'https://photon.komoot.io',
  nominatim: 'https://nominatim.openstreetmap.org',
  meteo: 'https://api.open-meteo.com/v1/forecast',
  wikiRest: 'https://en.wikipedia.org/api/rest_v1',
  wikiApi: 'https://en.wikipedia.org/w/api.php',
};

const cache = new Map();
const lastCall = new Map();

async function fetchJson(url, { timeout = 15000, minIntervalMs = 0, key = url } = {}) {
  if (cache.has(key)) return cache.get(key);
  if (minIntervalMs) {
    const host = new URL(url).host;
    const wait = (lastCall.get(host) || 0) + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall.set(host, Date.now());
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new ServiceError(`HTTP ${res.status}`, res.status);
    const json = await res.json();
    cache.set(key, json);
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new ServiceError('Request timed out');
    throw err instanceof ServiceError ? err : new ServiceError(err.message || 'Network error');
  } finally {
    clearTimeout(t);
  }
}

export class ServiceError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
  }
}

// ── Road routing ──────────────────────────────────────────────────────────

/**
 * Real road route from OpenStreetMap via OSRM.
 * @returns {{coords, distanceM, durationS, speeds: Float32Array, steps: object[]}}
 *   speeds[i] = typical speed (m/s) on segment i (coords[i] → coords[i+1]),
 *   steps = turn-by-turn maneuvers with their distance along the route.
 */
export async function roadRoute(profile, from, to) {
  const servers = ENDPOINTS.osrm[profile];
  const q = `${from[0].toFixed(6)},${from[1].toFixed(6)};${to[0].toFixed(6)},${to[1].toFixed(6)}`;
  const params = 'overview=full&geometries=polyline6&steps=true&annotations=distance,duration';
  let lastErr;
  for (const base of servers) {
    try {
      const json = await fetchJson(`${base}/${q}?${params}`, { timeout: 25000 });
      if (json.code !== 'Ok' || !json.routes?.length) {
        throw new ServiceError(json.code === 'NoRoute' ? 'No road connects these places' : json.message || json.code);
      }
      return parseOsrm(json.routes[0]);
    } catch (err) {
      lastErr = err;
      if (/No road/.test(err.message)) break;
    }
  }
  throw lastErr || new ServiceError('Routing unavailable');
}

export function parseOsrm(route) {
  const coords = decodePolyline(route.geometry, 6);
  const leg = route.legs[0];
  const ann = leg.annotation;
  const n = coords.length - 1;
  const speeds = new Float32Array(Math.max(1, n));
  if (ann && ann.distance?.length === n) {
    for (let i = 0; i < n; i++) speeds[i] = ann.duration[i] > 0 ? ann.distance[i] / ann.duration[i] : 0;
    // Fill zero-duration segments from neighbours.
    for (let i = 0; i < n; i++) if (!speeds[i]) speeds[i] = speeds[i - 1] || route.distance / Math.max(1, route.duration);
  } else {
    speeds.fill(route.distance / Math.max(1, route.duration));
  }
  let along = 0;
  const steps = [];
  for (const s of leg.steps) {
    steps.push({
      along,
      distance: s.distance,
      duration: s.duration,
      type: s.maneuver.type,
      modifier: s.maneuver.modifier || '',
      exit: s.maneuver.exit,
      bearingAfter: s.maneuver.bearing_after,
      location: s.maneuver.location,
      name: s.name || '',
      ref: s.ref || '',
      destinations: s.destinations || '',
      exits: s.exits || '',
      rotary: s.rotary_name || '',
      text: instruction(s),
    });
    along += s.distance;
  }
  return { coords, distanceM: route.distance, durationS: route.duration, speeds, steps };
}

const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
const DIRS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/** Human turn instruction in the style of osrm-text-instructions. */
export function instruction(s) {
  const m = s.maneuver;
  const way = s.ref && s.name ? `${s.name} (${s.ref})` : s.name || s.ref || '';
  const onto = way ? ` onto ${way}` : '';
  const mod = (m.modifier || '').replace('sharp ', 'sharp ').replace('slight ', 'slight ');
  const toward = s.destinations ? ` toward ${s.destinations.split(':').pop().trim()}` : '';
  switch (m.type) {
    case 'depart':
      return `Head ${DIRS[Math.round(((m.bearing_after || 0) % 360) / 45) % 8]}${way ? ` on ${way}` : ''}`;
    case 'arrive':
      return 'You have arrived at your destination';
    case 'turn':
      return mod === 'uturn' ? `Make a U-turn${onto}` : `Turn ${mod}${onto}`;
    case 'new name':
      return `Continue${onto}`;
    case 'continue':
      return mod === 'uturn' ? 'Make a U-turn' : `Continue ${mod === 'straight' ? 'straight' : mod}${onto}`.replace('  ', ' ');
    case 'merge':
      return `Merge ${mod}${onto}`.replace('  ', ' ');
    case 'on ramp':
      return `Take the ramp${mod && mod !== 'straight' ? ` on the ${mod.replace('slight ', '')}` : ''}${onto}${toward}`;
    case 'off ramp':
      return `Take the exit${s.exits ? ` ${s.exits.split(';')[0]}` : ''}${toward || onto}`;
    case 'fork':
      return `Keep ${mod.replace('slight ', '')} at the fork${toward || onto}`;
    case 'end of road':
      return `Turn ${mod} at the end of the road${onto}`;
    case 'roundabout':
    case 'rotary':
      return `At the ${s.rotary_name || 'roundabout'}, take the ${ORDINAL[m.exit] || 'next'} exit${onto}`;
    case 'roundabout turn':
      return `At the roundabout, turn ${mod}${onto}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `Exit the roundabout${onto}`;
    case 'notification':
      return `Continue${onto}`;
    default:
      return `Continue${onto}`;
  }
}

// ── Geocoding ─────────────────────────────────────────────────────────────

/** Place search (Photon, falls back to Nominatim). Returns [{name, label, coord, iso}]. */
export async function searchPlaces(query, near) {
  const q = query.trim();
  if (q.length < 2) return [];
  try {
    const bias = near ? `&lat=${near[1].toFixed(3)}&lon=${near[0].toFixed(3)}` : '';
    const json = await fetchJson(`${ENDPOINTS.photon}/api/?q=${encodeURIComponent(q)}&limit=7&lang=en${bias}`, { timeout: 8000 });
    return json.features.map((f) => {
      const p = f.properties;
      const parts = [p.name, p.city !== p.name ? p.city : null, p.state, p.country].filter(Boolean);
      return {
        name: p.name || p.city || q,
        label: [...new Set(parts)].join(', '),
        coord: f.geometry.coordinates,
        iso: (p.countrycode || '').toUpperCase(),
        kind: 'place',
      };
    });
  } catch {
    const json = await fetchJson(`${ENDPOINTS.nominatim}/search?format=jsonv2&limit=7&addressdetails=1&q=${encodeURIComponent(q)}`, {
      timeout: 10000,
      minIntervalMs: 1100,
    });
    return json.map((r) => ({
      name: r.name || r.display_name.split(',')[0],
      label: r.display_name,
      coord: [Number(r.lon), Number(r.lat)],
      iso: (r.address?.country_code || '').toUpperCase(),
      kind: 'place',
    }));
  }
}

/** Nearest locality name for a coordinate (Photon reverse; rate-limited). */
export async function reverseLocality(coord) {
  const key = `rev:${coord[0].toFixed(2)},${coord[1].toFixed(2)}`;
  try {
    const json = await fetchJson(`${ENDPOINTS.photon}/reverse?lat=${coord[1].toFixed(5)}&lon=${coord[0].toFixed(5)}&lang=en&limit=1`, {
      timeout: 8000,
      minIntervalMs: 1500,
      key,
    });
    const p = json.features?.[0]?.properties;
    if (!p) return null;
    return {
      locality: p.city || p.town || p.village || p.name || p.county || p.state || '',
      region: p.state || '',
      country: p.country || '',
    };
  } catch {
    return null;
  }
}

// ── Weather ───────────────────────────────────────────────────────────────

/** WMO weather interpretation codes → description + emoji. */
export const WMO = {
  0: ['Clear sky', '☀️'],
  1: ['Mainly clear', '🌤️'],
  2: ['Partly cloudy', '⛅'],
  3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'],
  48: ['Depositing rime fog', '🌫️'],
  51: ['Light drizzle', '🌦️'],
  53: ['Drizzle', '🌦️'],
  55: ['Dense drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'],
  57: ['Freezing drizzle', '🌧️'],
  61: ['Slight rain', '🌦️'],
  63: ['Rain', '🌧️'],
  65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'],
  67: ['Freezing rain', '🌧️'],
  71: ['Slight snow', '🌨️'],
  73: ['Snow', '🌨️'],
  75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'],
  80: ['Rain showers', '🌦️'],
  81: ['Rain showers', '🌧️'],
  82: ['Violent rain showers', '⛈️'],
  85: ['Snow showers', '🌨️'],
  86: ['Heavy snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm with hail', '⛈️'],
  99: ['Thunderstorm with hail', '⛈️'],
};

/** Current conditions + local time zone at a coordinate. */
export async function weatherAt(coord) {
  const key = `wx:${coord[0].toFixed(1)},${coord[1].toFixed(1)}:${Math.floor(Date.now() / 900000)}`;
  const url =
    `${ENDPOINTS.meteo}?latitude=${coord[1].toFixed(3)}&longitude=${coord[0].toFixed(3)}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,visibility,is_day,pressure_msl' +
    '&wind_speed_unit=kmh&timezone=auto';
  const j = await fetchJson(url, { timeout: 10000, key });
  const c = j.current;
  const [text, icon] = WMO[c.weather_code] || ['Unknown', '🌡️'];
  return {
    tempC: c.temperature_2m,
    feelsC: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    code: c.weather_code,
    text,
    icon,
    windKmh: c.wind_speed_10m,
    windDir: c.wind_direction_10m,
    gustKmh: c.wind_gusts_10m,
    cloud: c.cloud_cover,
    visibilityM: c.visibility,
    pressure: c.pressure_msl,
    isDay: !!c.is_day,
    timezone: j.timezone,
    utcOffsetS: j.utc_offset_seconds,
  };
}

/** Wind at the 250 hPa level (~FL340, jet-stream altitude): { fromDeg, kts }. */
export async function windsAloft(coord) {
  const url =
    `${ENDPOINTS.meteo}?latitude=${coord[1].toFixed(2)}&longitude=${coord[0].toFixed(2)}` +
    '&hourly=wind_speed_250hPa,wind_direction_250hPa&wind_speed_unit=kn&forecast_days=1&timezone=GMT';
  const j = await fetchJson(url, { timeout: 10000 });
  const h = new Date().getUTCHours();
  return { fromDeg: j.hourly.wind_direction_250hPa[h], kts: j.hourly.wind_speed_250hPa[h] };
}

// ── Wikipedia ─────────────────────────────────────────────────────────────

/** Article summary: title, extract, thumbnail, coordinates, page URL. */
export async function wikiSummary(title) {
  const j = await fetchJson(`${ENDPOINTS.wikiRest}/page/summary/${encodeURIComponent(title)}`, { timeout: 10000 });
  return {
    title: j.title,
    description: j.description || '',
    extract: j.extract || '',
    image: j.originalimage?.source || j.thumbnail?.source || null,
    thumb: j.thumbnail?.source || null,
    url: j.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    coord: j.coordinates ? [j.coordinates.lon, j.coordinates.lat] : null,
  };
}

/** Notable places with Wikipedia articles near a coordinate. */
export async function wikiNearby(coord, radiusM = 10000, limit = 8) {
  const key = `geo:${coord[0].toFixed(2)},${coord[1].toFixed(2)}:${radiusM}`;
  const url =
    `${ENDPOINTS.wikiApi}?action=query&list=geosearch&format=json&origin=*` +
    `&gscoord=${coord[1].toFixed(5)}|${coord[0].toFixed(5)}&gsradius=${Math.min(10000, radiusM)}&gslimit=${limit}`;
  const j = await fetchJson(url, { timeout: 10000, minIntervalMs: 800, key });
  return (j.query?.geosearch || []).map((g) => ({
    title: g.title,
    coord: [g.lon, g.lat],
    distM: g.dist,
    pageId: g.pageid,
  }));
}
