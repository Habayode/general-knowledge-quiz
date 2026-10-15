// Panels and dialogs: trip planner, landmark explorer, passport book,
// settings, onboarding, toasts and the place-search autocomplete.
import { html, raw, el, $, $$, esc } from './dom.js';
import { state, save, reset, level, LEVELS, ACHIEVEMENTS } from './store.js';
import { AIRPORTS } from './data/airports.js';
import { PORTS } from './data/ports.js';
import { LANDMARKS } from './data/landmarks.js';
import { VEHICLES } from './data/vehicles.js';
import { MODES, airportPlace, portPlace, expandLeg, resolveLeg, defaultVehicle, PlanError } from './planner.js';
import { searchPlaces, wikiSummary } from './services.js';
import { flag } from './countries.js';
import { fmtDur, money, stampSvg, fmtDate } from './protocols.js';
import { distance } from './geo.js';
import { estimateFare } from './flight.js';
import { unlockAudio } from './audio.js';

// ── Toasts ────────────────────────────────────────────────────────────────
let toastRoot;
export function toast(msg, { ms = 4200, tone = '' } = {}) {
  toastRoot ||= $('#toasts');
  const t = el(html`<div class="toast ${tone}" role="status">${msg}</div>`);
  toastRoot.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 300);
  }, ms);
  while (toastRoot.children.length > 4) toastRoot.firstElementChild.remove();
}

// ── Modal ─────────────────────────────────────────────────────────────────
export function modal(fragment, { wide = false, onClose, dismissable = true } = {}) {
  const root = $('#modal');
  root.innerHTML = '';
  const box = el(
    html`<div class="modal-backdrop">
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        ${dismissable ? html`<button class="modal-x icon-btn" aria-label="Close">✕</button>` : ''}
        <div class="modal-body">${fragment}</div>
      </div>
    </div>`,
  );
  root.appendChild(box);
  root.hidden = false;
  const close = () => {
    root.hidden = true;
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && dismissable && close();
  document.addEventListener('keydown', onKey);
  if (dismissable) {
    $('.modal-x', box).onclick = close;
    box.addEventListener('click', (e) => e.target === box && close());
  }
  return { box: $('.modal-body', box), close };
}

// ── Place search (offline catalogue first, then live OSM search) ─────────
function localMatches(q) {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  const out = [];
  for (const a of AIRPORTS) {
    if (a.iata.toLowerCase() === s || a.city.toLowerCase().startsWith(s) || a.name.toLowerCase().includes(s))
      out.push({ ...airportPlace(a), icon: '✈️' });
  }
  for (const p of PORTS) {
    if (p.city.toLowerCase().startsWith(s) || p.name.toLowerCase().includes(s)) out.push({ ...portPlace(p), icon: '⚓' });
  }
  for (const l of LANDMARKS) {
    if (l.name.toLowerCase().includes(s) || l.city.toLowerCase().startsWith(s)) {
      out.push({ kind: 'landmark', id: l.id, name: l.name, label: `${l.name}, ${l.city}`, coord: l.coord, iso: l.iso, icon: '★' });
    }
  }
  return out.slice(0, 6);
}

export function placeInput(input, { onPick, near }) {
  const wrap = input.closest('.ac-wrap');
  const list = el(html`<ul class="ac-list" role="listbox" hidden></ul>`);
  wrap.appendChild(list);
  let timer;
  let items = [];
  let active = -1;
  const renderList = () => {
    list.innerHTML = '';
    items.forEach((p, i) => {
      const li = el(
        html`<li role="option" class="${i === active ? 'active' : ''}">
          <span class="ac-ico">${p.icon || '📍'}</span><span><b>${p.name}</b><small>${p.label || ''}</small></span
          ><span class="ac-flag">${p.iso ? flag(p.iso) : ''}</span>
        </li>`,
      );
      li.onmousedown = (e) => {
        e.preventDefault();
        pick(p);
      };
      list.appendChild(li);
    });
    list.hidden = !items.length;
  };
  const pick = (p) => {
    input.value = p.name;
    list.hidden = true;
    items = [];
    onPick({ ...p, icon: undefined });
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value;
    items = localMatches(q);
    active = -1;
    renderList();
    if (q.trim().length < 3) return;
    timer = setTimeout(async () => {
      try {
        const remote = await searchPlaces(q, near?.());
        if (input.value !== q) return;
        const seen = new Set(items.map((x) => x.label));
        items = [...items, ...remote.filter((r) => !seen.has(r.label)).map((r) => ({ ...r, icon: '📍' }))].slice(0, 9);
        renderList();
      } catch {
        if (!items.length) {
          list.innerHTML = '<li class="ac-empty">Place search is offline. Try an airport code, port or landmark.</li>';
          list.hidden = false;
        }
      }
    }, 280);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') active = Math.min(items.length - 1, active + 1);
    else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
    else if (e.key === 'Enter' && items[Math.max(0, active)]) {
      e.preventDefault();
      pick(items[Math.max(0, active)]);
      return;
    } else if (e.key === 'Escape') list.hidden = true;
    else return;
    e.preventDefault();
    renderList();
  });
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 150));
}

