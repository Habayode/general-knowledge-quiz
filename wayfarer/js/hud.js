// Mode-specific dashboards: car instrument cluster, cycling computer,
// aircraft primary flight display + in-flight map data, ship's bridge readout.
import { html, raw } from './dom.js';
import { compass, formatCoord, isaTemperature, speedOfSound, FT_PER_M, MS_PER_KNOT } from './geo.js';
import { VEHICLES } from './data/vehicles.js';
import { fmtDur, fmtTime } from './protocols.js';
import { flag } from './countries.js';

const ARROWS = {
  left: 'M30 8 L12 24 L30 40 M12 24 H44 V52',
  right: 'M26 8 L44 24 L26 40 M44 24 H12 V52',
  'slight left': 'M22 6 L10 18 L24 22 M11 18 L30 36 V54',
  'slight right': 'M34 6 L46 18 L32 22 M45 18 L26 36 V54',
  'sharp left': 'M14 30 L14 48 L32 48 M15 47 L42 20 V6',
  'sharp right': 'M42 30 L42 48 L24 48 M41 47 L14 20 V6',
  uturn: 'M16 54 V22 A12 12 0 0 1 40 22 V40 M30 32 L40 44 L50 32',
  straight: 'M28 6 L16 20 M28 6 L40 20 M28 6 V54',
};

