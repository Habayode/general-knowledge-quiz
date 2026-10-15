#!/usr/bin/env node
// End-to-end journeys in headless Chromium (WebGL via SwiftShader) with every
// external service mocked by ./fixtures.mjs. Screenshots land in
// tests/e2e/screenshots/. Usage: npm run test:e2e [-- scenario-name]
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './server.mjs';
import { SAT_TILE, NIGHT_TILE, TERRAIN_TILE, osrmRoute, photon, meteo, wiki } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SHOTS = join(HERE, 'screenshots');
const only = process.argv[2];

const server = await serve(ROOT);
const BASE = `http://127.0.0.1:${server.address().port}/`;
await mkdir(SHOTS, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const maplibreJs = await readFile(join(ROOT, 'node_modules/maplibre-gl/dist/maplibre-gl.js'));
const maplibreCss = await readFile(join(ROOT, 'node_modules/maplibre-gl/dist/maplibre-gl.css'));

async function newPage({ width = 1440, height = 900, profile = true, settings = {} } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR|404/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    const json = (obj) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(obj),
      });
    if (url.startsWith(BASE)) return route.continue();
    if (url.includes('unpkg.com/maplibre-gl') && url.endsWith('.js'))
      return route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        headers: { 'access-control-allow-origin': '*' },
        body: maplibreJs,
      });
    if (url.includes('unpkg.com/maplibre-gl') && url.endsWith('.css'))
      return route.fulfill({ status: 200, contentType: 'text/css', headers: { 'access-control-allow-origin': '*' }, body: maplibreCss });
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com'))
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (url.includes('World_Imagery') || url.includes('Reference/'))
      return route.fulfill({ status: 200, contentType: 'image/png', body: SAT_TILE });
    if (url.includes('gibs.earthdata.nasa.gov')) return route.fulfill({ status: 200, contentType: 'image/png', body: NIGHT_TILE });
    if (url.includes('elevation-tiles-prod')) return route.fulfill({ status: 200, contentType: 'image/png', body: TERRAIN_TILE });
    if (url.includes('tiles.openfreemap.org')) return route.fulfill({ status: 404, body: '' });
    if (url.includes('/route/v1/')) return json(osrmRoute(url));
    if (url.includes('photon.komoot.io')) return json(photon(url));
    if (url.includes('api.open-meteo.com')) return json(meteo(url));
    if (url.includes('wikipedia.org')) return json(wiki(url));
    return route.fulfill({ status: 404, body: '' });
  });
  if (profile) {
    await context.addInitScript(
      ([s]) => {
        localStorage.setItem(
          'wayfarer.v1',
          JSON.stringify({
            profile: {
              name: 'Ada Okafor',
              nationality: 'NG',
              passportNo: 'A12345678',
              createdAt: 0,
              home: { kind: 'place', name: 'Ikeja', label: 'Ikeja, Lagos State, Nigeria', coord: [3.3515, 6.6018], iso: 'NG' },
            },
            settings: { voice: false, sound: false, autoChecks: true, labels: true, buildings: true, timeScale: 1800, ...s },
          }),
        );
      },
      [settings],
    );
  }
  await page.goto(BASE);
  await page.waitForFunction(() => window.wayfarer?.map?.ready, null, { timeout: 60000 });
  return { page, context, errors };
}

async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function pickStop(page, index, query, optionText) {
  const input = page.locator('.stop-input').nth(index);
  await input.click();
  await input.fill(query);
  const opt = page.locator('.ac-list li', { hasText: optionText }).first();
  await opt.waitFor({ timeout: 10000 });
  await opt.dispatchEvent('mousedown');
}

async function setMode(page, gap, mode) {
  await page.locator(`.gap[data-g="${gap}"] .mode[data-m="${mode}"]`).click();
}

/** Drive the protocol sheets and journey to the finish modal. */
async function runToFinish(page, { maxMs = 240000, shots = [] } = {}) {
  const start = Date.now();
  const taken = new Set();
  while (Date.now() - start < maxMs) {
    if (
      await page
        .locator('.finish')
        .isVisible()
        .catch(() => false)
    )
      return true;
    // Fast-forward waits.
    const skip = page.locator('.sheet-foot .btn', { hasText: 'Skip waiting' });
    if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
    const skip2 = page.locator('#skipwait');
    if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {});
    for (const s of shots) {
      if (taken.has(s.name)) continue;
      if (await s.when(page)) {
        taken.add(s.name);
        await page.waitForTimeout(s.delay ?? 600);
        await shot(page, s.name);
      }
    }
    await page.waitForTimeout(250);
  }
  return false;
}

