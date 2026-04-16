const fs = require('fs');
const path = require('path');

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

  // playwright (full package) ships its own bundled Chromium — no system browser needed
  const hasPlaywrightFull = (() => { try { require.resolve('playwright'); return true; } catch { return false; } })();

  const chromiumPath = process.env.CHROMIUM_PATH;
  let hasBrowser;
  if (chromiumPath) {
    hasBrowser = fs.existsSync(chromiumPath);
  } else if (hasPlaywrightFull) {
    hasBrowser = true;
  } else {
    hasBrowser = hasCommand('chromium') || hasCommand('chromium-browser') || hasCommand('google-chrome');
  }

  const problems = [];
  if (!hasPlaywright) problems.push('Missing dependency: playwright');
  if (!hasBrowser) {
    problems.push(
      chromiumPath
        ? `CHROMIUM_PATH does not exist: ${chromiumPath}`
        : 'Missing browser executable: install Chromium, set CHROMIUM_PATH, or run: npx playwright install chromium'
    );
  }

  if (!problems.length) return;

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

  ensureRenderRuntimePresent();
  const { chromium } = loadPlaywright();
  const resolvedOutputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });

  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  if (process.env.CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.CHROMIUM_PATH;
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
      executablePath: process.env.CHROMIUM_PATH || 'playwright-bundled',
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
