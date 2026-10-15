// Passenger, ferry and cruise terminals.
// `coord` is the terminal berth. The pilotage approach from each berth out to
// the shipping lanes (harbour entrances, river mouths, fjords) is computed
// offline over 1:10m coastlines by tools/build-ports.mjs and stored in
// port-approaches.json. tests/sea.test.mjs sails between ports and asserts the
// track never crosses land.
//
// [id, name, city, ISO, lon, lat, kind, pilot?]
//   kind:  'ferry' (scheduled car/passenger ferry) or 'cruise' (cruise terminal)
//   pilot: optional surveyed channel waypoints from the berth through inner
//          harbours too narrow for 1:10m coastlines (Port Jackson, Göta älv).
const RAW = [
  // ── Europe ──────────────────────────────────────────────────────────────
  ['DOV', 'Port of Dover', 'Dover', 'GB', 1.333, 51.123, 'ferry'],
  ['CQF', 'Port of Calais', 'Calais', 'FR', 1.868, 50.968, 'ferry'],
  ['PME', 'Portsmouth International Port', 'Portsmouth', 'GB', -1.095, 50.812, 'ferry'],
  ['CAE', 'Caen–Ouistreham Ferry Terminal', 'Caen', 'FR', -0.248, 49.291, 'ferry'],
  ['SOU', 'Southampton Cruise Terminals', 'Southampton', 'GB', -1.41, 50.897, 'cruise'],
  ['HVH', 'Hook of Holland Ferry Terminal', 'Rotterdam', 'NL', 4.13, 51.98, 'ferry'],
  ['KEL', 'Kiel Norwegenkai', 'Kiel', 'DE', 10.143, 54.318, 'ferry'],
  ['CPH', 'Copenhagen DFDS Terminal', 'Copenhagen', 'DK', 12.605, 55.697, 'ferry'],
  ['OSL', 'Oslo Vippetangen', 'Oslo', 'NO', 10.742, 59.902, 'ferry'],
  ['GOT', 'Gothenburg Stena Terminal', 'Gothenburg', 'SE', 11.945, 57.7, 'ferry', [[11.92, 57.699], [11.89, 57.697], [11.86, 57.693], [11.83, 57.69], [11.8, 57.69]]],
  ['BGO', 'Bergen Hurtigruten Terminal', 'Bergen', 'NO', 5.318, 60.394, 'ferry'],
  ['HEL', 'Helsinki West Harbour', 'Helsinki', 'FI', 24.915, 60.152, 'ferry'],
  ['TLL', 'Tallinn Old City Harbour', 'Tallinn', 'EE', 24.772, 59.445, 'ferry'],
  ['BCN', 'Port of Barcelona', 'Barcelona', 'ES', 2.178, 41.37, 'cruise'],
  ['PMI', 'Port of Palma', 'Palma de Mallorca', 'ES', 2.635, 39.556, 'ferry'],
  ['MRS', 'Port of Marseille', 'Marseille', 'FR', 5.356, 43.322, 'cruise'],
  ['GOA', 'Port of Genoa', 'Genoa', 'IT', 8.915, 44.405, 'ferry'],
  ['CVV', 'Civitavecchia Cruise Port', 'Rome', 'IT', 11.785, 42.095, 'cruise'],
  ['NAP', 'Stazione Marittima', 'Naples', 'IT', 14.258, 40.838, 'cruise'],
  ['VCE', 'Venice Terminal Passeggeri', 'Venice', 'IT', 12.318, 45.432, 'cruise'],
  ['PIR', 'Port of Piraeus', 'Athens', 'GR', 23.636, 37.938, 'ferry'],
  ['JTR', 'Santorini Old Port (Fira)', 'Santorini', 'GR', 25.426, 36.414, 'cruise'],
  ['IST', 'Galataport', 'Istanbul', 'TR', 28.983, 41.024, 'cruise'],
  ['DBV', 'Port of Dubrovnik (Gruž)', 'Dubrovnik', 'HR', 18.08, 42.661, 'cruise'],
  ['SPU', 'Port of Split', 'Split', 'HR', 16.442, 43.503, 'ferry'],
  ['MLA', 'Valletta Cruise Port', 'Valletta', 'MT', 14.515, 35.895, 'cruise'],
  ['LIS', 'Lisbon Cruise Terminal', 'Lisbon', 'PT', -9.12, 38.71, 'cruise'],
  ['TCI', 'Port of Santa Cruz de Tenerife', 'Tenerife', 'ES', -16.24, 28.47, 'cruise'],
  ['RKV', 'Reykjavík Skarfabakki', 'Reykjavík', 'IS', -21.865, 64.155, 'cruise'],
  ['DUB', 'Dublin Port', 'Dublin', 'IE', -6.2, 53.348, 'ferry'],
  ['HLY', 'Port of Holyhead', 'Holyhead', 'GB', -4.63, 53.315, 'ferry'],

  // ── Africa ──────────────────────────────────────────────────────────────
  ['LOS', 'Lagos Port Complex (Apapa)', 'Lagos', 'NG', 3.37, 6.44, 'cruise'],
  ['TEM', 'Port of Tema', 'Accra', 'GH', 0.01, 5.63, 'cruise'],
  ['DKR', 'Port of Dakar', 'Dakar', 'SN', -17.425, 14.685, 'cruise'],
  ['CAS', 'Port of Casablanca', 'Casablanca', 'MA', -7.615, 33.61, 'cruise'],
  ['TNG', 'Tanger Med', 'Tangier', 'MA', -5.505, 35.888, 'ferry'],
  ['TAR', 'Port of Tarifa', 'Tarifa', 'ES', -5.605, 36.01, 'ferry'],
  ['ALY', 'Alexandria Cruise Terminal', 'Alexandria', 'EG', 29.875, 31.19, 'cruise'],
  ['PSD', 'Port Said', 'Port Said', 'EG', 32.31, 31.262, 'cruise'],
  ['MBA', 'Port of Mombasa (Kilindini)', 'Mombasa', 'KE', 39.66, -4.05, 'cruise'],
  ['ZNZ', 'Zanzibar Malindi Ferry Terminal', 'Zanzibar', 'TZ', 39.188, -6.157, 'ferry'],
  ['DAR', 'Dar es Salaam Kivukoni Ferry Terminal', 'Dar es Salaam', 'TZ', 39.295, -6.818, 'ferry'],
  ['CPT', 'V&A Waterfront Cruise Terminal', 'Cape Town', 'ZA', 18.43, -33.905, 'cruise'],
  ['DUR', 'Durban Cruise Terminal', 'Durban', 'ZA', 31.04, -29.87, 'cruise'],
  ['PLU', 'Port Louis Cruise Terminal', 'Port Louis', 'MU', 57.497, -20.155, 'cruise'],

  // ── Middle East & Asia ──────────────────────────────────────────────────
  ['DXB', 'Mina Rashid Cruise Terminal', 'Dubai', 'AE', 55.275, 25.27, 'cruise'],
  ['MCT', 'Port Sultan Qaboos', 'Muscat', 'OM', 58.565, 23.63, 'cruise'],
  ['BOM', 'Mumbai International Cruise Terminal', 'Mumbai', 'IN', 72.845, 18.94, 'cruise'],
  ['CMB', 'Port of Colombo', 'Colombo', 'LK', 79.845, 6.945, 'cruise'],
  ['SIN', 'Marina Bay Cruise Centre', 'Singapore', 'SG', 103.865, 1.265, 'cruise'],
  ['PEN', 'Swettenham Pier', 'Penang', 'MY', 100.345, 5.418, 'cruise'],
  ['HKG', 'Ocean Terminal, Tsim Sha Tsui', 'Hong Kong', 'HK', 114.168, 22.294, 'cruise'],
  ['SHA', 'Shanghai Wusongkou Cruise Terminal', 'Shanghai', 'CN', 121.5, 31.395, 'cruise'],
  ['PUS', 'Busan Port International Passenger Terminal', 'Busan', 'KR', 129.05, 35.1, 'ferry'],
  ['YOK', 'Osanbashi Yokohama Pier', 'Yokohama', 'JP', 139.67, 35.452, 'cruise'],
  ['UKB', 'Kobe Port Terminal', 'Kobe', 'JP', 135.195, 34.68, 'cruise'],
  ['MNL', 'Manila South Harbor', 'Manila', 'PH', 120.965, 14.59, 'cruise'],
  ['BOA', 'Benoa Harbour', 'Bali', 'ID', 115.21, -8.745, 'cruise'],

  // ── Oceania ─────────────────────────────────────────────────────────────
  ['SYD', 'Overseas Passenger Terminal, Circular Quay', 'Sydney', 'AU', 151.21, -33.858, 'cruise', [[151.215, -33.854], [151.228, -33.852], [151.245, -33.849], [151.262, -33.846]]],
  ['MEL', 'Station Pier, Port Melbourne', 'Melbourne', 'AU', 144.93, -37.845, 'cruise'],
  ['BNE', 'Brisbane International Cruise Terminal', 'Brisbane', 'AU', 153.155, -27.37, 'cruise'],
  ['AKL', 'Queens Wharf', 'Auckland', 'NZ', 174.77, -36.842, 'cruise'],
  ['WLG', 'Wellington Interislander Terminal', 'Wellington', 'NZ', 174.78, -41.27, 'ferry'],
  ['PCN', 'Picton Ferry Terminal', 'Picton', 'NZ', 174.005, -41.285, 'ferry'],
  ['SUV', 'Port of Suva', 'Suva', 'FJ', 178.425, -18.13, 'cruise'],
  ['PPT', 'Papeete Cruise Terminal', 'Papeete', 'PF', -149.57, -17.535, 'cruise'],
  ['HNL', 'Aloha Tower Marketplace Pier', 'Honolulu', 'US', -157.865, 21.307, 'cruise'],

  // ── Americas ────────────────────────────────────────────────────────────
  ['NYC', 'Manhattan Cruise Terminal', 'New York', 'US', -74.0, 40.766, 'cruise'],
  ['MIA', 'PortMiami', 'Miami', 'US', -80.17, 25.776, 'cruise'],
  ['YVR', 'Canada Place Cruise Terminal', 'Vancouver', 'CA', -123.112, 49.289, 'cruise'],
  ['LAX', 'World Cruise Center, San Pedro', 'Los Angeles', 'US', -118.278, 33.745, 'cruise'],
  ['SFO', 'James R. Herman Cruise Terminal (Pier 27)', 'San Francisco', 'US', -122.402, 37.806, 'cruise'],
  ['HAL', 'Halifax Seaport', 'Halifax', 'CA', -63.565, 44.64, 'cruise'],
  ['HAV', 'Sierra Maestra Cruise Terminal', 'Havana', 'CU', -82.352, 23.138, 'cruise'],
  ['NAS', 'Nassau Cruise Port', 'Nassau', 'BS', -77.342, 25.08, 'cruise'],
  ['CZM', 'Cozumel Cruise Piers', 'Cozumel', 'MX', -86.95, 20.5, 'cruise'],
  ['CTG', 'Cartagena Cruise Terminal', 'Cartagena', 'CO', -75.53, 10.41, 'cruise'],
  ['ONX', 'Colón 2000 Cruise Terminal', 'Colón', 'PA', -79.9, 9.36, 'cruise'],
  ['RIO', 'Píer Mauá Cruise Terminal', 'Rio de Janeiro', 'BR', -43.18, -22.894, 'cruise'],
  ['SSZ', 'Port of Santos', 'Santos', 'BR', -46.31, -23.98, 'cruise'],
  ['BUE', 'Buquebus Terminal, Puerto Madero', 'Buenos Aires', 'AR', -58.365, -34.594, 'ferry'],
  ['MVD', 'Port of Montevideo', 'Montevideo', 'UY', -56.215, -34.905, 'ferry'],
  ['USH', 'Port of Ushuaia', 'Ushuaia', 'AR', -68.295, -54.81, 'cruise'],
  ['LKY', 'Port Lockroy (Goudier Island)', 'Antarctic Peninsula', 'AQ', -63.495, -64.826, 'cruise'],
  ['VAP', 'Port of Valparaíso', 'Valparaíso', 'CL', -71.625, -33.03, 'cruise'],
  ['CLL', 'Port of Callao', 'Lima', 'PE', -77.15, -12.05, 'cruise'],
];

export const PORTS = RAW.map(([id, name, city, iso, lon, lat, kind, pilot = []]) => ({
  id,
  name,
  city,
  iso,
  coord: [lon, lat],
  kind,
  pilot,
}));

export const PORT_BY_ID = new Map(PORTS.map((p) => [p.id, p]));