/** Play the protocols by hand (express mode off): tick, choose, seat, trays. */
async function playManually(page, { maxMs = 300000, shots = [] } = {}) {
  const start = Date.now();
  const taken = new Set();
  const correct = { laptop: 'own', liquids: 'own', water: 'bin', belt: 'tray', pockets: 'tray', jacket: 'tray', passport: 'keep' };
  while (Date.now() - start < maxMs) {
    if (
      await page
        .locator('.finish')
        .isVisible()
        .catch(() => false)
    )
      return true;
    for (const s of shots) {
      if (!taken.has(s.name) && (await s.when(page).catch(() => false))) {
        taken.add(s.name);
        await page.waitForTimeout(s.delay ?? 400);
        await shot(page, s.name);
      }
    }
    const act = async (loc) => {
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 2000 }).catch(() => {});
        return true;
      }
      return false;
    };
    for (const box of await page.locator('.sheet .checklist input:not(:checked)').all()) await box.check().catch(() => {});
    for (const row of await page.locator('.sheet .tray-item').all()) {
      if (!(await row.locator('.chip.on').count()))
        await row
          .locator(`.chip[data-v="${correct[await row.getAttribute('data-id')]}"]`)
          .click()
          .catch(() => {});
    }
    if (await act(page.locator('.sheet .seatmap .seat.window:not(.taken):not(:disabled)').first())) continue;
    if (await act(page.locator('.sheet .opt:not(:disabled)').first())) continue;
    if (await act(page.locator('.sheet-foot .btn', { hasText: 'Skip waiting' }))) continue;
    if (await act(page.locator('.sheet-foot .btn-primary'))) continue;
    await act(page.locator('#skipwait'));
    await page.waitForTimeout(200);
  }
  return false;
}