// ── Planner ───────────────────────────────────────────────────────────────
export class Planner {
  constructor(root, { map, onStart }) {
    this.root = root;
    this.map = map;
    this.onStart = onStart;
    this.stops = [state.profile?.home || null, null];
    this.gaps = [{ mode: 'auto', vehicle: 'sedan' }];
    this.legs = null;
    this.render();
  }

  setDestination(place) {
    const idx = this.stops.findIndex((s, i) => i > 0 && !s);
    if (idx >= 0) this.stops[idx] = place;
    else {
      this.stops.push(place);
      this.gaps.push({ mode: 'auto', vehicle: 'sedan' });
    }
    this.legs = null;
    this.render();
  }

  render() {
    const letters = 'ABCDEFGHIJ';
    this.root.innerHTML = String(
      html` <div class="planner">
        <ol class="stops">
          ${this.stops.map(
            (s, i) =>
              html` <li class="stop" data-i="${i}">
                  <span class="stop-mark">${letters[i]}</span>
                  <div class="ac-wrap">
                    <input
                      class="stop-input"
                      placeholder="${i === 0 ? 'Starting point' : 'Where to?'}"
                      value="${s?.name || ''}"
                      aria-label="Stop ${letters[i]}"
                      autocomplete="off"
                    />
                  </div>
                  ${this.stops.length > 2 && i > 0
                    ? html`<button class="icon-btn rm" title="Remove stop" aria-label="Remove stop">✕</button>`
                    : ''}
                </li>
                ${i < this.gaps.length
                  ? html`<li class="gap" data-g="${i}">
                      <div class="modes" role="radiogroup" aria-label="Transport between ${letters[i]} and ${letters[i + 1]}">
                        <button class="mode ${this.gaps[i].mode === 'auto' ? 'on' : ''}" data-m="auto" title="Smart: let Wayfarer choose">
                          ✨
                        </button>
                        ${Object.entries(MODES).map(
                          ([k, m]) =>
                            html`<button
                              class="mode ${this.gaps[i].mode === k ? 'on' : ''}"
                              data-m="${k}"
                              title="${m.label}"
                              aria-label="${m.label}"
                            >
                              ${m.icon}
                            </button>`,
                        )}
                      </div>
                      ${this.gaps[i].mode === 'drive'
                        ? html`<select class="veh" aria-label="Vehicle">
                            ${MODES.drive.vehicles.map(
                              (v) =>
                                html`<option value="${v}" ${this.gaps[i].vehicle === v ? raw('selected') : ''}>
                                  ${VEHICLES[v].name}
                                </option>`,
                            )}
                          </select>`
                        : ''}
                    </li>`
                  : ''}`,
          )}
        </ol>
        <div class="row gap-s">
          <button class="btn ghost add-stop" ${this.stops.length >= 8 ? raw('disabled') : ''}>＋ Add stop</button>
          <button class="btn btn-primary preview" ${this.stops.every(Boolean) ? '' : raw('disabled')}>Plan route</button>
        </div>
        <div class="plan-out"></div>
      </div>`,
    );

    $$('.stop', this.root).forEach((li) => {
      const i = Number(li.dataset.i);
      placeInput($('.stop-input', li), {
        near: () => this.stops[i - 1]?.coord || this.stops[0]?.coord,
        onPick: (p) => {
          this.stops[i] = p;
          this.legs = null;
          this.render();
          this.map.flyTo(p.coord, { zoom: p.kind === 'airport' ? 12 : 11, pitch: 45, duration: 2500 });
        },
      });
      $('.rm', li)?.addEventListener('click', () => {
        this.stops.splice(i, 1);
        this.gaps.splice(Math.max(0, i - 1), 1);
        this.legs = null;
        this.render();
      });
    });
    $$('.gap', this.root).forEach((g) => {
      const i = Number(g.dataset.g);
      $$('.mode', g).forEach((b) =>
        b.addEventListener('click', () => {
          this.gaps[i].mode = b.dataset.m;
          if (MODES[b.dataset.m] && b.dataset.m !== 'drive') this.gaps[i].vehicle = defaultVehicle(b.dataset.m) || 'auto';
          if (b.dataset.m === 'drive') this.gaps[i].vehicle = 'sedan';
          this.legs = null;
          this.render();
        }),
      );
      $('.veh', g)?.addEventListener('change', (e) => {
        this.gaps[i].vehicle = e.target.value;
        this.legs = null;
      });
    });
    $('.add-stop', this.root).onclick = () => {
      this.stops.push(null);
      this.gaps.push({ mode: 'auto', vehicle: 'sedan' });
      this.render();
      $$('.stop-input', this.root).at(-1)?.focus();
    };
    $('.preview', this.root).onclick = () => this.plan();
    if (this.legs) this.renderSummary();
  }

