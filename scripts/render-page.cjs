#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function ensureSetup() {
  const localPlaywright = path.resolve(__dirname, '../node_modules/playwright');
  if (fs.existsSync(localPlaywright)) return;

  const setupScript = path.resolve(__dirname, 'setup.cjs');
  const result = spawnSync(process.execPath, [setupScript], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    console.error('Automatic setup failed for render-page.cjs');
    console.error('See ../setup-report.json for details.');
    process.exit(result.status || 1);
  }
}

ensureSetup();

function loadPlaywright() {
  const moduleOverride = process.env.PLAYWRIGHT_MODULE_PATH;
  const candidates = moduleOverride ? [moduleOverride, 'playwright'] : ['playwright'];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {}
  }

  throw new Error(`Playwright module not found. Install it first or set PLAYWRIGHT_MODULE_PATH. Checked: ${candidates.join(', ')}`);
}

const { chromium } = loadPlaywright();

async function main() {
  const url = process.argv[2];
  const outputPath = process.argv[3] || path.resolve(process.cwd(), 'figma-pixel-runs/project/run-id/capture/captured-page.png');
  const width = Number(process.argv[4] || 1600);
  const height = Number(process.argv[5] || 900);

  if (!url) {
    console.error('Usage: node scripts/render-page.cjs <url> [capture-output-path] [width] [height]');
    process.exit(1);
  }

  const executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1
  });

  const failedRequests = [];
  const badResponses = [];

  page.on('requestfailed', (request) => {
    failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText || 'unknown'
    });
  });

  page.on('response', (response) => {
    const status = response.status();
    if (status >= 400) {
      badResponses.push({
        url: response.url(),
        status
      });
    }
  });

  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  if (!response) throw new Error('No response from page');
  if (response.status() >= 400) throw new Error(`Page returned status ${response.status()}`);

  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }

    const images = Array.from(document.images || []);
    await Promise.all(
      images.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
      })
    );
  });

  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
      }
      html {
        scroll-behavior: auto !important;
      }
    `
  });

  await page.screenshot({
    path: outputPath,
    fullPage: true
  });

  const report = {
    ok: true,
    url,
    outputPath: path.resolve(outputPath),
    viewport: { width, height },
    executablePath,
    failedRequests,
    badResponses
  };

  fs.writeFileSync(
    path.join(path.dirname(outputPath), 'render-report.json'),
    JSON.stringify(report, null, 2)
  );

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
