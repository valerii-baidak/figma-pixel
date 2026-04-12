#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function ensureSetup() {
  const localPngjs = path.resolve(__dirname, '../node_modules/pngjs');
  const localPixelmatch = path.resolve(__dirname, '../node_modules/pixelmatch');
  if (fs.existsSync(localPngjs) && fs.existsSync(localPixelmatch)) return;

  const setupScript = path.resolve(__dirname, 'setup.cjs');
  const result = spawnSync(process.execPath, [setupScript], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    console.error('Automatic setup failed for pixelmatch-runner.cjs');
    console.error('See ../setup-report.json for details.');
    process.exit(result.status || 1);
  }
}

ensureSetup();

function loadModule(name, fallbacks = []) {
  const candidates = [name, ...fallbacks].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {}
  }
  throw new Error(`Module not found: ${candidates.join(', ')}`);
}

const pngjsOverride = process.env.PNGJS_MODULE_PATH;
const pixelmatchOverride = process.env.PIXELMATCH_MODULE_PATH;
const { PNG } = loadModule('pngjs', [pngjsOverride]);
const pm = loadModule('pixelmatch', [pixelmatchOverride]);
const pixelmatch = pm.default || pm;

const [img1Path, img2Path, diffPath] = process.argv.slice(2);
if (!img1Path || !img2Path || !diffPath) {
  console.error('Usage: node scripts/pixelmatch-runner.cjs <img1> <img2> <diffPath>');
  process.exit(1);
}

const img1 = PNG.sync.read(fs.readFileSync(img1Path));
const img2 = PNG.sync.read(fs.readFileSync(img2Path));
const width = Math.min(img1.width, img2.width);
const height = Math.min(img1.height, img2.height);

const crop = (img) => {
  if (img.width === width && img.height === height) return img;
  const out = new PNG({ width, height });
  PNG.bitblt(img, out, 0, 0, width, height, 0, 0);
  return out;
};

const a = crop(img1);
const b = crop(img2);
const diff = new PNG({ width, height });
const diffPixels = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.1 });
fs.writeFileSync(diffPath, PNG.sync.write(diff));
console.log(JSON.stringify({
  width,
  height,
  diffPixels,
  diffPercent: +(diffPixels / (width * height) * 100).toFixed(2),
  diffPath
}, null, 2));
