// The 3D globe: real satellite imagery, terrain, 3D buildings, night lights,
// routes, vehicle markers and the follow camera.
//
// Imagery & data (all free, key-less):
//   • Esri World Imagery (Maxar, Earthstar Geographics) + Esri reference overlays
//   • Terrain: Mapzen/AWS Terrarium elevation tiles (SRTM, GMTED, ETOPO1)
//   • 3D buildings & fonts: OpenFreeMap (OpenStreetMap data)
//   • Night lights: NASA GIBS VIIRS Black Marble
/* global maplibregl */
import { sunElevation, normalizeLon, nightPolygon } from './geo.js';
import { AIRPORTS } from './data/airports.js';
import { PORTS } from './data/ports.js';
import { LANDMARKS } from './data/landmarks.js';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
export const MODE_COLORS = { drive: '#4fc3f7', motorbike: '#4fc3f7', bike: '#ffd54f', walk: '#81c784', fly: '#ffffff', sail: '#26c6da' };

export function createStyle() {
  return {
    version: 8,
    projection: { type: 'globe' },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sky: {
      'sky-color': '#0b1d3a',
      'horizon-color': '#9ec9ff',
      'fog-color': '#cfe3ff',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.2,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 8, 0.4, 12, 0],
    },
    light: { anchor: 'map', position: [1.5, 210, 30], intensity: 0.35 },
    sources: {
      satellite: {
        type: 'raster',
        tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
        tileSize: 256,
        maxzoom: 19,
        attribution:
          'Imagery © <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community',
      },
      night: {
        type: 'raster',
        tiles: [
          'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
        ],
        tileSize: 256,
        maxzoom: 8,
        attribution: 'Night lights: <a href="https://earthdata.nasa.gov/" target="_blank" rel="noopener">NASA GIBS</a> Black Marble',
      },
      roads: {
        type: 'raster',
        tiles: [`${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`],
        tileSize: 256,
        maxzoom: 19,
      },
      places: {
        type: 'raster',
        tiles: [`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`],
        tileSize: 256,
        maxzoom: 19,
      },
      terrain: {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 15,
        encoding: 'terrarium',
        attribution: 'Terrain: <a href="https://github.com/tilezen/joerd" target="_blank" rel="noopener">Mapzen Terrarium</a>',
      },
      osm: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution:
          '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
      route: { type: 'geojson', data: empty() },
      done: { type: 'geojson', data: empty() },
      terminals: { type: 'geojson', data: terminalsGeoJSON() },
      stops: { type: 'geojson', data: empty() },
      shade: { type: 'geojson', data: empty() },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#04101f' } },
      { id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-fade-duration': 200 } },
      { id: 'night', type: 'raster', source: 'night', paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 } },
      // Day/night terminator with civil, nautical and astronomical twilight bands.
      { id: 'shade', type: 'fill', source: 'shade', paint: { 'fill-color': '#020814', 'fill-opacity': 0.14, 'fill-antialias': false } },
      { id: 'roads', type: 'raster', source: 'roads', minzoom: 6, paint: { 'raster-opacity': 0.75 } },
      { id: 'places', type: 'raster', source: 'places', paint: { 'raster-opacity': 0.95 } },
      {
        id: 'buildings',
        type: 'fill-extrusion',
        source: 'osm',
        'source-layer': 'building',
        minzoom: 14.5,
        paint: {
          'fill-extrusion-color': '#d9dde3',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15.5, 0.55],
        },
      },
      {
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#00111f', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 3, 14, 10] },
      },
      {
        id: 'route',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'match',
            ['get', 'mode'],
            'fly',
            MODE_COLORS.fly,
            'sail',
            MODE_COLORS.sail,
            'bike',
            MODE_COLORS.bike,
            'walk',
            MODE_COLORS.walk,
            MODE_COLORS.drive,
          ],
          'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.6, 14, 6],
          'line-dasharray': [2, 1.6],
          'line-opacity': 0.9,
        },
      },
      {
        id: 'done',
        type: 'line',
        source: 'done',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ff6d3a', 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 2.4, 14, 7], 'line-opacity': 0.95 },
      },
      {
        id: 'terminals',
        type: 'circle',
        source: 'terminals',
        minzoom: 4,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2.5, 10, 6],
          'circle-color': ['match', ['get', 'kind'], 'airport', '#ffffff', 'port', '#26c6da', '#ffd54f'],
          'circle-stroke-color': '#0a1a2e',
          'circle-stroke-width': 1.5,
        },
      },
      {
        id: 'terminal-labels',
        type: 'symbol',
        source: 'terminals',
        minzoom: 4.5,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 11,
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#0a1a2e', 'text-halo-width': 1.6 },
      },
      {
        id: 'stops',
        type: 'circle',
        source: 'stops',
        paint: { 'circle-radius': 7, 'circle-color': '#ff6d3a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 },
      },
    ],
  };
}

