#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function ensureRuntimePresent() {
  const required = ['pngjs', 'pixelmatch'];
  const missing = [];

  for (const name of required) {
    try {
      require.resolve(name);
    } catch {
      missing.push(name);
    }
  }

  if (!missing.length) return;

  console.error([
    `Missing dependencies: ${missing.join(', ')}`,
    'Install them in the host environment:',
    'npm install pixelmatch pngjs',
  ].join('\n'));
  process.exit(1);
}

ensureRuntimePresent();

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
