#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const process = require('process');
const { spawnSync } = require('child_process');

function ensureSetup() {
  const localBackstop = path.resolve(__dirname, '../node_modules/.bin/backstop');
  const localPlaywright = path.resolve(__dirname, '../node_modules/playwright');
  if (fs.existsSync(localBackstop) && fs.existsSync(localPlaywright)) return;

  const setupScript = path.resolve(__dirname, 'setup.cjs');
  const result = spawnSync(process.execPath, [setupScript], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    console.error('Automatic setup failed for backstop-compare.cjs');
    console.error('See ../setup-report.json for details.');
    process.exit(result.status || 1);
  }
}

ensureSetup();

function printUsage() {
  console.log(`Usage:\n  node scripts/backstop-compare.cjs --url <page-url> --mockup <image-path> [options]\n\nRequired:\n  --url <page-url>           URL сторінки для перевірки\n  --mockup <image-path>      Шлях до PNG/JPG макету\n\nOptions:\n  --selector <css>           Елемент для зйомки (default: body)\n  --viewport <WxH>           Розмір вікна, напр. 1440x900 (default: 1440x900)\n  --threshold <number>       Допустима різниця 0..1 (default: 0.1)\n  --label <name>             Назва сценарію (default: layout-compare)\n  --output <dir>             Папка результатів (default: figma-pixel-runs/project/run-id/backstop)\n  --run-test <yes|no>        Одразу запустити backstop test (default: no)\n`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 1) {
  const key = args[i];
  if (!key.startsWith('--')) continue;
  const value = args[i + 1];
  options[key.slice(2)] = value;
  i += 1;
}

if (options.help || options.h) {
  printUsage();
  process.exit(0);
}

const url = options.url;
const mockup = options.mockup;
if (!url || !mockup) {
  printUsage();
  fail('\nMissing required arguments: --url and --mockup');
}

const mockupPath = path.resolve(mockup);
if (!fs.existsSync(mockupPath)) {
  fail(`Mockup not found: ${mockupPath}`);
}

const viewport = options.viewport || '1440x900';
const parts = viewport.split('x');
const width = Number(parts[0]);
const height = Number(parts[1]);
if (!Number.isFinite(width) || !Number.isFinite(height)) {
  fail(`Invalid --viewport value: ${options.viewport}`);
}

const outputDir = path.resolve(options.output || 'figma-pixel-runs/project/run-id/backstop');
const label = options.label || 'layout-compare';
const selector = options.selector || 'body';
const threshold = Number(options.threshold || '0.1');
const runTest = String(options['run-test'] || 'no').toLowerCase() === 'yes';

fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(path.join(outputDir, 'bitmaps_reference'), { recursive: true });
fs.mkdirSync(path.join(outputDir, 'bitmaps_test'), { recursive: true });
fs.mkdirSync(path.join(outputDir, 'html_report'), { recursive: true });
fs.mkdirSync(path.join(outputDir, 'ci_report'), { recursive: true });

const ext = path.extname(mockupPath) || '.png';
const referenceFileName = `layout-compare_${label}_0_${selector.replace(/[^a-z0-9_-]+/gi, '_')}_0_${width}x${height}${ext}`;
const referenceTarget = path.join(outputDir, 'bitmaps_reference', referenceFileName);
fs.copyFileSync(mockupPath, referenceTarget);

const config = {
  id: 'layout-compare',
  viewports: [{ label: `${width}x${height}`, width, height }],
  scenarios: [
    {
      label,
      url,
      selectors: [selector],
      misMatchThreshold: threshold,
      requireSameDimensions: false,
      delay: 300,
    },
  ],
  paths: {
    bitmaps_reference: path.join(outputDir, 'bitmaps_reference'),
    bitmaps_test: path.join(outputDir, 'bitmaps_test'),
    engine_scripts: 'node_modules/backstopjs/core/engine_scripts',
    html_report: path.join(outputDir, 'html_report'),
    ci_report: path.join(outputDir, 'ci_report'),
  },
  report: ['browser', 'CI'],
  engine: 'playwright',
  engineOptions: {
    browser: 'chromium',
  },
  asyncCaptureLimit: 1,
  asyncCompareLimit: 10,
  debug: false,
  debugWindow: false,
};

const configPath = path.join(outputDir, 'backstop.config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

const summary = {
  prepared: true,
  configPath,
  referenceImage: referenceTarget,
  runTest,
};

if (!runTest) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const globalBackstop = spawnSync('which', ['backstop'], {
  stdio: 'pipe',
  encoding: 'utf8',
  shell: false,
});
const globalBackstopPath = globalBackstop.status === 0 ? globalBackstop.stdout.trim() : '';
const localBackstopPath = path.resolve(__dirname, '../node_modules/.bin/backstop');

const candidateBins = [
  localBackstopPath,
  path.resolve(process.cwd(), 'node_modules/.bin/backstop'),
  globalBackstopPath,
].filter(Boolean);

const backstopBin = candidateBins.find((binPath) => fs.existsSync(binPath));

if (!backstopBin) {
  const missingSummary = {
    ...summary,
    exitCode: 1,
    stdout: '',
    stderr: `Backstop CLI not found. Checked: ${candidateBins.join(', ')}`,
    htmlReport: null,
    ciReport: null,
    jsonReport: null,
  };
  fs.writeFileSync(path.join(outputDir, 'backstop-run-summary.json'), JSON.stringify(missingSummary, null, 2));
  console.log(JSON.stringify(missingSummary, null, 2));
  process.exit(1);
}

const result = spawnSync(backstopBin, ['test', `--config=${configPath}`], {
  stdio: 'pipe',
  encoding: 'utf8',
  shell: false,
});

const reportPath = path.join(outputDir, 'ci_report', 'xunit.xml');
const jsonReportPath = path.join(outputDir, 'ci_report', 'config.js.report.json');
const browserReportPath = path.join(outputDir, 'html_report', 'index.html');

const finalSummary = {
  ...summary,
  exitCode: result.status,
  stdout: result.stdout,
  stderr: result.stderr,
  htmlReport: fs.existsSync(browserReportPath) ? browserReportPath : null,
  ciReport: fs.existsSync(reportPath) ? reportPath : null,
  jsonReport: fs.existsSync(jsonReportPath) ? jsonReportPath : null,
};

fs.writeFileSync(path.join(outputDir, 'backstop-run-summary.json'), JSON.stringify(finalSummary, null, 2));
console.log(JSON.stringify(finalSummary, null, 2));
process.exit(result.status || 1);
