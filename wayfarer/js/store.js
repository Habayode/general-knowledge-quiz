// Traveller profile, passport, wallet and statistics, persisted per browser.
// localStorage can be unavailable (private mode, blocked storage): every access
// is guarded and the game runs from memory if it fails.

const KEY = 'wayfarer.v1';

const DEFAULT = () => ({
  profile: null, // { name, nationality (ISO), home: Place, passportNo, createdAt }
  wallet: 5000,
  xp: 0,
  stamps: [], // { iso, country, date, port, mode, kind: 'entry'|'exit'|'border' }
  visited: {}, // iso -> { name, continent, first }
  continents: {},
  landmarks: {}, // id -> date
  stats: { driveKm: 0, bikeKm: 0, walkKm: 0, flyKm: 0, sailKm: 0, flights: 0, voyages: 0, borders: 0, co2kg: 0, spent: 0, hours: 0 },
  achievements: {}, // id -> date
  ledger: [], // { date, amount, label }
  settings: { voice: true, sound: true, autoChecks: false, labels: true, buildings: true, units: 'metric', timeScale: 60 },
  trips: [],
});

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT();
    const data = JSON.parse(raw);
    const d = DEFAULT();
    return { ...d, ...data, stats: { ...d.stats, ...data.stats }, settings: { ...d.settings, ...data.settings } };
  } catch {
    return DEFAULT();
  }
}

export const state = load();
const listeners = new Set();

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: keep playing from memory.
  }
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function reset() {
  Object.assign(state, DEFAULT());
  save();
}

/** Spend money. Returns false (and spends nothing) if funds are insufficient. */
export function spend(amount, label, date = Date.now()) {
  const amt = Math.round(amount * 100) / 100;
  if (amt > state.wallet + 1e-6) return false;
  state.wallet = Math.round((state.wallet - amt) * 100) / 100;
  state.stats.spent += amt;
  state.ledger.unshift({ date, amount: -amt, label });
  state.ledger.length = Math.min(state.ledger.length, 200);
  save();
  return true;
}

export function earn(amount, label, date = Date.now()) {
  state.wallet = Math.round((state.wallet + amount) * 100) / 100;
  state.ledger.unshift({ date, amount, label });
  state.ledger.length = Math.min(state.ledger.length, 200);
  save();
}

/** Record presence in a country (and its continent). Returns true if first visit. */
export function visit(country, date) {
  if (!country || country.iso === '-99') return false;
  const first = !state.visited[country.iso];
  if (first) {
    state.visited[country.iso] = { name: country.name, continent: country.continent, first: date };
    state.xp += 250;
  }
  if (country.continent && !state.continents[country.continent]) state.continents[country.continent] = date;
  save();
  return first;
}

export function addStamp(stamp) {
  state.stamps.push(stamp);
  save();
}

export function addXp(n) {
  state.xp += Math.round(n);
  save();
}

export const LEVELS = [
  [0, 'Day Tripper'],
  [1000, 'Tourist'],
  [4000, 'Traveller'],
  [10000, 'Explorer'],
  [25000, 'Voyager'],
  [60000, 'Globetrotter'],
  [150000, 'Legend of the Road'],
];

export function level(xp = state.xp) {
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) if (xp >= LEVELS[i][0]) idx = i;
  const next = LEVELS[idx + 1];
  return { idx, name: LEVELS[idx][1], next: next ? next[0] : null, base: LEVELS[idx][0] };
}

export const ACHIEVEMENTS = {
  'first-drive': ['🚗', 'Hit the Road', 'Complete your first road trip'],
  'first-flight': ['✈️', 'Wheels Up', 'Complete your first flight'],
  'first-voyage': ['🚢', 'Sea Legs', 'Complete your first sea voyage'],
  'first-ride': ['🚲', 'Pedal Power', 'Complete your first bike ride'],
  multimodal: ['🧭', 'Door to Door', 'Finish a journey that combines three modes of transport'],
  equator: ['🌐', 'Line Crosser', 'Cross the Equator'],
  dateline: ['📅', 'Time Traveller', 'Cross the International Date Line'],
  arctic: ['🧊', 'Bluenose', 'Cross the Arctic Circle'],
  antarctic: ['🐧', 'Polar Explorer', 'Cross the Antarctic Circle'],
  border: ['🛂', 'Frontier', 'Cross a land border'],
  'five-countries': ['🗺️', 'Passport Filling Up', 'Visit 5 countries'],
  'twenty-countries': ['🌍', 'Citizen of the World', 'Visit 20 countries'],
  'three-continents': ['🧳', 'Intercontinental', 'Visit 3 continents'],
  'seven-continents': ['🏆', 'Seven Summits of Travel', 'Visit all 7 continents'],
  'long-haul': ['🌙', 'Ultra Long Haul', 'Fly a sector longer than 12,000 km'],
  'road-1000': ['🛣️', 'Thousand-Mile Club', 'Drive 1,609 km in total'],
  landmarks10: ['📸', 'Sightseer', 'Visit 10 landmarks'],
  canal: ['⚓', 'Through the Locks', 'Sail through the Panama or Suez Canal'],
};

/** Unlock an achievement once. Returns the definition if newly unlocked. */
export function unlock(id, date = Date.now()) {
  if (state.achievements[id] || !ACHIEVEMENTS[id]) return null;
  state.achievements[id] = date;
  state.xp += 500;
  save();
  return ACHIEVEMENTS[id];
}