  /** Build concrete legs for every gap and resolve their routes. */
  async plan() {
    const out = $('.plan-out', this.root);
    const btn = $('.preview', this.root);
    btn.disabled = true;
    out.innerHTML = '<div class="planning"><span class="spinner"></span> Planning with live road, air and sea data…</div>';
    try {
      const legs = [];
      for (let i = 0; i < this.gaps.length; i++) {
        const a = this.stops[i];
        const b = this.stops[i + 1];
        const g = this.gaps[i];
        let mode = g.mode;
        if (mode === 'auto') {
          const km = distance(a.coord, b.coord) / 1000;
          mode = km < 650 ? 'drive' : 'fly';
          if (a.kind === 'port' && b.kind === 'port') mode = 'sail';
          if (a.kind === 'airport' && b.kind === 'airport' && km > 150) mode = 'fly';
        }
        let expanded;
        try {
          expanded = expandLeg(a, b, mode, { vehicle: mode === 'drive' ? g.vehicle : undefined, transferVehicle: 'sedan' });
        } catch (err) {
          if (g.mode === 'auto' && mode === 'fly') expanded = expandLeg(a, b, 'drive');
          else throw err;
        }
        legs.push(...expanded);
      }
      annotateLegs(legs);
      for (let k = 0; k < legs.length; k++) {
        out.innerHTML = `<div class="planning"><span class="spinner"></span> Routing leg ${k + 1} of ${legs.length}: ${esc(MODES[legs[k].mode]?.label || legs[k].mode)} ${esc(legs[k].from.name)} → ${esc(legs[k].to.name)}…</div>`;
        try {
          await resolveLeg(legs[k]);
        } catch (err) {
          // Smart mode: no road (islands, oceans)? fall back to flying.
          const gIdx = this.gapIndexOf(legs[k]);
          if (
            err instanceof PlanError &&
            /no road/i.test(err.message) &&
            gIdx >= 0 &&
            this.gaps[gIdx].mode === 'auto' &&
            !legs[k].transfer
          ) {
            const replacement = expandLeg(legs[k].from, legs[k].to, 'fly');
            legs.splice(k, 1, ...replacement);
            annotateLegs(legs);
            k--;
            continue;
          }
          throw err;
        }
      }
      this.legs = legs;
      this.map.showRoute(legs);
      this.map.showStops(this.stops);
      this.map.fitCoords(legs.flatMap((l) => l.path.coords));
      this.renderSummary();
    } catch (err) {
      out.innerHTML = String(html`<div class="notice warn">${err.message || String(err)}</div>`);
    } finally {
      btn.disabled = false;
    }
  }

