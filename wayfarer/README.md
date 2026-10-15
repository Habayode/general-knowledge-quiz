# Wayfarer: real-world travel simulator

Travel the real planet on real satellite imagery. Drive actual roads, ride a motorbike, cycle, walk, fly great-circle
routes and sail real shipping lanes, and combine them in one journey. Along the way you go through the same procedures
a real traveller does: check-in, bag drop, security trays, passport control, boarding groups, immigration stamps,
baggage reclaim, customs, car-ferry lanes, cruise muster drills, rental desks, fuel stops and border posts.

Served at **`/wayfarer/`** by the existing Python server (no build step: plain ES modules).

## What is real

| Layer | Source | Notes |
| --- | --- | --- |
| Satellite imagery | Esri World Imagery (Maxar, Earthstar Geographics) | Plus Esri place/road reference overlays |
| 3D terrain | Mapzen/AWS Terrarium elevation tiles | Toggle in Settings |
| 3D buildings | OpenFreeMap (OpenStreetMap) | Extruded from OSM heights |
| Night side of the globe | Computed terminator + civil/nautical/astronomical twilight; NASA Black Marble night lights | Sun position from the sim clock |
| Road routes | OSRM on OpenStreetMap (car, bike, foot profiles) | Per-segment speeds drive the vehicle; real turn-by-turn |
| Flights | Great-circle routes between 175 real airports (IATA/ICAO, time zones) | RVSM semicircular cruise levels, 250 kt below FL100, climb/descent profile, live 250 hPa winds aloft from Open-Meteo |
| Sea voyages | Eurostat SeaRoute shipping-lane network (Suez, Panama, Kiel, major straits) | Lanes repaired against 1:10m coastlines; per-port pilotage approaches computed offline |
| Borders & countries | Natural Earth 1:50m, offline | Border crossings, stamps, driving side, Schengen/CTA/EU-customs rules |
| Weather & local time | Open-Meteo | Live conditions and the local time zone wherever you are |
| Landmarks & discoveries | Wikipedia REST & GeoSearch | 79 curated landmarks with tuned satellite camera angles, plus "nearby" places en route |

Approximations are labelled as such in-game (fares, fuel prices, queue times). **Not for real navigation.**

## How a journey works

1. **Plan**: add stops; per hop pick ✨ smart, 🚗 drive (sedan/SUV/EV), 🏍️, 🚲, 🚶, ✈️ or 🚢. Flying between cities
   inserts airport transfers automatically. A ferry between two drive legs carries your car; landing by air or a cruise
   gives you a rental car for the next drive leg.
2. **Go**: each leg runs its real-world procedure in a side sheet, then the vehicle moves along the real route in sim time.
   Time compression runs from real time to ×7,200, and any wait (queues, boarding, baggage) can be skipped, which advances
   the clock exactly as if you had waited.
3. **Keep**: passport stamps, countries and continents, achievements, XP levels, statistics, CO₂ and a wallet ledger are
   kept in your browser.

Keyboard: `Space` pause · `1`–`6` time compression · `C` cycle camera (chase, cockpit, top, orbit, free).

## Code map

```
js/main.js        boot, journey orchestration, game loop, events, achievements
js/sim.js         sim clock + Road/Flight/Sea runners (async state machines in sim time)
js/protocols.js   real-world procedures: booking, check-in, seat map, BCBP boarding pass,
                  bag drop, security, passport control, boarding, immigration, customs, ferries, cruises
js/planner.js     itinerary expansion (transfers, rentals, car ferries) and route resolution
js/flight.js      flight plan & vertical/speed profile          js/sea.js   shipping-lane Dijkstra
js/map.js         MapLibre globe, imagery, terrain, terminator, follow camera, vehicle markers
js/hud.js         car cluster, cycling computer, flight display, ship bridge
js/services.js    OSRM, Photon/Nominatim, Open-Meteo, Wikipedia (timeouts, cache, rate limits)
js/data/          airports, ports, landmarks, vehicles, country rules + generated JSON datasets
tools/            offline builders for the generated datasets
```

## Development

```bash
cd wayfarer
npm install            # dev tooling only; the app itself has no runtime dependencies
npm run serve          # http://localhost:8090
npm test               # unit tests: geodesy, flight model, sea routing vs coastlines, data validation, clock
npm run test:e2e       # full journeys in headless Chromium, all services mocked; screenshots in tests/e2e/screenshots/
npm run lint           # ESLint + Prettier
npm run build:data     # rebuild countries.json, sealanes.json and port-approaches.json (downloads Natural Earth)
```

## Credits & licences

Imagery © Esri and its partners · © OpenStreetMap contributors (ODbL) via OSRM and OpenFreeMap · Natural Earth (public
domain) · Eurostat SeaRoute marnet (EUPL-1.2) via searoute-js (MIT) · Mapzen Terrarium · NASA GIBS · Open-Meteo (CC BY 4.0) ·
Wikipedia text (CC BY-SA 4.0) · MapLibre GL JS (BSD-3-Clause).