const scenarios = {
  async onboarding() {
    const { page, context, errors } = await newPage({ profile: false });
    await page.locator('.onboard').waitFor();
    await shot(page, '01-onboarding');
    await page.fill('input[name=name]', 'Ada Okafor');
    await page.selectOption('select[name=nat]', 'NG');
    await page.fill('input[name=home]', 'LOS');
    await page.locator('.ac-list li', { hasText: 'Lagos LOS' }).first().dispatchEvent('mousedown');
    await page.click('.ob-form button[type=submit]');
    await page.locator('.planner').waitFor();
    const st = await page.evaluate(() => window.wayfarer.state.profile);
    if (st.name !== 'Ada Okafor' || st.home.iata !== 'LOS') throw new Error('Profile not saved');
    await page.waitForTimeout(1500);
    await shot(page, '02-planner');
    await context.close();
    return errors;
  },

  async flight() {
    const { page, context, errors } = await newPage();
    await pickStop(page, 1, 'London', 'England');
    await setMode(page, 0, 'fly');
    await page.click('.preview');
    await page.locator('.btn-go').waitFor({ timeout: 30000 });
    await page.waitForTimeout(2600);
    await shot(page, '03-flight-plan');
    const legs = await page.locator('.leg').count();
    if (legs !== 3) throw new Error(`Expected drive→fly→drive (3 legs), got ${legs}`);
    await page.click('.btn-go');
    const ok = await runToFinish(page, {
      shots: [
        { name: '04-drive-hud', when: async (p) => (await p.locator('.cluster').isVisible()) && (await p.locator('#sheet').isHidden()) },
        { name: '05-boarding-pass', when: (p) => p.locator('.boarding-pass').isVisible(), delay: 300 },
        { name: '06-security', when: (p) => p.locator('.trays').isVisible(), delay: 300 },
        { name: '07-fids', when: (p) => p.locator('.fids').isVisible(), delay: 200 },
        {
          name: '08-inflight',
          when: async (p) =>
            (await p.locator('.pfd').isVisible()) && (await p.evaluate(() => (window.wayfarer.journey?.runner?.altFt || 0) > 30000)),
        },
        { name: '09-immigration-stamp', when: (p) => p.locator('.stamp-drop').isVisible(), delay: 500 },
        { name: '10-arrival-card', when: (p) => p.locator('.arrival-card').isVisible(), delay: 300 },
      ],
    });
    if (!ok) throw new Error('Flight journey did not finish');
    await shot(page, '11-finish');
    const s = await page.evaluate(() => window.wayfarer.state);
    if (s.stats.flights !== 1) throw new Error('flight not counted');
    if (!s.visited.GB) throw new Error('UK not visited');
    if (!s.stamps.some((x) => x.iso === 'GB' && x.port === 'LHR')) throw new Error('No LHR entry stamp');
    if (!(s.wallet < 5000)) throw new Error('Nothing was paid');
    await page.click('.modal-x');
    await page.click('.tab[data-tab="passport"]');
    await page.waitForTimeout(500);
    await shot(page, '12-passport');
    await context.close();
    return errors;
  },

  async ferry() {
    const { page, context, errors } = await newPage();
    await pickStop(page, 0, 'London', 'England');
    await pickStop(page, 1, 'Dover', 'Port of Dover');
    await page.click('.add-stop');
    await pickStop(page, 2, 'Calais', 'Port of Calais');
    await page.click('.add-stop');
    await pickStop(page, 3, 'Paris', 'Paris');
    await setMode(page, 0, 'drive');
    await setMode(page, 1, 'sail');
    await setMode(page, 2, 'drive');
    await page.click('.preview');
    await page.locator('.btn-go').waitFor({ timeout: 30000 });
    const text = await page.locator('.summary').innerText();
    if (!/with your car/.test(text)) throw new Error('Ferry leg should carry the car');
    await page.waitForTimeout(2600);
    await shot(page, '13-ferry-plan');
    await page.click('.btn-go');
    const ok = await runToFinish(page, {
      shots: [
        { name: '14-ferry-card', when: (p) => p.locator('.ferry-card').isVisible(), delay: 300 },
        { name: '15-at-sea', when: async (p) => (await p.locator('.bridge').isVisible()) && (await p.locator('#sheet').isHidden()) },
      ],
    });
    if (!ok) throw new Error('Ferry journey did not finish');
    if (errors.length) return errors;
    const s = await page.evaluate(() => window.wayfarer.state);
    if (!s.stamps.some((x) => x.iso === 'FR' && x.port === 'CQF'))
      throw new Error(
        `Juxtaposed French stamp missing: ${JSON.stringify(s.stamps)} legs=${JSON.stringify(await page.evaluate(() => document.querySelector('.leg-progress')?.innerText))}`,
      );
    if (s.stats.voyages !== 1) throw new Error('voyage not counted');
    await context.close();
    return errors;
  },

  async cruise() {
    const { page, context, errors } = await newPage();
    await pickStop(page, 0, 'Southampton', 'Southampton Cruise');
    await pickStop(page, 1, 'New York', 'Manhattan Cruise');
    await setMode(page, 0, 'sail');
    await page.click('.preview');
    await page.locator('.btn-go').waitFor({ timeout: 30000 });
    await page.waitForTimeout(2600);
    await shot(page, '16-cruise-plan');
    const km = await page.evaluate(() => window.wayfarer.map && document.querySelector('.sum-head b').textContent);
    if (!/5,[6-9]\d\d|6,\d\d\d/.test(km)) throw new Error(`Unexpected Southampton–New York distance ${km}`);
    await context.close();
    return errors;
  },

  async manual() {
    const { page, context, errors } = await newPage({ settings: { autoChecks: false, timeScale: 7200 } });
    await pickStop(page, 0, 'LHR', 'London LHR');
    await pickStop(page, 1, 'CDG', 'Paris CDG');
    await page.click('.preview');
    await page.locator('.btn-go').waitFor({ timeout: 30000 });
    await page.click('.btn-go');
    const ok = await playManually(page, {
      shots: [
        { name: '06-seatmap', when: (p) => p.locator('.sheet .seatmap').isVisible() },
        { name: '07-security', when: async (p) => (await p.locator('.sheet .tray-item .chip.on').count()) >= 7 },
        { name: '07b-fids', when: (p) => p.locator('.sheet .fids').isVisible() },
        { name: '07c-bagtag', when: (p) => p.locator('.sheet .bagtag').isVisible() },
      ],
    });
    if (!ok) {
      await shot(page, 'fail-manual');
      throw new Error(
        `Manual flight did not finish: ${await page
          .locator('.sheet')
          .innerText()
          .catch(() => 'no sheet')}`,
      );
    }
    const s = await page.evaluate(() => window.wayfarer.state);
    // LHR→CDG: UK to Schengen: passport control on departure and entry stamp at CDG.
    if (!s.stamps.some((x) => x.iso === 'FR' && x.port === 'CDG')) throw new Error('No CDG stamp');
    await context.close();
    return errors;
  },

  async mobile() {
    const { page, context, errors } = await newPage({ width: 390, height: 844 });
    await page.waitForTimeout(1500);
    await shot(page, '17-mobile-planner');
    await page.click('.tab[data-tab="explore"]');
    await page.locator('.lm').first().click();
    await page.locator('.wiki-extract').waitFor();
    await page.waitForTimeout(800);
    await shot(page, '18-mobile-landmark');
    await context.close();
    return errors;
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(scenarios)) {
  if (only && name !== only) continue;
  const t = Date.now();
  try {
    const errors = await fn();
    if (errors.length) throw new Error(`Browser errors:\n  ${errors.join('\n  ')}`);
    console.log(`✔ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (err) {
    failed++;
    console.error(`✘ ${name}: ${err.stack || err.message}`);
  }
}
await browser.close();
server.close();
process.exitCode = failed ? 1 : 0;