  gapIndexOf(leg) {
    return this.stops.findIndex((s, i) => s === leg.from && i < this.gaps.length);
  }

  renderSummary() {
    const out = $('.plan-out', this.root);
    const legs = this.legs;
    const totalKm = legs.reduce((s, l) => s + l.distanceM, 0) / 1000;
    const totalS = legs.reduce((s, l) => s + l.durationS, 0);
    const estCost = legs.reduce((s, l) => {
      if (l.mode === 'fly') return s + estimateFare(l.distanceM / 1000);
      if (l.mode === 'sail')
        return s + (VEHICLES[l.vehicle].carDeck ? 35 + (l.distanceM / 1000) * 0.22 : 140 * Math.max(1, Math.ceil(l.durationS / 86400)));
      const v = VEHICLES[l.vehicle];
      return s + (v.lPer100 ? (l.distanceM / 100000) * v.lPer100 * 1.3 : 0);
    }, 0);
    out.innerHTML = String(
      html` <div class="summary">
        <div class="sum-head">
          <b>${Math.round(totalKm).toLocaleString('en-US')} km</b><span>${fmtDur(totalS)} moving</span><span>≈ ${money(estCost)}</span>
        </div>
        <ol class="leg-list">
          ${legs.map(
            (l) =>
              html`<li class="leg ${l.transfer ? 'transfer' : ''}">
                <span class="leg-ico">${MODES[l.mode]?.icon || '•'}</span>
                <span class="leg-txt"
                  ><b>${l.from.name} → ${l.to.name}</b
                  ><small
                    >${VEHICLES[l.vehicle]?.name || ''} · ${(l.distanceM / 1000).toFixed(l.distanceM < 10000 ? 1 : 0)} km ·
                    ${fmtDur(l.durationS)}${l.mode === 'fly' ? ` · FL${l.plan.cruiseFL}` : ''}${l.withVehicle
                      ? ' · with your car'
                      : ''}${l.rental ? ' · rental car' : ''}</small
                  ></span
                >
              </li>`,
          )}
        </ol>
        <button class="btn btn-primary btn-go">Start journey ▶</button>
      </div>`,
    );
    $('.btn-go', out).onclick = () => {
      unlockAudio();
      this.onStart(this.legs, this.stops);
    };
  }
}

/** Real-world continuity between legs: car ferries, rentals, airport drop-offs. */
export function annotateLegs(legs) {
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    l.rental = false;
    l.withVehicle = false;
    if (l.mode === 'sail' && VEHICLES[l.vehicle]?.carDeck !== false) {
      const prev = legs[i - 1];
      const next = legs[i + 1];
      l.withVehicle = !!(prev && next && ['drive', 'motorbike'].includes(prev.mode) && ['drive', 'motorbike'].includes(next.mode));
    }
  }
  for (let i = 1; i < legs.length; i++) {
    const l = legs[i];
    const prev = legs[i - 1];
    if (['drive', 'motorbike'].includes(l.mode) && (prev.mode === 'fly' || (prev.mode === 'sail' && !prev.withVehicle))) l.rental = true;
  }
}

// ── Explore landmarks ────────────────────────────────────────────────────
const CONTINENT_OF = (iso, countries) => countries?.get(iso)?.continent || '';