function empty() {
  return { type: 'FeatureCollection', features: [] };
}

function terminalsGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: [
      ...AIRPORTS.map((a) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: a.coord },
        properties: { kind: 'airport', id: a.iata, label: `✈ ${a.iata}` },
      })),
      ...PORTS.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: p.coord },
        properties: { kind: 'port', id: p.id, label: `⚓ ${p.city}` },
      })),
      ...LANDMARKS.map((l) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: l.coord },
        properties: { kind: 'landmark', id: l.id, label: `★ ${l.name}` },
      })),
    ],
  };
}

// ── Vehicle icons (top-down silhouettes, drawn nose-up) ───────────────────
const ICONS = {
  car: `<svg viewBox="0 0 40 80"><defs><linearGradient id="cb" x1="0" x2="1"><stop offset="0" stop-color="#b8c4d4"/><stop offset=".5" stop-color="#f4f7fb"/><stop offset="1" stop-color="#b8c4d4"/></linearGradient></defs><rect x="4" y="4" width="32" height="72" rx="12" fill="url(#cb)" stroke="#2b3645" stroke-width="2"/><path d="M8 24 Q20 16 32 24 L30 34 Q20 30 10 34Z" fill="#1d2a3a"/><path d="M10 58 Q20 62 30 58 L31 66 Q20 70 9 66Z" fill="#1d2a3a"/><rect x="7" y="5" width="6" height="4" rx="2" fill="#fffbe0"/><rect x="27" y="5" width="6" height="4" rx="2" fill="#fffbe0"/><rect x="7" y="71" width="6" height="3" rx="1.5" fill="#e33"/><rect x="27" y="71" width="6" height="3" rx="1.5" fill="#e33"/></svg>`,
  suv: `<svg viewBox="0 0 44 84"><rect x="4" y="4" width="36" height="76" rx="9" fill="#3b4a5a" stroke="#111a24" stroke-width="2"/><path d="M8 22 Q22 15 36 22 L34 32 Q22 28 10 32Z" fill="#0d1620"/><rect x="9" y="38" width="26" height="22" rx="3" fill="#2a3746" stroke="#5c6e82"/><path d="M10 64 L34 64 L33 72 L11 72Z" fill="#0d1620"/><rect x="7" y="5" width="7" height="4" rx="2" fill="#fffbe0"/><rect x="30" y="5" width="7" height="4" rx="2" fill="#fffbe0"/></svg>`,
  ev: `<svg viewBox="0 0 40 80"><rect x="4" y="4" width="32" height="72" rx="14" fill="#c8102e" stroke="#4a0610" stroke-width="2"/><path d="M8 22 Q20 14 32 22 L31 60 Q20 66 9 60Z" fill="#141b24" opacity=".92"/><path d="M8 5 Q20 2 32 5" stroke="#fffbe0" stroke-width="3" fill="none"/><rect x="6" y="72" width="28" height="2.5" rx="1" fill="#f33"/></svg>`,
  motorbike: `<svg viewBox="0 0 24 70"><rect x="9" y="2" width="6" height="14" rx="3" fill="#222"/><rect x="9" y="54" width="6" height="14" rx="3" fill="#222"/><rect x="6" y="14" width="12" height="40" rx="6" fill="#1c69d4" stroke="#0b2a55" stroke-width="1.5"/><rect x="1" y="18" width="22" height="3" rx="1.5" fill="#333"/><circle cx="12" cy="34" r="6" fill="#f2f2f2" stroke="#333"/><circle cx="12" cy="4" r="2" fill="#fffbe0"/></svg>`,
  bicycle: `<svg viewBox="0 0 24 64"><rect x="10" y="2" width="4" height="16" rx="2" fill="#222"/><rect x="10" y="46" width="4" height="16" rx="2" fill="#222"/><path d="M12 14 L12 50" stroke="#f2a900" stroke-width="3"/><rect x="2" y="16" width="20" height="2.5" rx="1" fill="#444"/><circle cx="12" cy="30" r="7" fill="#e34a2f" stroke="#7a1d0e"/><circle cx="12" cy="27" r="4" fill="#ffd9b5"/></svg>`,
  walk: `<svg viewBox="0 0 30 30"><circle cx="15" cy="15" r="10" fill="#6fcf97" stroke="#14532d" stroke-width="2"/><circle cx="15" cy="13" r="4" fill="#fff"/><path d="M15 3 L19 9 L11 9Z" fill="#14532d"/></svg>`,
  plane: `<svg viewBox="0 0 100 100"><path d="M50 4 C53 4 55 10 55 16 L55 38 L94 58 L94 64 L55 54 L55 80 L66 88 L66 93 L50 89 L34 93 L34 88 L45 80 L45 54 L6 64 L6 58 L45 38 L45 16 C45 10 47 4 50 4Z" fill="#f7f9fc" stroke="#1d2a3a" stroke-width="1.6"/><path d="M50 6 C52 6 53 9 53.5 12 L46.5 12 C47 9 48 6 50 6Z" fill="#1d2a3a"/><rect x="26" y="46" width="5" height="10" rx="2" fill="#9aa7b8"/><rect x="69" y="46" width="5" height="10" rx="2" fill="#9aa7b8"/><path d="M47 85 L53 85 L52 93 L48 93Z" fill="#c8102e"/></svg>`,
  ferry: `<svg viewBox="0 0 40 120"><path d="M20 2 C32 14 36 30 36 50 L36 112 Q36 118 30 118 L10 118 Q4 118 4 112 L4 50 C4 30 8 14 20 2Z" fill="#f4f6f8" stroke="#1d2a3a" stroke-width="2"/><rect x="9" y="40" width="22" height="58" rx="3" fill="#dfe6ee" stroke="#8796a8"/><rect x="11" y="44" width="18" height="10" rx="2" fill="#1d4e89"/><circle cx="20" cy="80" r="5" fill="#d33"/><rect x="8" y="100" width="24" height="12" rx="2" fill="#2d6cdf"/></svg>`,
  ship: `<svg viewBox="0 0 44 150"><path d="M22 2 C36 18 40 38 40 62 L40 140 Q40 148 32 148 L12 148 Q4 148 4 140 L4 62 C4 38 8 18 22 2Z" fill="#fbfcfd" stroke="#1d2a3a" stroke-width="2"/><rect x="9" y="30" width="26" height="104" rx="5" fill="#e9eef3" stroke="#9aa8b8"/><rect x="12" y="36" width="20" height="12" rx="2" fill="#1d4e89"/><rect x="14" y="56" width="16" height="30" rx="3" fill="#2aa7d6"/><rect x="14" y="92" width="16" height="12" rx="2" fill="#7dc27a"/><rect x="16" y="112" width="12" height="18" rx="3" fill="#1d2a3a"/></svg>`,
};