function arrow(step) {
  if (!step) return '';
  let key = step.modifier || 'straight';
  if (step.type === 'arrive')
    return '<svg viewBox="0 0 56 56" class="tbt-arrow"><path d="M28 6 C18 6 12 14 12 22 C12 34 28 50 28 50 C28 50 44 34 44 22 C44 14 38 6 28 6Z" fill="currentColor"/><circle cx="28" cy="22" r="6" fill="#0b1626"/></svg>';
  if (step.type === 'roundabout' || step.type === 'rotary') {
    return `<svg viewBox="0 0 56 56" class="tbt-arrow"><circle cx="28" cy="30" r="10" fill="none" stroke="currentColor" stroke-width="5"/><path d="M28 54 V40 M36 23 L48 10 M40 10 H48 V18" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><text x="28" y="35" font-size="12" text-anchor="middle" fill="currentColor" font-weight="800">${step.exit || ''}</text></svg>`;
  }
  if (!ARROWS[key]) key = 'straight';
  return `<svg viewBox="0 0 56 56" class="tbt-arrow"><path d="${ARROWS[key]}" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function fmtDist(m) {
  if (m >= 10000) return `${Math.round(m / 1000)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  if (m >= 100) return `${Math.round(m / 50) * 50} m`;
  return `${Math.max(0, Math.round(m / 10) * 10)} m`;
}

/** SVG speedometer dial. */
function dial(value, max, label, unit, ticks = 8) {
  const a0 = -225;
  const a1 = 45;
  const ang = a0 + (Math.min(value, max) / max) * (a1 - a0);
  const pt = (deg, r) => {
    const t = (deg * Math.PI) / 180;
    return [60 + r * Math.cos(t), 60 + r * Math.sin(t)];
  };
  let marks = '';
  for (let i = 0; i <= ticks * 2; i++) {
    const deg = a0 + (i / (ticks * 2)) * (a1 - a0);
    const [x1, y1] = pt(deg, i % 2 ? 46 : 42);
    const [x2, y2] = pt(deg, 51);
    marks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#9fb3c8" stroke-width="${i % 2 ? 1 : 2}"/>`;
    if (!(i % 2)) {
      const [tx, ty] = pt(deg, 33);
      marks += `<text x="${tx}" y="${ty + 3}" text-anchor="middle" font-size="8" fill="#9fb3c8">${Math.round((i / (ticks * 2)) * max)}</text>`;
    }
  }
  const [nx, ny] = pt(ang, 44);
  const arcEnd = pt(ang, 54);
  const large = ang - a0 > 180 ? 1 : 0;
  const [sx, sy] = pt(a0, 54);
  return `<svg viewBox="0 0 120 112" class="dial" role="img" aria-label="${label} ${Math.round(value)} ${unit}">
    <path d="M${sx} ${sy} A54 54 0 ${large} 1 ${arcEnd[0]} ${arcEnd[1]}" fill="none" stroke="url(#dg)" stroke-width="5" stroke-linecap="round"/>
    <defs><linearGradient id="dg" x1="0" x2="1"><stop offset="0" stop-color="#29b6f6"/><stop offset="1" stop-color="#ff6d3a"/></linearGradient></defs>
    ${marks}
    <line x1="60" y1="60" x2="${nx}" y2="${ny}" stroke="#ff6d3a" stroke-width="3" stroke-linecap="round"/>
    <circle cx="60" cy="60" r="5" fill="#ff6d3a"/>
    <text x="60" y="88" text-anchor="middle" font-size="20" font-weight="800" fill="#fff">${Math.round(value)}</text>
    <text x="60" y="100" text-anchor="middle" font-size="8" fill="#9fb3c8">${unit}</text>
  </svg>`;
}

/** Heading tape for aircraft and ships. */
function headingTape(hdg) {
  const items = [];
  for (let d = -40; d <= 40; d += 5) {
    const v = (Math.round(hdg / 5) * 5 + d + 360) % 360;
    const x = 50 + (((v - hdg + 540) % 360) - 180) * 1.1;
    const big = v % 30 === 0;
    items.push(`<line x1="${x}" y1="${big ? 10 : 14}" x2="${x}" y2="20" stroke="#cfe" stroke-width="${big ? 1.4 : 0.8}"/>`);
    if (big)
      items.push(
        `<text x="${x}" y="8" text-anchor="middle" font-size="6.5" fill="#cfe">${v === 0 ? 'N' : v === 90 ? 'E' : v === 180 ? 'S' : v === 270 ? 'W' : String(v / 10).padStart(2, '0')}</text>`,
      );
  }
  return `<svg viewBox="0 0 100 22" class="htape"><rect width="100" height="22" fill="#05111f"/>${items.join('')}<path d="M50 20 L46 14 H54Z" fill="#ffcc00"/></svg>`;
}

export class Hud {
  constructor(root) {
    this.root = root;
    this.mode = null;
    this.last = 0;
  }

  clear() {
    this.root.innerHTML = '';
    this.root.hidden = true;
    this.mode = null;
  }

  /** Re-render at most ~8×/s (dashboards don't need 60 fps). */
  update(t, ctx) {
    const now = performance.now();
    if (now - this.last < 120) return;
    this.last = now;
    this.root.hidden = false;
    const v = VEHICLES[t.vehicle];
    let body;
    if (t.mode === 'fly') body = this.flight(t, ctx);
    else if (t.mode === 'sail') body = this.ship(t, ctx, v);
    else if (v.mode === 'drive') body = this.car(t, ctx, v);
    else body = this.active(t, ctx, v);
    this.root.className = `hud hud-${t.mode}`;
    this.root.innerHTML = String(body);
  }

  progress(t) {
    const f = t.total ? t.d / t.total : 0;
    return html`<div class="hud-progress" aria-hidden="true"><div style="width:${(f * 100).toFixed(2)}%"></div></div>`;
  }

  car(t, ctx, v) {
    const kmh = t.speedMs * 3.6;
    const fuelPct = v.batteryKWh ? (t.battery / v.batteryKWh) * 100 : (t.fuel / v.tankL) * 100;
    const next = t.nextStep;
    const etaLocal = fmtTime(ctx.clock.simMs + t.etaS * 1000, ctx.localTz);
    return html` ${this.progress(t)}
      <div class="cluster">
        <div class="cl-dial">${raw(dial(kmh, v.topSpeedKmh > 200 ? 260 : 220, 'Speed', 'km/h'))}</div>
        <div class="cl-mid">
          ${t.stopped
            ? html`<div class="tbt stop">
                <span class="tbt-icon">⏸</span>
                <div>
                  <div class="tbt-dist">${fmtDur(t.stopLeftS)}</div>
                  <div class="tbt-text">${t.status}</div>
                </div>
              </div>`
            : html`<div class="tbt">
                ${raw(arrow(next))}
                <div>
                  <div class="tbt-dist">${fmtDist(t.toNextM)}</div>
                  <div class="tbt-text">${next?.text || t.status}</div>
                </div>
              </div>`}
          <div class="cl-row">
            <span class="pill">${t.leftHand ? '⬅ Keep LEFT' : 'Keep RIGHT ➡'}</span>
            <span class="pill">${t.country ? `${flag(t.country.iso)} ${t.country.name}` : ''}</span>
          </div>
        </div>
        <div class="cl-side">
          <div class="gear">${t.gear || 'D'}</div>
          <div class="gauge">
            <span>${v.batteryKWh ? '🔋' : '⛽'}</span>
            <div class="gbar ${fuelPct < 15 ? 'low' : ''}"><div style="width:${Math.max(0, fuelPct).toFixed(0)}%"></div></div>
            <span>${Math.max(0, fuelPct).toFixed(0)}%</span>
          </div>
          <div class="kv-mini"><span>Trip</span><b>${(t.d / 1000).toFixed(1)} km</b></div>
          <div class="kv-mini"><span>To go</span><b>${fmtDist(t.total - t.d)}</b></div>
          <div class="kv-mini"><span>ETA</span><b>${etaLocal}</b></div>
        </div>
      </div>`;
  }

  active(t, ctx, v) {
    const kmh = t.speedMs * 3.6;
    const hr = Math.round(v.mode === 'bike' ? 118 + kmh * 1.6 : 92 + kmh * 4);
    return html` ${this.progress(t)}
      <div class="bikecomp">
        <div class="bc-main"><span class="bc-speed">${kmh.toFixed(1)}</span><span class="bc-unit">km/h</span></div>
        <div class="bc-grid">
          <div><span>Distance</span><b>${(t.d / 1000).toFixed(2)} km</b></div>
          <div><span>To go</span><b>${fmtDist(t.total - t.d)}</b></div>
          <div><span>Moving time</span><b>${fmtDur(t.drivingS)}</b></div>
          <div><span>Heart rate</span><b>${t.stopped ? 88 : hr} bpm</b></div>
          <div><span>Energy</span><b>${Math.round(t.kcal)} kcal</b></div>
          ${v.mode === 'bike'
            ? html`<div><span>Cadence</span><b>${t.stopped ? 0 : Math.round(72 + kmh)} rpm</b></div>`
            : html`<div><span>Steps</span><b>${Math.round(t.d / 0.75).toLocaleString('en-US')}</b></div>`}
        </div>
        <div class="tbt compact">
          ${raw(arrow(t.nextStep))}
          <div>
            <div class="tbt-dist">${t.stopped ? fmtDur(t.stopLeftS) : fmtDist(t.toNextM)}</div>
            <div class="tbt-text">${t.stopped ? t.status : t.nextStep?.text || ''}</div>
          </div>
        </div>
      </div>`;
  }

  flight(t, ctx) {
    const p = t.plan;
    const altM = t.altFt / FT_PER_M;
    const mach = (t.tasKts * MS_PER_KNOT) / speedOfSound(altM);
    const sat = isaTemperature(altM);
    const toGoKm = (t.total - t.d) / 1000;
    const pct = t.d / t.total;
    const fl = t.altFt >= 18000 ? `FL${String(Math.round(t.altFt / 100)).padStart(3, '0')}` : `${Math.round(t.altFt / 10) * 10} ft`;
    return html` <div class="pfd">
      <div class="pfd-tape speed">
        <span class="label">TAS</span><span class="val">${Math.round(t.tasKts)}</span><span class="unit">kt</span
        ><span class="sub">GS ${Math.round(t.gsKts)}</span>
      </div>
      <div class="pfd-center">
        <div class="pfd-phase">
          ${t.phase}${t.seatbelt ? html` <span class="belt" title="Fasten seat belt sign">🔔 SEAT BELTS</span>` : ''}
        </div>
        ${raw(headingTape(t.heading))}
        <div class="ifm">
          <span class="ifm-code">${p.from.iata}</span>
          <div class="ifm-track">
            <div class="ifm-done" style="width:${(pct * 100).toFixed(1)}%"></div>
            <span class="ifm-plane" style="left:${(pct * 100).toFixed(1)}%">✈</span>
          </div>
          <span class="ifm-code">${p.to.iata}</span>
        </div>
        <div class="ifm-grid">
          <div><span>Distance to go</span><b>${Math.round(toGoKm).toLocaleString('en-US')} km</b></div>
          <div><span>Time to destination</span><b>${fmtDur(t.etaS)}</b></div>
          <div><span>Local time ${p.from.iata}</span><b>${fmtTime(ctx.clock.simMs, p.from.tz)}</b></div>
          <div><span>Local time ${p.to.iata}</span><b>${fmtTime(ctx.clock.simMs, p.to.tz)}</b></div>
          <div><span>Outside air</span><b>${Math.round(sat)}°C</b></div>
          <div><span>Mach</span><b>${t.altFt > 10000 ? mach.toFixed(2) : '—'}</b></div>
        </div>
      </div>
      <div class="pfd-tape alt">
        <span class="label">ALT</span><span class="val">${fl}</span
        ><span class="unit">${Math.round(t.altFt).toLocaleString('en-US')} ft</span
        ><span class="sub ${t.vsFpm > 200 ? 'up' : t.vsFpm < -200 ? 'down' : ''}"
          >${t.vsFpm > 200 ? '▲' : t.vsFpm < -200 ? '▼' : '■'} ${Math.abs(Math.round(t.vsFpm / 100) * 100)} fpm</span
        >
      </div>
    </div>`;
  }

  ship(t, ctx, v) {
    return html` ${this.progress(t)}
      <div class="bridge">
        <div class="br-big"><span class="label">SOG</span><span class="val">${t.knots.toFixed(1)}</span><span class="unit">kn</span></div>
        <div class="br-big">
          <span class="label">COG</span><span class="val">${String(Math.round(t.cog)).padStart(3, '0')}°</span
          ><span class="unit">${compass(t.cog)}</span>
        </div>
        <div class="br-info">
          ${raw(headingTape(t.cog))}
          <div class="br-grid">
            <div><span>Position</span><b>${formatCoord(t.pos)}</b></div>
            <div><span>Distance to go</span><b>${Math.round(t.nmToGo).toLocaleString('en-US')} nmi</b></div>
            <div><span>ETA</span><b>${fmtDur(t.etaS)}</b></div>
            <div><span>Vessel</span><b>${v.name}</b></div>
            <div><span>Navigation</span><b>${t.pilot ? '⚓ Pilot on board' : '🧭 Master’s command'}</b></div>
            <div><span>Day at sea</span><b>${1 + Math.floor((ctx.clock.simMs - ctx.legStartMs) / 86400000)}</b></div>
          </div>
        </div>
      </div>`;
  }
}
