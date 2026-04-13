#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const cvModule = require('@techstark/opencv-js');

if (typeof global.ImageData === 'undefined') {
  global.ImageData = class ImageDataPolyfill {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

function emit(payload, code = 0) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
}

function readPng(filePath) {
  return PNG.sync.read(fs.readFileSync(filePath));
}

function cropTo(img, width, height) {
  if (img.width === width && img.height === height) return img;
  const out = new PNG({ width, height });
  PNG.bitblt(img, out, 0, 0, width, height, 0, 0);
  return out;
}

function pngToMat(cv, png) {
  if (typeof cv.matFromImageData === 'function') {
    return cv.matFromImageData(new ImageData(Uint8ClampedArray.from(png.data), png.width, png.height));
  }

  if (typeof cv.matFromArray === 'function') {
    return cv.matFromArray(png.height, png.width, cv.CV_8UC4, Array.from(png.data));
  }

  const mat = new cv.Mat(png.height, png.width, cv.CV_8UC4);
  mat.data.set(Uint8Array.from(png.data));
  return mat;
}

function classifyZone(x, y, width, height) {
  const vertical = y < height * 0.25 ? 'top' : y > height * 0.75 ? 'bottom' : 'middle';
  const horizontal = x < width * 0.33 ? 'left' : x > width * 0.66 ? 'right' : 'center';
  return `${vertical}-${horizontal}`;
}

function buildBinaryMaskMat(cv, png, threshold = 24) {
  const mask = new cv.Mat.zeros(png.height, png.width, cv.CV_8UC1);
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const idx = (y * png.width + x) << 2;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const a = png.data[idx + 3];
      const value = a > 0 && (r + g + b) > threshold ? 255 : 0;
      mask.ucharPtr(y, x)[0] = value;
    }
  }
  return mask;
}

function getMeanAbsDiff(reference, screenshot, rect) {
  let total = 0;
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const idx = (y * reference.width + x) << 2;
      total += Math.abs(reference.data[idx] - screenshot.data[idx]);
      total += Math.abs(reference.data[idx + 1] - screenshot.data[idx + 1]);
      total += Math.abs(reference.data[idx + 2] - screenshot.data[idx + 2]);
      count += 3;
    }
  }
  return +(total / Math.max(1, count)).toFixed(2);
}

async function main() {
  const [referencePath, screenshotPath, diffPath, outputReportPath] = process.argv.slice(2);
  if (!referencePath || !screenshotPath || !diffPath || !outputReportPath) {
    emit({ ok: false, error: 'Usage: node scripts/opencv-analyze-diff.cjs <reference> <screenshot> <diff> <output-report>' }, 1);
  }

  for (const filePath of [referencePath, screenshotPath, diffPath]) {
    if (!fs.existsSync(filePath)) {
      emit({ ok: false, error: `Missing input file: ${filePath}`, reportPath: outputReportPath }, 0);
    }
  }

  const cv = await cvModule;

  const referenceRaw = readPng(referencePath);
  const screenshotRaw = readPng(screenshotPath);
  const diffRaw = readPng(diffPath);
  const width = Math.min(referenceRaw.width, screenshotRaw.width, diffRaw.width);
  const height = Math.min(referenceRaw.height, screenshotRaw.height, diffRaw.height);
  const reference = cropTo(referenceRaw, width, height);
  const screenshot = cropTo(screenshotRaw, width, height);
  const diff = cropTo(diffRaw, width, height);
  const imageArea = width * height;

  const thresh = buildBinaryMaskMat(cv, diff, 24);
  const morph = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.morphologyEx(thresh, morph, cv.MORPH_OPEN, kernel);
    cv.morphologyEx(morph, morph, cv.MORPH_CLOSE, kernel);
    cv.findContours(morph, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const regions = [];
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      const rect = cv.boundingRect(contour);
      contour.delete();

      const area = rect.width * rect.height;
      if (area < Math.max(64, Math.floor(imageArea * 0.0005))) continue;

      regions.push({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        area,
        coveragePercent: +((area / imageArea) * 100).toFixed(2),
        meanAbsDiff: getMeanAbsDiff(reference, screenshot, rect),
        zone: classifyZone(rect.x + rect.width / 2, rect.y + rect.height / 2, width, height),
      });
    }

    regions.sort((a, b) => (b.area - a.area) || (b.meanAbsDiff - a.meanAbsDiff));
    const largestRegions = regions.slice(0, 12);
    const summary = largestRegions.slice(0, 5).map((region) => (
      `difference block at ${region.zone} (${region.width}x${region.height} px, ${region.coveragePercent}% of page)`
    ));

    const report = {
      ok: true,
      engine: 'opencv-js',
      referenceImage: referencePath,
      screenshot: screenshotPath,
      diffImage: diffPath,
      reportPath: outputReportPath,
      imageSize: { width, height },
      differenceRegionCount: regions.length,
      largestRegions,
      summary,
    };

    fs.mkdirSync(path.dirname(outputReportPath), { recursive: true });
    fs.writeFileSync(outputReportPath, JSON.stringify(report, null, 2));
    emit(report, 0);
  } finally {
    thresh.delete();
    morph.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }
}

main().catch((error) => {
  emit({ ok: false, error: error?.message || String(error) }, 0);
});