export class GlobeMap {
  constructor(container, { onReady } = {}) {
    this.map = new maplibregl.Map({
      container,
      style: createStyle(),
      center: [8, 20],
      zoom: 1.6,
      pitch: 0,
      maxPitch: 85,
      attributionControl: { compact: true },
      hash: false,
      fadeDuration: 150,
      canvasContextAttributes: { antialias: true },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.cameraMode = 'chase';
    this.follow = false;
    this.camBearing = 0;
    this.terrainOn = false;
    this.marker = null;
    this.shadow = null;
    this.vehicleKey = null;
    this.lastNightUpdate = 0;
    this.userMoved = false;
    this.map.on('dragstart', () => this.onUser());
    this.map.on('wheel', () => this.onUser());
    this.map.on('touchstart', () => this.onUser());
    this.map.on('load', () => {
      this.ready = true;
      onReady?.(this);
    });
    // Missing optional tiles (e.g. terrain/buildings offline) should never break the globe.
    this.map.on('error', (e) => {
      if (!/terrain|osm|night/.test(e?.sourceId || '')) console.warn('[map]', e?.error?.message || e);
    });
  }

  onUser() {
    if (this.follow && this.cameraMode !== 'free') {
      this.userMoved = true;
      this.onUserMove?.();
    }
  }

  setTerrain(on) {
    this.terrainOn = on;
    try {
      this.map.setTerrain(on ? { source: 'terrain', exaggeration: 1.25 } : null);
    } catch (err) {
      console.warn('terrain', err);
    }
  }

  setLayerVisible(id, on) {
    if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  /** Draw planned legs. legs: [{mode, path}] */
  showRoute(legs) {
    const features = legs
      .filter((l) => l.path)
      .map((l, i) => ({ type: 'Feature', properties: { mode: l.mode, i }, geometry: { type: 'LineString', coordinates: l.path.coords } }));
    this.map.getSource('route')?.setData({ type: 'FeatureCollection', features });
    this.map.getSource('done')?.setData(empty());
  }

  showStops(places) {
    this.map.getSource('stops')?.setData({
      type: 'FeatureCollection',
      features: places.map((p) => ({ type: 'Feature', properties: { name: p.name }, geometry: { type: 'Point', coordinates: p.coord } })),
    });
  }

  /** Travelled track: completed legs + current leg up to distance d. */
  showDone(segments) {
    this.map.getSource('done')?.setData({
      type: 'FeatureCollection',
      features: segments
        .filter((c) => c.length > 1)
        .map((coords) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } })),
    });
  }