export function renderExplore(root, { map, countries, onTravel }) {
  const conts = ['All', 'Africa', 'Europe', 'Asia', 'North America', 'South America', 'Oceania', 'Antarctica'];
  let filter = 'All';
  const draw = () => {
    const list = LANDMARKS.filter((l) => filter === 'All' || CONTINENT_OF(l.iso, countries) === filter);
    root.innerHTML = String(
      html` <div class="explore">
        <div class="chips">${conts.map((c) => html`<button class="chip ${c === filter ? 'on' : ''}" data-c="${c}">${c}</button>`)}</div>
        <ul class="lm-list">
          ${list.map(
            (l) =>
              html`<li>
                <button class="lm" data-id="${l.id}">
                  <span class="lm-flag">${flag(l.iso)}</span><span><b>${l.name}</b><small>${l.city}</small></span
                  >${state.landmarks[l.id] ? html`<span class="lm-seen" title="Visited">✓</span>` : ''}
                </button>
              </li>`,
          )}
        </ul>
      </div>`,
    );
    $$('.chip', root).forEach((b) => (b.onclick = () => ((filter = b.dataset.c), draw())));
    $$('.lm', root).forEach(
      (b) =>
        (b.onclick = () =>
          openLandmark(
            LANDMARKS.find((x) => x.id === b.dataset.id),
            { map, onTravel },
          )),
    );
  };
  draw();
}

