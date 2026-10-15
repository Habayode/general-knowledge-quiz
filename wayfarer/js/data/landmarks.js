// World landmarks: exact coordinates, English Wikipedia article (live summary,
// photo and facts are fetched at runtime) and a camera framing tuned for the
// satellite view. Validated by tests/data.test.mjs (coordinate inside country).
//
// [id, name, city, ISO, lat, lon, wikipedia title, zoom, pitch, bearing]
const RAW = [
  // ── Africa ──
  ['giza', 'Great Pyramid of Giza', 'Giza', 'EG', 29.9792, 31.1342, 'Great_Pyramid_of_Giza', 16.6, 60, 30],
  ['karnak', 'Karnak Temple Complex', 'Luxor', 'EG', 25.7188, 32.6573, 'Karnak', 16.4, 55, 300],
  ['victoria-falls', 'Victoria Falls', 'Livingstone / Victoria Falls', 'ZM', -17.9243, 25.8572, 'Victoria_Falls', 14.8, 62, 200],
  ['table-mountain', 'Table Mountain', 'Cape Town', 'ZA', -33.9628, 18.4098, 'Table_Mountain', 13.4, 68, 160],
  ['kilimanjaro', 'Mount Kilimanjaro (Kibo)', 'Kilimanjaro', 'TZ', -3.0674, 37.3556, 'Mount_Kilimanjaro', 12.2, 70, 0],
  ['zuma-rock', 'Zuma Rock', 'Madalla', 'NG', 9.1278, 7.2297, 'Zuma_Rock', 14.6, 66, 20],
  ['lekki-bridge', 'Lekki–Ikoyi Link Bridge', 'Lagos', 'NG', 6.4467, 3.4469, 'Lekki-Ikoyi_Link_Bridge', 16, 60, 120],
  ['cape-coast', 'Cape Coast Castle', 'Cape Coast', 'GH', 5.1036, -1.2413, 'Cape_Coast_Castle', 17.4, 55, 0],
  ['hassan-ii', 'Hassan II Mosque', 'Casablanca', 'MA', 33.6084, -7.6325, 'Hassan_II_Mosque', 17, 58, 320],
  ['djenne', 'Great Mosque of Djenné', 'Djenné', 'ML', 13.9053, -4.5553, 'Great_Mosque_of_Djenné', 17.4, 55, 20],
  ['serengeti', 'Serengeti National Park', 'Mara Region', 'TZ', -2.3333, 34.8333, 'Serengeti_National_Park', 10.5, 55, 0],
  ['lalibela', 'Rock-Hewn Churches of Lalibela', 'Lalibela', 'ET', 12.0317, 39.0411, 'Church_of_Saint_George,_Lalibela', 18, 45, 0],

  // ── Europe ──
  ['eiffel', 'Eiffel Tower', 'Paris', 'FR', 48.8584, 2.2945, 'Eiffel_Tower', 16.8, 62, 315],
  ['louvre', 'Louvre Museum', 'Paris', 'FR', 48.8606, 2.3376, 'Louvre', 17, 55, 90],
  ['mont-st-michel', 'Mont-Saint-Michel', 'Normandy', 'FR', 48.6361, -1.5115, 'Mont-Saint-Michel', 15.6, 60, 180],
  ['big-ben', 'Big Ben & Palace of Westminster', 'London', 'GB', 51.5007, -0.1246, 'Big_Ben', 17, 60, 60],
  ['tower-bridge', 'Tower Bridge', 'London', 'GB', 51.5055, -0.0754, 'Tower_Bridge', 17, 58, 270],
  ['stonehenge', 'Stonehenge', 'Wiltshire', 'GB', 51.1789, -1.8262, 'Stonehenge', 18, 55, 45],
  ['colosseum', 'Colosseum', 'Rome', 'IT', 41.8902, 12.4922, 'Colosseum', 17.2, 60, 70],
  ['vatican', "St. Peter's Basilica", 'Vatican City', 'VA', 41.9022, 12.4539, "St._Peter's_Basilica", 16.8, 60, 270],
  ['pisa', 'Leaning Tower of Pisa', 'Pisa', 'IT', 43.723, 10.3966, 'Leaning_Tower_of_Pisa', 17.6, 58, 0],
  ['venice', "St Mark's Square", 'Venice', 'IT', 45.4341, 12.3388, 'Piazza_San_Marco', 16.6, 60, 180],
  ['sagrada', 'Sagrada Família', 'Barcelona', 'ES', 41.4036, 2.1744, 'Sagrada_Família', 17.6, 60, 45],
  ['alhambra', 'Alhambra', 'Granada', 'ES', 37.1761, -3.5881, 'Alhambra', 16.6, 60, 70],
  ['acropolis', 'Acropolis of Athens', 'Athens', 'GR', 37.9715, 23.7257, 'Acropolis_of_Athens', 16.8, 60, 20],
  ['santorini', 'Oia, Santorini', 'Santorini', 'GR', 36.4618, 25.3753, 'Oia,_Greece', 15.6, 65, 230],
  ['brandenburg', 'Brandenburg Gate', 'Berlin', 'DE', 52.5163, 13.3777, 'Brandenburg_Gate', 17.4, 58, 90],
  ['neuschwanstein', 'Neuschwanstein Castle', 'Bavaria', 'DE', 47.5576, 10.7498, 'Neuschwanstein_Castle', 16.6, 66, 300],
  ['matterhorn', 'Matterhorn', 'Zermatt', 'CH', 45.9763, 7.6586, 'Matterhorn', 13, 72, 220],
  ['red-square', "Red Square & St. Basil's Cathedral", 'Moscow', 'RU', 55.7525, 37.6231, "Saint_Basil's_Cathedral", 16.4, 58, 200],
  ['hagia-sophia', 'Hagia Sophia', 'Istanbul', 'TR', 41.0086, 28.9802, 'Hagia_Sophia', 17, 58, 120],
  ['cappadocia', 'Göreme, Cappadocia', 'Nevşehir', 'TR', 38.6431, 34.8289, 'Göreme', 14.8, 62, 30],
  ['amsterdam', 'Amsterdam Canal Ring', 'Amsterdam', 'NL', 52.3676, 4.8838, 'Canals_of_Amsterdam', 15.6, 55, 0],
  ['charles-bridge', 'Charles Bridge', 'Prague', 'CZ', 50.0865, 14.4114, 'Charles_Bridge', 17, 58, 280],
  ['geiranger', 'Geirangerfjord', 'Møre og Romsdal', 'NO', 62.1049, 7.0941, 'Geirangerfjord', 12.6, 70, 270],
  ['blue-lagoon', 'Blue Lagoon', 'Grindavík', 'IS', 63.8804, -22.4495, 'Blue_Lagoon_(geothermal_spa)', 15.6, 55, 0],

  // ── Asia & Middle East ──
  ['burj-khalifa', 'Burj Khalifa', 'Dubai', 'AE', 25.1972, 55.2744, 'Burj_Khalifa', 16.4, 68, 330],
  ['palm-jumeirah', 'Palm Jumeirah', 'Dubai', 'AE', 25.1124, 55.139, 'Palm_Jumeirah', 12.8, 45, 330],
  ['kaaba', 'Masjid al-Haram', 'Mecca', 'SA', 21.4225, 39.8262, 'Great_Mosque_of_Mecca', 16.6, 55, 0],
  ['petra', 'Petra (Al-Khazneh)', 'Wadi Musa', 'JO', 30.3222, 35.4519, 'Petra', 16.4, 66, 300],
  ['taj-mahal', 'Taj Mahal', 'Agra', 'IN', 27.1751, 78.0421, 'Taj_Mahal', 16.8, 60, 0],
  ['great-wall', 'Great Wall at Mutianyu', 'Beijing', 'CN', 40.4319, 116.5704, 'Mutianyu', 15.4, 68, 330],
  ['forbidden-city', 'Forbidden City', 'Beijing', 'CN', 39.9163, 116.3972, 'Forbidden_City', 15.4, 55, 0],
  ['the-bund', 'The Bund', 'Shanghai', 'CN', 31.24, 121.4903, 'The_Bund', 15.6, 62, 80],
  ['victoria-peak', 'Victoria Harbour from the Peak', 'Hong Kong', 'HK', 22.2759, 114.1455, 'Victoria_Peak', 14.6, 70, 20],
  ['mount-fuji', 'Mount Fuji', 'Shizuoka / Yamanashi', 'JP', 35.3606, 138.7274, 'Mount_Fuji', 12.4, 70, 30],
  ['fushimi-inari', 'Fushimi Inari-taisha', 'Kyoto', 'JP', 34.9671, 135.7727, 'Fushimi_Inari-taisha', 16.6, 60, 90],
  ['shibuya', 'Shibuya Crossing', 'Tokyo', 'JP', 35.6595, 139.7005, 'Shibuya_Crossing', 17.6, 60, 200],
  ['angkor-wat', 'Angkor Wat', 'Siem Reap', 'KH', 13.4125, 103.867, 'Angkor_Wat', 15.6, 58, 270],
  ['marina-bay', 'Marina Bay Sands', 'Singapore', 'SG', 1.2834, 103.8607, 'Marina_Bay_Sands', 16.4, 62, 290],
  ['petronas', 'Petronas Towers', 'Kuala Lumpur', 'MY', 3.1579, 101.7116, 'Petronas_Towers', 16.6, 66, 0],
  ['halong', 'Hạ Long Bay', 'Quảng Ninh', 'VN', 20.9101, 107.1839, 'Hạ_Long_Bay', 12.4, 60, 120],
  ['everest', 'Mount Everest', 'Khumbu', 'NP', 27.9881, 86.925, 'Mount_Everest', 12.6, 72, 200],
  ['bagan', 'Bagan Temples', 'Mandalay Region', 'MM', 21.1717, 94.8585, 'Bagan', 14.6, 60, 0],
  ['borobudur', 'Borobudur', 'Central Java', 'ID', -7.6079, 110.2038, 'Borobudur', 17, 58, 0],

  // ── Oceania ──
  ['opera-house', 'Sydney Opera House', 'Sydney', 'AU', -33.8568, 151.2153, 'Sydney_Opera_House', 16.8, 62, 160],
  ['uluru', 'Uluru', 'Northern Territory', 'AU', -25.3444, 131.0369, 'Uluru', 13.6, 62, 20],
  ['great-barrier-reef', 'Great Barrier Reef (Heart Reef)', 'Whitsundays', 'AU', -19.7533, 149.1656, 'Great_Barrier_Reef', 12.6, 45, 0],
  ['milford-sound', 'Milford Sound', 'Fiordland', 'NZ', -44.6414, 167.8974, 'Milford_Sound', 12.8, 70, 300],
  ['bora-bora', 'Bora Bora', 'Society Islands', 'PF', -16.5004, -151.7415, 'Bora_Bora', 12, 55, 0],

  // ── North America ──
  ['statue-liberty', 'Statue of Liberty', 'New York', 'US', 40.6892, -74.0445, 'Statue_of_Liberty', 17, 62, 330],
  ['times-square', 'Times Square', 'New York', 'US', 40.758, -73.9855, 'Times_Square', 16.6, 66, 210],
  ['golden-gate', 'Golden Gate Bridge', 'San Francisco', 'US', 37.8199, -122.4783, 'Golden_Gate_Bridge', 14.8, 64, 160],
  ['grand-canyon', 'Grand Canyon (Mather Point)', 'Arizona', 'US', 36.0618, -112.1076, 'Grand_Canyon', 12.6, 70, 20],
  ['las-vegas-strip', 'Las Vegas Strip', 'Las Vegas', 'US', 36.1147, -115.1728, 'Las_Vegas_Strip', 15, 62, 0],
  ['white-house', 'The White House', 'Washington, D.C.', 'US', 38.8977, -77.0365, 'White_House', 17, 58, 180],
  ['niagara', 'Niagara Falls (Horseshoe Falls)', 'Ontario / New York', 'CA', 43.0779, -79.0758, 'Niagara_Falls', 15.4, 62, 20],
  ['banff', 'Moraine Lake, Banff', 'Alberta', 'CA', 51.3217, -116.186, 'Moraine_Lake', 13.6, 70, 200],
  ['chichen-itza', 'Chichén Itzá (El Castillo)', 'Yucatán', 'MX', 20.6843, -88.5678, 'Chichen_Itza', 17.2, 58, 0],
  ['panama-canal', 'Panama Canal (Miraflores Locks)', 'Panama City', 'PA', 9.0153, -79.5926, 'Panama_Canal', 15.6, 60, 320],
  ['yellowstone', 'Grand Prismatic Spring', 'Wyoming', 'US', 44.5251, -110.8382, 'Grand_Prismatic_Spring', 15.8, 55, 0],

  // ── South America & Antarctica ──
  ['machu-picchu', 'Machu Picchu', 'Cusco Region', 'PE', -13.1631, -72.545, 'Machu_Picchu', 15.6, 68, 330],
  ['christ-redeemer', 'Christ the Redeemer', 'Rio de Janeiro', 'BR', -22.9519, -43.2105, 'Christ_the_Redeemer_(statue)', 15.4, 66, 120],
  ['iguazu', 'Iguazú Falls (Devil’s Throat)', 'Misiones', 'AR', -25.6953, -54.4367, 'Iguazu_Falls', 14.6, 62, 0],
  ['salar-uyuni', 'Salar de Uyuni', 'Potosí', 'BO', -20.1338, -67.4891, 'Salar_de_Uyuni', 9.6, 50, 0],
  ['perito-moreno', 'Perito Moreno Glacier', 'Santa Cruz', 'AR', -50.4967, -73.1377, 'Perito_Moreno_Glacier', 12.6, 68, 240],
  ['galapagos', 'Galápagos (Bartolomé Island)', 'Galápagos', 'EC', -0.2833, -90.55, 'Bartolomé_Island', 14.2, 60, 0],
  ['easter-island', 'Moai at Ahu Tongariki', 'Easter Island', 'CL', -27.1258, -109.2769, 'Ahu_Tongariki', 16.6, 62, 0],
  ['port-lockroy', 'Port Lockroy', 'Antarctic Peninsula', 'AQ', -64.8253, -63.4942, 'Port_Lockroy', 13.6, 62, 0],
];

export const LANDMARKS = RAW.map(([id, name, city, iso, lat, lon, wiki, zoom, pitch, bearing]) => ({
  id,
  name,
  city,
  iso,
  coord: [lon, lat],
  wiki,
  camera: { zoom, pitch, bearing },
}));

export const LANDMARK_BY_ID = new Map(LANDMARKS.map((l) => [l.id, l]));
