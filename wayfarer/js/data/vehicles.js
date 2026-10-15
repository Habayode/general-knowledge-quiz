// Vehicle specifications. Figures are manufacturer / published values, rounded.
// `mode` selects the routing engine and protocols; `profile` the OSRM profile.

export const VEHICLES = {
  // ── Road ────────────────────────────────────────────────────────────────
  sedan: {
    mode: 'drive',
    profile: 'car',
    name: 'Toyota Corolla Hybrid',
    kind: 'Sedan · 1.8 L hybrid · e-CVT',
    icon: 'car',
    topSpeedKmh: 180,
    tankL: 43,
    lPer100: 4.5,
    seats: 5,
    co2gPerKm: 102,
    color: '#e8eef7',
  },
  suv: {
    mode: 'drive',
    profile: 'car',
    name: 'Toyota Land Cruiser 300',
    kind: '4×4 SUV · 3.3 L twin-turbo V6 diesel',
    icon: 'suv',
    topSpeedKmh: 210,
    tankL: 110,
    lPer100: 10.1,
    seats: 7,
    co2gPerKm: 266,
    color: '#3b4a5a',
  },
  ev: {
    mode: 'drive',
    profile: 'car',
    name: 'Tesla Model 3 Long Range',
    kind: 'Electric · dual motor AWD',
    icon: 'ev',
    topSpeedKmh: 201,
    batteryKWh: 79,
    kWhPer100: 14.8,
    rangeKm: 629,
    seats: 5,
    co2gPerKm: 0,
    color: '#c8102e',
  },
  motorbike: {
    mode: 'drive',
    profile: 'car',
    name: 'BMW R 1300 GS',
    kind: 'Adventure motorcycle · 1300 cc boxer',
    icon: 'motorbike',
    topSpeedKmh: 220,
    tankL: 19,
    lPer100: 4.8,
    seats: 2,
    co2gPerKm: 112,
    color: '#1c69d4',
  },
  bicycle: {
    mode: 'bike',
    profile: 'bike',
    name: 'Road / touring bicycle',
    kind: 'Human-powered · 2×11 speed',
    icon: 'bicycle',
    cruiseKmh: 20,
    seats: 1,
    co2gPerKm: 0,
    color: '#f2a900',
  },
  walk: {
    mode: 'walk',
    profile: 'foot',
    name: 'On foot',
    kind: 'Walking · 5 km/h',
    icon: 'walk',
    cruiseKmh: 5,
    seats: 1,
    co2gPerKm: 0,
    color: '#6fcf97',
  },

  // ── Air ─────────────────────────────────────────────────────────────────
  a320neo: {
    mode: 'fly',
    name: 'Airbus A320neo',
    kind: 'Narrow-body · 2× CFM LEAP-1A',
    icon: 'plane',
    cruiseMach: 0.78,
    cruiseFL: [350, 370],
    rangeKm: 6300,
    seats: 180,
    v2Kts: 145,
    approachKts: 138,
    burnKgPerH: 2400,
    co2gPerPaxKm: 75,
  },
  b787: {
    mode: 'fly',
    name: 'Boeing 787-9 Dreamliner',
    kind: 'Wide-body · 2× GEnx-1B / Trent 1000',
    icon: 'plane',
    cruiseMach: 0.85,
    cruiseFL: [380, 410],
    rangeKm: 14000,
    seats: 290,
    v2Kts: 165,
    approachKts: 150,
    burnKgPerH: 5600,
    co2gPerPaxKm: 85,
  },
  a350ulr: {
    mode: 'fly',
    name: 'Airbus A350-900ULR',
    kind: 'Ultra-long-range wide-body · 2× Trent XWB',
    icon: 'plane',
    cruiseMach: 0.85,
    cruiseFL: [390, 430],
    rangeKm: 18000,
    seats: 161,
    v2Kts: 165,
    approachKts: 145,
    burnKgPerH: 6200,
    co2gPerPaxKm: 105,
  },

  // ── Sea ─────────────────────────────────────────────────────────────────
  ferry: {
    mode: 'sail',
    name: 'Ro-Pax car ferry',
    kind: 'Roll-on/roll-off passenger ferry · ~1,500 pax',
    icon: 'ferry',
    serviceKnots: 21,
    seats: 1500,
    co2gPerPaxKm: 120,
    carDeck: true,
  },
  cruise: {
    mode: 'sail',
    name: 'Ocean cruise ship',
    kind: 'Oasis-class style · 230,000 GT',
    icon: 'ship',
    serviceKnots: 20,
    seats: 5600,
    co2gPerPaxKm: 250,
    carDeck: false,
  },
  expedition: {
    mode: 'sail',
    name: 'Polar expedition ship',
    kind: 'PC6 ice-class · 200 guests',
    icon: 'ship',
    serviceKnots: 14,
    seats: 200,
    co2gPerPaxKm: 400,
    carDeck: false,
  },
};

/** Pick a realistic aircraft for a sector length (km). */
export function aircraftFor(km) {
  if (km <= 4500) return 'a320neo';
  if (km <= 13500) return 'b787';
  return 'a350ulr';
}

/** Pick a vessel for a sea crossing. */
export function vesselFor(km, toIso, fromIso) {
  if (toIso === 'AQ' || fromIso === 'AQ') return 'expedition';
  return km <= 600 ? 'ferry' : 'cruise';
}
