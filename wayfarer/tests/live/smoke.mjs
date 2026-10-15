#!/usr/bin/env node
// Live smoke test of the DEPLOYED site against the REAL services: Esri
// imagery, OSRM, Photon, Open-Meteo winds and Wikipedia. Run on GitHub
// Actions after each Pages deployment (see .github/workflows/wayfarer-live.yml).
//
// Usage: node tests/live/smoke.mjs [url]   (default: the GitHub Pages URL)
// Exit code 0 = every check passed. A JSON report is printed and screenshots
// are written to tests/live/screenshots/.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = process.argv[2] || process.env.WAYFARER_URL || 'https://habayode.github.io/general-knowledge-quiz/wayfarer/';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');
await mkdir(SHOTS, { recursive: true });

const report = { url: URL_, checks: [], errors: [], services: {} };
const check = (name, ok, detail = '') => {
  report.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` · ${String(detail).slice(0, 160)}` : ''}`);
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  if (localStorage.getItem('wayfarer.v1')) return;
  localStorage.setItem(
    'wayfarer.v1',
    JSON.stringify({
      profile: {
        name: 'Smoke Test',
        nationality: 'NG',
        passportNo: 'A00000000',
        createdAt: 0,
        home: { kind: 'place', name: 'Ikeja', label: 'Ikeja, Lagos, Nigeria', coord: [3.3515, 6.6018], iso: 'NG' },
      },
      settings: { voice: false, sound: false, autoChecks: true, labels: true, buildings: true, terrain: false, timeScale: 7200 },
    }),
  );
});
const page = await context.newPage();
page.on('pageerror', (e) => report.errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && report.errors.push(`console: ${m.text()}`));
const SERVICES = {
  imagery: /World_Imagery/,
  terrainOrLabels: /Reference\/|elevation-tiles/,
  osrm: /\/route\/v1\//,
  photon: /photon\.komoot\.io/,
  meteo: /open-meteo\.com/,
  wikipedia: /wikipedia\.org/,
  maplibre: /unpkg\.com\/maplibre-gl/,
};
page.on('response', (r) => {
  for (const [k, re] of Object.entries(SERVICES)) {
    if (re.test(r.url())) {
      const s = (report.services[k] ||= { ok: 0, fail: 0, statuses: {} });
      s[r.ok() ? 'ok' : 'fail']++;
      s.statuses[r.status()] = (s.statuses[r.status()] || 0) + 1;
    }
  }
});
const shot = (n) => page.screenshot({ path: join(SHOTS, `${n}.png`) });

async function pickStop(index, query, match) {
  const input = page.locator('.stop-input').nth(index);
  await input.click();
  await input.fill(query);
  const opt = page.locator('.ac-list li', { hasText: match }).first();
  await opt.waitFor({ timeout: 20000 });
  await opt.dispatchEvent('mousedown');
}

async function plan(label) {
  await page.click('.preview');
  const result = await Promise.race([
    page
      .locator('.btn-go')
      .waitFor({ timeout: 60000 })
      .then(() => 'ok'),
    page
      .locator('.plan-out .notice.warn')
      .waitFor({ timeout: 60000 })
      .then(() => 'warn'),
  ]).catch(() => 'timeout');
  const text = await page
    .locator('.plan-out')
    .innerText()
    .catch(() => '');
  check(`${label}: route planned`, result === 'ok', text.replace(/\s+/g, ' '));
  return result === 'ok';
}

async function resetPlanner() {
  await page.evaluate(() => {
    const p = document.querySelector('#tab-plan');
    p && p.querySelectorAll('.rm').forEach((b) => b.click());
  });
}

try {
  const res = await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
  check('page served', res?.ok(), `HTTP ${res?.status()}`);
  await page.waitForFunction(() => window.wayfarer?.map?.ready, null, { timeout: 90000 });
  check('3D globe initialised (MapLibre + WebGL)', true);
  await page.waitForTimeout(6000);
  check('satellite imagery tiles load', (report.services.imagery?.ok || 0) > 3, JSON.stringify(report.services.imagery));
  await shot('01-globe');

  // 1) Road: real Photon search + real OSRM route, then drive it to the end.
  await pickStop(1, 'Lekki Phase 1', /Lekki/);
  await page.locator('.gap[data-g="0"] .mode[data-m="drive"]').click();
  if (await plan('Drive Ikeja → Lekki (OSRM)')) {
    await page.waitForTimeout(2500);
    await shot('02-drive-plan');
    await page.click('.btn-go');
    const t0 = Date.now();
    let finished = false;
    let shotHud = false;
    while (Date.now() - t0 < 180000) {
      if (
        await page
          .locator('.finish')
          .isVisible()
          .catch(() => false)
      ) {
        finished = true;
        break;
      }
      for (const sel of ['.sheet-foot .btn:has-text("Skip waiting")', '#skipwait']) {
        const b = page.locator(sel);
        if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
      }
      if (
        !shotHud &&
        (await page
          .locator('.cluster')
          .isVisible()
          .catch(() => false)) &&
        (await page.locator('#sheet').isHidden())
      ) {
        shotHud = true;
        await page.waitForTimeout(1500);
        await shot('03-driving');
      }
      await page.waitForTimeout(300);
    }
    check('drive journey completes on real road data', finished);
    await shot('04-arrived');
    await page
      .locator('.modal-x')
      .click()
      .catch(() => {});
    await page
      .locator('#wiki .wiki-x')
      .click()
      .catch(() => {});
  }

  // 2) Air: airport-to-airport with live winds aloft.
  await resetPlanner();
  await pickStop(0, 'LOS', 'Lagos LOS');
  await pickStop(1, 'LHR', 'London LHR');
  await page.locator('.gap[data-g="0"] .mode[data-m="fly"]').click();
  if (await plan('Fly LOS → LHR (great circle + Open-Meteo winds)')) {
    await page.waitForTimeout(2500);
    await shot('05-flight-plan');
  }

  // 3) Sea: car ferry over the real shipping-lane graph.
  await pickStop(0, 'Dover', 'Port of Dover');
  await pickStop(1, 'Calais', 'Port of Calais');
  await page.locator('.gap[data-g="0"] .mode[data-m="sail"]').click();
  if (await plan('Sail Dover → Calais (shipping lanes)')) {
    await page.waitForTimeout(2500);
    await shot('06-ferry-plan');
  }

  // 4) Landmark card with a live Wikipedia summary.
  await page.click('.tab[data-tab="explore"]');
  await page.locator('.lm', { hasText: 'Eiffel' }).click();
  const extract = await page
    .locator('.wiki-extract')
    .innerText({ timeout: 20000 })
    .catch(() => '');
  check(
    'landmark card loads Wikipedia summary',
    /Eiffel|Paris|tower/i.test(extract) && !/unavailable/.test(extract),
    extract.slice(0, 120),
  );
  await page.waitForTimeout(5000);
  await shot('07-landmark');

  for (const k of ['imagery', 'osrm', 'photon', 'meteo', 'wikipedia']) {
    const s = report.services[k];
    check(`live service reachable: ${k}`, s && s.ok > 0, JSON.stringify(s || {}));
  }
  check('no JavaScript errors', report.errors.length === 0, report.errors.join(' | '));
} catch (err) {
  check('smoke test ran to completion', false, err.stack || err.message);
  await shot('99-failure').catch(() => {});
} finally {
  await browser.close();
}

await writeFile(join(SHOTS, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\nREPORT ${JSON.stringify(report)}`);
const failed = report.checks.filter((c) => !c.ok);
console.log(`\n${report.checks.length - failed.length}/${report.checks.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
