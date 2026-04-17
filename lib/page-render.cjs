const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function hasCommand(command) {
  const paths = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];

  for (const dir of paths) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (fs.existsSync(candidate)) return true;
    }
  }

  return false;
}

function resolveSystemChromiumPath() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  for (const command of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    try {
      const resolved = execSync(`command -v ${command}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {}
  }

  return null;
}

function ensureRenderRuntimePresent() {
  const requiredAny = ['playwright', 'playwright-core'];
  const hasPlaywright = requiredAny.some((name) => {
    try {
      require.resolve(name);
      return true;
    } catch {
      return false;
    }
  });

  const problems = [];
  if (!hasPlaywright) problems.push('Missing dependency: playwright');

  const explicitChromiumPath = process.env.CHROMIUM_PATH;
  if (explicitChromiumPath && !fs.existsSync(explicitChromiumPath)) {
    problems.push(`CHROMIUM_PATH does not exist: ${explicitChromiumPath}`);
  }

  const hasPlaywrightFull = (() => { try { require.resolve('playwright'); return true; } catch { return false; } })();
  const systemChromiumPath = explicitChromiumPath && fs.existsSync(explicitChromiumPath)
    ? explicitChromiumPath
    : resolveSystemChromiumPath();

  if (!hasPlaywrightFull && !systemChromiumPath) {
    problems.push('Missing browser executable: install Chromium, set CHROMIUM_PATH, or run: npx playwright install chromium');
  }

  if (!problems.length) return { systemChromiumPath };

  throw new Error([
    ...problems,
    'Install the required runtime in the host environment:',
    'npm install playwright',
    'npx playwright install chromium',
  ].join('\n'));
}

function loadPlaywright() {
  const moduleOverride = process.env.PLAYWRIGHT_MODULE_PATH;
  const candidates = moduleOverride ? [moduleOverride, 'playwright', 'playwright-core'] : ['playwright', 'playwright-core'];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {}
  }

  throw new Error(`Playwright module not found. Install playwright or set PLAYWRIGHT_MODULE_PATH. Checked: ${candidates.join(', ')}`);
}

async function renderPage(url, outputPath = path.resolve(process.cwd(), 'figma-pixel-runs/project/run-id/capture/captured-page.png'), width = 1600, height = 900) {
  if (!url) {
    throw new Error('Usage: node scripts/render-page.cjs <url> [capture-output-path] [width] [height]');
  }

  const { systemChromiumPath } = ensureRenderRuntimePresent();
  const { chromium } = loadPlaywright();
  const resolvedOutputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });

  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  if (systemChromiumPath) {
    launchOptions.executablePath = systemChromiumPath;
  }
  const browser = await chromium.launch(launchOptions);

  try {
    const page = await browser.newPage({
      viewport: { width: Number(width), height: Number(height) },
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

    const pageScrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);

    await page.screenshot({
      path: resolvedOutputPath,
      fullPage: true
    });

    const report = {
      ok: true,
      url,
      outputPath: resolvedOutputPath,
      viewport: { width: Number(width), height: Number(height) },
      pageScrollHeight,
      pageExceedsViewport: pageScrollHeight > Number(height) * 1.05,
      executablePath: launchOptions.executablePath || 'playwright-bundled',
      failedRequests,
      badResponses
    };

    fs.writeFileSync(
      path.join(path.dirname(resolvedOutputPath), 'render-report.json'),
      JSON.stringify(report, null, 2)
    );

    return report;
  } finally {
    await browser.close();
  }
}

module.exports = { renderPage };