  fitCoords(coords, padding = 80) {
    if (!coords.length) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of coords) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const pad = typeof padding === 'number' ? { top: padding, bottom: padding + 120, left: padding + 360, right: padding } : padding;
    if (window.innerWidth < 760) Object.assign(pad, { left: 30, right: 30, top: 90, bottom: 260 });
    this.map.fitBounds(
      [
        [minX, minY],
        [maxX, maxY],
      ],
      { padding: pad, duration: 2200, pitch: 0, bearing: 0, maxZoom: 15 },
    );
  }

  flyTo(coord, { zoom = 15, pitch = 60, bearing = 0, duration = 4500 } = {}) {
    this.follow = false;
    this.map.flyTo({ center: coord, zoom, pitch, bearing, duration, essential: true, curve: 1.6 });
  }

  /** Create/replace the vehicle marker. */
  setVehicle(iconKey, coord) {
    if (this.vehicleKey === iconKey && this.marker) return;
    this.removeVehicle();
    const svg = ICONS[iconKey] || ICONS.car;
    const size = {
      car: [22, 44],
      suv: [24, 46],
      ev: [22, 44],
      motorbike: [12, 34],
      bicycle: [11, 30],
      walk: [24, 24],
      plane: [60, 60],
      ferry: [22, 66],
      ship: [24, 80],
    }[iconKey] || [24, 48];
    const el = document.createElement('div');
    el.className = `vehicle vehicle-${iconKey}`;
    el.style.width = `${size[0]}px`;
    el.style.height = `${size[1]}px`;
    el.innerHTML = svg;
    this.marker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat(coord).addTo(this.map);
    if (iconKey === 'plane') {
      const sh = document.createElement('div');
      sh.className = 'vehicle-shadow';
      sh.style.width = `${size[0]}px`;
      sh.style.height = `${size[1]}px`;
      sh.innerHTML = svg;
      this.shadow = new maplibregl.Marker({ element: sh, rotationAlignment: 'map', pitchAlignment: 'map' })
        .setLngLat(coord)
        .addTo(this.map);
    }
    this.vehicleKey = iconKey;
    this.vehicleSize = size;
  }

  removeVehicle() {
    this.marker?.remove();
    this.shadow?.remove();
    this.marker = null;
    this.shadow = null;
    this.vehicleKey = null;
  }

  /**
   * Per-frame update: vehicle pose and follow camera.
   * @param {object} t telemetry { pos, heading, speedMs, altFt, mode }
   * @param {number} timeScale current sim speed (zoom out when fast)
   * @param {number} dtReal real seconds since last frame
   */
  frame(t, timeScale, dtReal) {
    if (!this.marker) return;
    const pos = [normalizeLon(t.pos[0]), t.pos[1]];
    this.marker.setLngLat(pos).setRotation(t.heading);
    const alt = t.altFt || 0;
    if (this.shadow) {
      const show = alt < 6000;
      this.shadow.getElement().style.opacity = show ? String(0.35 * (1 - alt / 6000)) : '0';
      // Sun-cast shadow drifts away from the aircraft as it climbs.
      const off = alt * 0.0000012;
      this.shadow.setLngLat([pos[0] + off, pos[1] - off]).setRotation(t.heading);
    }
    if (!this.follow || this.userMoved || this.cameraMode === 'free') return;

    const lat = pos[1];
    let zoom;
    let pitch;
    if (t.mode === 'fly') {
      zoom = 15.2 - 1.12 * Math.log2(1 + alt / 700);
      pitch = alt > 2000 ? 50 : 62;
    } else if (t.mode === 'sail') {
      zoom = 13.2;
      pitch = 58;
    } else {
      zoom = t.mode === 'walk' ? 17.6 : t.mode === 'bike' ? 17 : 16.4 - Math.min(1.6, (t.speedMs * 3.6) / 80);
      pitch = 64;
    }
    // Keep the vehicle's on-screen motion legible at high time compression.
    const mpp0 = 156543.03 * Math.cos((lat * Math.PI) / 180);
    const groundMps = Math.max(0.5, t.speedMs) * timeScale;
    const zMax = Math.log2((180 * mpp0) / groundMps);
    zoom = Math.max(2.5, Math.min(zoom, zMax));

    let bearing = this.map.getBearing();
    if (this.cameraMode === 'chase' || this.cameraMode === 'cockpit') {
      const k = Math.min(1, dtReal * 2.5);
      const diff = ((t.heading - this.camBearing + 540) % 360) - 180;
      this.camBearing = (this.camBearing + diff * k + 360) % 360;
      bearing = this.camBearing;
      if (this.cameraMode === 'cockpit') {
        pitch = Math.min(82, pitch + 16);
        zoom += 0.8;
      }
    } else if (this.cameraMode === 'top') {
      bearing = 0;
      pitch = 0;
    } else if (this.cameraMode === 'orbit') {
      this.camBearing = (this.camBearing + dtReal * 8) % 360;
      bearing = this.camBearing;
      pitch = Math.min(pitch, 68);
    }
    const center = this.cameraMode === 'cockpit' ? aheadOf(pos, t.heading, 0.00005 * 2 ** (18 - zoom) * 40) : pos;
    const cur = this.map.getZoom();
    const z = cur + (zoom - cur) * Math.min(1, dtReal * 1.5);
    const p0 = this.map.getPitch();
    this.map.jumpTo({ center, zoom: z, bearing, pitch: p0 + (pitch - p0) * Math.min(1, dtReal * 1.5) });
  }

  /**
   * Day/night from the real sun position: terminator + twilight shading on the
   * globe, then NASA night lights and dimmed imagery when zoomed into a place
   * where it is dark.
   */
  updateDaylight(date, force = false) {
    const now = performance.now();
    if (!force && now - this.lastNightUpdate < 1000) return this.night;
    this.lastNightUpdate = now;
    const simMin = Math.floor(date.getTime() / 120000);
    if (force || simMin !== this.lastShadeMin) {
      this.lastShadeMin = simMin;
      this.map.getSource('shade')?.setData({ type: 'FeatureCollection', features: [0, -6, -12, -18].map((d) => nightPolygon(date, d)) });
    }
    const c = this.map.getCenter();
    const elev = sunElevation([c.lng, c.lat], date);
    const night = Math.max(0, Math.min(1, (-elev - 2) / 10)); // past civil dusk
    const zoom = this.map.getZoom();
    const lights = zoom < 3.5 ? 0 : night * Math.min(1, (zoom - 3.5) / 1.5) * (zoom < 10 ? 0.85 : Math.max(0, 0.85 - (zoom - 10) * 0.35));
    this.map.setPaintProperty('night', 'raster-opacity', lights);
    this.map.setPaintProperty('satellite', 'raster-brightness-max', 1 - night * 0.3);
    if (this.map.getLayer('buildings')) {
      this.map.setPaintProperty('buildings', 'fill-extrusion-color', night > 0.5 ? '#3b4252' : '#d9dde3');
    }
    this.night = night;
    return night;
  }
}

function aheadOf([lon, lat], heading, deg) {
  const r = (heading * Math.PI) / 180;
  return [lon + (Math.sin(r) * deg) / Math.cos((lat * Math.PI) / 180), lat + Math.cos(r) * deg];
}
