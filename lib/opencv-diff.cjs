const fs = require('fs');
const path = require('path');

function requireModule(name, installCommand) {
  try {
    return require(name);
  } catch {
    throw new Error([
      `Missing dependency: ${name}`,
      'Install the required runtime in the host environment:',
      installCommand,
    ].join('\n'));
  }
}

function ensureImageData() {
  if (typeof global.ImageData === 'undefined') {
    global.ImageData = class ImageDataPolyfill {
      constructor(data, width, height) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    };
  }
}

function readPng(PNG, filePath) {
  return PNG.sync.read(fs.readFileSync(filePath));
}

function cropTo(PNG, img, width, height) {
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

function buildBinaryMaskMatFromDiff(cv, referencePng, screenshotPng, threshold = 24) {
  const referenceMat = pngToMat(cv, referencePng);
  const screenshotMat = pngToMat(cv, screenshotPng);
  const diffMat = new cv.Mat();
  const gray = new cv.Mat();
  const mask = new cv.Mat();

  cv.absdiff(referenceMat, screenshotMat, diffMat);
  cv.cvtColor(diffMat, gray, cv.COLOR_RGBA2GRAY, 0);
  cv.threshold(gray, mask, threshold, 255, cv.THRESH_BINARY);

  referenceMat.delete();
  screenshotMat.delete();
  diffMat.delete();
  gray.delete();

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

function setPixel(png, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (y * png.width + x) << 2;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = 255;
}

function drawRect(png, x, y, w, h, r, g, b) {
  const lw = 2;
  for (let i = 0; i < lw; i++) {
    for (let px = x; px < x + w; px++) {
      setPixel(png, px, y + i, r, g, b);
      setPixel(png, px, y + h - 1 - i, r, g, b);
    }
    for (let py = y; py < y + h; py++) {
      setPixel(png, x + i, py, r, g, b);
      setPixel(png, x + w - 1 - i, py, r, g, b);
    }
  }
}

function saveAnnotatedDiff(PNG, diffPng, regions, annotatedPath) {
  const out = new PNG({ width: diffPng.width, height: diffPng.height });
  diffPng.data.copy(out.data);
  for (const region of regions) {
    drawRect(out, region.x, region.y, region.width, region.height, 0, 255, 0);
  }
  const buf = PNG.sync.write(out);
  fs.writeFileSync(annotatedPath, buf);
  return annotatedPath;
}

function flattenFigmaNodes(figmaNodeJson, rootNodeId) {
  const nodes = [];
  const rootDoc = figmaNodeJson?.nodes?.[rootNodeId]?.document;
  if (!rootDoc) return nodes;

  const rootBounds = rootDoc.absoluteBoundingBox || rootDoc.absoluteRenderBounds;
  const offsetX = rootBounds?.x || 0;
  const offsetY = rootBounds?.y || 0;

  function traverse(node) {
    if (node.visible === false) return;
    const bounds = node.absoluteBoundingBox || node.absoluteRenderBounds;
    if (bounds) {
      nodes.push({
        id: node.id,
        name: node.name,
        type: node.type,
        x: Math.round(bounds.x - offsetX),
        y: Math.round(bounds.y - offsetY),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) traverse(child);
    }
  }
  traverse(rootDoc);
  return nodes;
}

function mapRegionsToFigmaLayers(regions, figmaNodes) {
  if (!figmaNodes || !figmaNodes.length) return regions;
  return regions.map((region) => {
    const overlapping = figmaNodes.filter((node) => (
      region.x < node.x + node.width &&
      region.x + region.width > node.x &&
      region.y < node.y + node.height &&
      region.y + region.height > node.y
    ));
    // prefer leaf-level nodes (no children in the flat list means nothing else is inside)
    const best = overlapping.slice(0, 5).map((n) => ({ id: n.id, name: n.name, type: n.type }));
    return { ...region, figmaLayers: best };
  });
}

async function analyzeDiff(referencePath, screenshotPath, diffPath, outputReportPath, figmaNodePath) {
  if (!referencePath || !screenshotPath || !diffPath || !outputReportPath) {
    throw new Error('Usage: node scripts/opencv-analyze-diff.cjs <reference> <screenshot> <diff> <output-report>');
  }

  for (const filePath of [referencePath, screenshotPath, diffPath]) {
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: `Missing input file: ${filePath}`, reportPath: outputReportPath };
    }
  }

  const { PNG } = requireModule('pngjs', 'npm install pngjs');
  const cvModule = requireModule('@techstark/opencv-js', 'npm install @techstark/opencv-js');
  ensureImageData();
  const cv = await cvModule;

  const referenceRaw = readPng(PNG, referencePath);
  const screenshotRaw = readPng(PNG, screenshotPath);
  const diffRaw = readPng(PNG, diffPath);
  const width = Math.min(referenceRaw.width, screenshotRaw.width, diffRaw.width);
  const height = Math.min(referenceRaw.height, screenshotRaw.height, diffRaw.height);
  const reference = cropTo(PNG, referenceRaw, width, height);
  const screenshot = cropTo(PNG, screenshotRaw, width, height);
  const diff = cropTo(PNG, diffRaw, width, height);
  const imageArea = width * height;

  let figmaNodeJson = null;
  let figmaNodes = [];
  if (figmaNodePath && fs.existsSync(figmaNodePath)) {
    try {
      figmaNodeJson = JSON.parse(fs.readFileSync(figmaNodePath, 'utf8'));
      const rootNodeId = Object.keys(figmaNodeJson?.nodes || {})[0];
      if (rootNodeId) figmaNodes = flattenFigmaNodes(figmaNodeJson, rootNodeId);
    } catch {}
  }

  const thresh = buildBinaryMaskMatFromDiff(cv, reference, screenshot, 24);
  const morph = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.morphologyEx(thresh, morph, cv.MORPH_OPEN, kernel);
    cv.morphologyEx(morph, morph, cv.MORPH_CLOSE, kernel);
    cv.findContours(morph, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const rawRegions = [];
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      const rect = cv.boundingRect(contour);
      contour.delete();

      const area = rect.width * rect.height;
      if (area < Math.max(64, Math.floor(imageArea * 0.0005))) continue;

      rawRegions.push({
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

    rawRegions.sort((a, b) => (b.area - a.area) || (b.meanAbsDiff - a.meanAbsDiff));
    const largestRegions = mapRegionsToFigmaLayers(rawRegions.slice(0, 12), figmaNodes);
    const summary = largestRegions.slice(0, 5).map((region) => {
      const layers = region.figmaLayers?.length
        ? ` → ${region.figmaLayers.slice(0, 2).map((l) => l.name).join(', ')}`
        : '';
      return `difference block at ${region.zone} (${region.width}x${region.height} px, ${region.coveragePercent}% of page)${layers}`;
    });

    const annotatedDiffPath = outputReportPath.replace(/\.json$/, '-annotated.png');
    saveAnnotatedDiff(PNG, diff, largestRegions, annotatedDiffPath);

    const report = {
      ok: true,
      engine: 'opencv-js',
      referenceImage: referencePath,
      screenshot: screenshotPath,
      diffImage: diffPath,
      annotatedDiff: annotatedDiffPath,
      reportPath: outputReportPath,
      imageSize: { width, height },
      differenceRegionCount: rawRegions.length,
      largestRegions,
      summary,
    };

    fs.mkdirSync(path.dirname(outputReportPath), { recursive: true });
    fs.writeFileSync(outputReportPath, JSON.stringify(report, null, 2));
    return report;
  } finally {
    thresh.delete();
    morph.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }
}

module.exports = { analyzeDiff };