export async function openLandmark(l, { map, onTravel }) {
  map.flyTo(l.coord, { ...l.camera, duration: 5000 });
  const card = $('#wiki');
  card.hidden = false;
  card.innerHTML = String(
    html`<div class="wiki-card">
      <button class="icon-btn wiki-x" aria-label="Close">✕</button>
      <div class="wiki-body">
        <h3>${l.name}</h3>
        <p class="muted">${l.city} ${flag(l.iso)}</p>
        <div class="planning"><span class="spinner"></span> Loading from Wikipedia…</div>
      </div>
    </div>`,
  );
  $('.wiki-x', card).onclick = () => (card.hidden = true);
  let s = null;
  try {
    s = await wikiSummary(l.wiki);
  } catch {
    // offline: keep the card minimal
  }
  if (card.hidden) return;
  $('.wiki-body', card).innerHTML = String(
    html` ${s?.thumb ? html`<img class="wiki-img" src="${s.thumb}" alt="${l.name}" loading="lazy" />` : ''}
      <h3>${l.name}</h3>
      <p class="muted">${s?.description || l.city} · ${flag(l.iso)}</p>
      <p class="wiki-extract">${s?.extract || 'Live facts are unavailable offline.'}</p>
      <div class="row gap-s">
        <button class="btn orbit">🛰️ Orbit</button>
        <button class="btn btn-primary travel">Travel here</button>
        ${s?.url ? html`<a class="btn ghost" href="${s.url}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ''}
      </div>
      <p class="attrib">Text: Wikipedia, CC BY-SA 4.0</p>`,
  );
  $('.orbit', card).onclick = () => {
    const m = map.map;
    const spin = () => {
      if (card.hidden || !map.orbiting) return;
      m.setBearing((m.getBearing() + 0.15) % 360);
      requestAnimationFrame(spin);
    };
    map.orbiting = !map.orbiting;
    $('.orbit', card).classList.toggle('on', map.orbiting);
    if (map.orbiting) spin();
  };
  $('.travel', card).onclick = () => {
    card.hidden = true;
    map.orbiting = false;
    onTravel({ kind: 'landmark', id: l.id, name: l.name, label: `${l.name}, ${l.city}`, coord: l.coord, iso: l.iso });
  };
}

// ── Passport book ─────────────────────────────────────────────────────────
export function renderPassport(root, { countries }) {
  const lv = level();
  const visited = Object.entries(state.visited);
  const conts = ['Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'Oceania', 'South America'];
  const s = state.stats;
  const p = state.profile;
  root.innerHTML = String(
    html` <div class="passport">
      <div class="pp-cover">
        <div class="pp-emblem">🌐</div>
        <div>
          <div class="pp-kicker">
            PASSPORT · ${p?.nationality ? `${flag(p.nationality)} ${countries?.get(p.nationality)?.name || p.nationality}` : ''}
          </div>
          <div class="pp-name">${p?.name || 'Traveller'}</div>
          <div class="pp-no">No. ${p?.passportNo || '—'}</div>
        </div>
      </div>
      <div class="level">
        <div class="lv-row"><b>${lv.name}</b><span>${state.xp.toLocaleString('en-US')} XP</span></div>
        <div class="progress">
          <div class="bar" style="width:${lv.next ? (((state.xp - lv.base) / (lv.next - lv.base)) * 100).toFixed(1) : 100}%"></div>
        </div>
        <small class="muted"
          >${lv.next ? `${(lv.next - state.xp).toLocaleString('en-US')} XP to ${LEVELS[lv.idx + 1][1]}` : 'Maximum rank reached'}</small
        >
      </div>
      <div class="wallet"><span>Wallet</span><b>${money(state.wallet)}</b></div>
      <h4>Continents ${Object.keys(state.continents).length}/7</h4>
      <div class="conts">${conts.map((c) => html`<span class="cont ${state.continents[c] ? 'on' : ''}">${c}</span>`)}</div>
      <h4>Countries visited (${visited.length})</h4>
      <div class="countries">
        ${visited.length
          ? visited.map(([iso, v]) => html`<span class="ctry" title="First visit ${fmtDate(v.first)}">${flag(iso)} ${v.name}</span>`)
          : html`<span class="muted">No countries yet. Your first trip awaits.</span>`}
      </div>
      <h4>Stamps (${state.stamps.length})</h4>
      <div class="stamps">
        ${state.stamps.length
          ? state.stamps
              .slice()
              .reverse()
              .map((st) => raw(stampSvg(st)))
          : html`<span class="muted">Clear immigration to collect stamps.</span>`}
      </div>
      <h4>Statistics</h4>
      <dl class="kv stats">
        <div>
          <dt>🚗 Driven</dt>
          <dd>${Math.round(s.driveKm).toLocaleString('en-US')} km</dd>
        </div>
        <div>
          <dt>🚲 Cycled</dt>
          <dd>${Math.round(s.bikeKm).toLocaleString('en-US')} km</dd>
        </div>
        <div>
          <dt>🚶 Walked</dt>
          <dd>${s.walkKm.toFixed(1)} km</dd>
        </div>
        <div>
          <dt>✈️ Flown</dt>
          <dd>${Math.round(s.flyKm).toLocaleString('en-US')} km · ${s.flights} flight${s.flights === 1 ? '' : 's'}</dd>
        </div>
        <div>
          <dt>🚢 Sailed</dt>
          <dd>${Math.round(s.sailKm / 1.852).toLocaleString('en-US')} nmi · ${s.voyages} voyage${s.voyages === 1 ? '' : 's'}</dd>
        </div>
        <div>
          <dt>🛂 Borders crossed</dt>
          <dd>${s.borders}</dd>
        </div>
        <div>
          <dt>🌍 Around the world</dt>
          <dd>${((s.driveKm + s.bikeKm + s.walkKm + s.flyKm + s.sailKm) / 40075).toFixed(2)}×</dd>
        </div>
        <div>
          <dt>🏭 CO₂ footprint</dt>
          <dd>${Math.round(s.co2kg).toLocaleString('en-US')} kg</dd>
        </div>
        <div>
          <dt>💳 Spent</dt>
          <dd>${money(s.spent)}</dd>
        </div>
      </dl>
      <h4>Achievements (${Object.keys(state.achievements).length}/${Object.keys(ACHIEVEMENTS).length})</h4>
      <div class="achievements">
        ${Object.entries(ACHIEVEMENTS).map(
          ([id, [icon, name, desc]]) =>
            html`<div class="ach ${state.achievements[id] ? 'on' : ''}" title="${desc}">
              <span>${icon}</span><b>${name}</b><small>${desc}</small>
            </div>`,
        )}
      </div>
      <h4>Recent transactions</h4>
      <ul class="ledger">
        ${state.ledger
          .slice(0, 12)
          .map(
            (t) =>
              html`<li>
                <span>${t.label}</span
                ><b class="${t.amount < 0 ? 'neg' : 'pos'}">${t.amount < 0 ? '−' : '+'}${money(Math.abs(t.amount))}</b>
              </li>`,
          )}
      </ul>
    </div>`,
  );
}

// ── Settings ──────────────────────────────────────────────────────────────
export function renderSettings(root, { map, onReset }) {
  const s = state.settings;
  const row = (key, label, sub) =>
    html`<label class="switch-row"
      ><span><b>${label}</b><small>${sub}</small></span
      ><input type="checkbox" data-k="${key}" ${s[key] ? raw('checked') : ''}
    /></label>`;
  root.innerHTML = String(
    html` <div class="settings">
      ${row('voice', 'Voice announcements', 'Navigation, pilots, cabin crew & captain (Web Speech)')}
      ${row('sound', 'Sound effects', 'Engines, chimes, ship’s whistle, passport stamps')}
      ${row('autoChecks', 'Express mode', 'Auto-complete checklists and choices with sensible defaults')}
      ${row('labels', 'Place labels', 'Countries, cities and borders over the imagery')}
      ${row('roads', 'Road overlay', 'Highways and street names over the imagery')}
      ${row('buildings', '3D buildings', 'Extruded OpenStreetMap buildings in cities')}
      ${row('terrain', '3D terrain', 'Real elevation: mountains, valleys and fjords')}
      <button class="btn danger reset">Reset all progress</button>
      <div class="credits">
        <h4>Real-world data</h4>
        <p>
          Imagery: Esri World Imagery (Maxar, Earthstar Geographics). Roads & buildings: © OpenStreetMap contributors via OSRM and
          OpenFreeMap. Terrain: Mapzen Terrarium. Night lights: NASA Black Marble. Weather & winds aloft: Open-Meteo. Landmarks: Wikipedia.
          Borders: Natural Earth. Shipping lanes: Eurostat SeaRoute. Not for real navigation.
        </p>
      </div>
    </div>`,
  );
  $$('input[data-k]', root).forEach((i) =>
    i.addEventListener('change', () => {
      s[i.dataset.k] = i.checked;
      save();
      applySettings(map);
    }),
  );
  $('.reset', root).onclick = () => {
    if (confirm('Erase your passport, stamps, wallet and statistics?')) {
      reset();
      onReset?.();
    }
  };
}

export function applySettings(map) {
  const s = state.settings;
  map.setLayerVisible('places', s.labels !== false);
  map.setLayerVisible('roads', !!s.roads);
  map.setLayerVisible('buildings', s.buildings !== false);
  map.setTerrain(!!s.terrain);
}

// ── Onboarding ────────────────────────────────────────────────────────────
export function onboarding(countries, done) {
  const opts = countries.items.filter((c) => c.iso && c.iso.length === 2 && c.iso !== 'AQ').sort((a, b) => a.n.localeCompare(b.n));
  const guess = (navigator.language || '').split('-')[1]?.toUpperCase();
  const m = modal(
    html`<div class="onboard">
      <div class="ob-hero">🌍</div>
      <h2>Welcome to Wayfarer</h2>
      <p>
        Travel the real world on real satellite imagery: drive actual roads, cycle, walk, fly great-circle routes and sail real shipping
        lanes, going through every check-in, security line and passport stamp along the way.
      </p>
      <form class="ob-form">
        <label
          >Your name (as in your passport)<input name="name" required maxlength="40" placeholder="e.g. Ada Okafor" autocomplete="name"
        /></label>
        <label
          >Nationality<select name="nat">
            ${opts.map((c) => html`<option value="${c.iso}" ${c.iso === guess ? raw('selected') : ''}>${flag(c.iso)} ${c.n}</option>`)}
          </select></label
        >
        <label
          >Home city
          <div class="ac-wrap"><input name="home" placeholder="Search a city, airport or address" autocomplete="off" required /></div
        ></label>
        <p class="muted">You start with ${money(5000)} for tickets, fuel and rentals. Run low and you can work remotely to top up.</p>
        <button class="btn btn-primary" type="submit">Issue my passport</button>
      </form>
    </div>`,
    { dismissable: false },
  );
  let home = null;
  placeInput($('input[name=home]', m.box), { onPick: (p) => (home = p) });
  $('form', m.box).onsubmit = (e) => {
    e.preventDefault();
    unlockAudio();
    const f = e.target;
    if (!home) {
      toast('Pick your home city from the suggestions');
      return;
    }
    state.profile = {
      name: f.name.value.trim(),
      nationality: f.nat.value,
      home,
      passportNo: `${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      createdAt: Date.now(),
    };
    save();
    m.close();
    done();
  };
}
