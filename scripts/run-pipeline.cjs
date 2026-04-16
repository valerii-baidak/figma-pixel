#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createRunManifest } = require('../lib/run-manifest.cjs');
const { generateLayoutReport } = require('../lib/layout-report.cjs');
const { renderPage: renderPageCapture } = require('../lib/page-render.cjs');
const { runPixelmatch: runPixelmatchDiff } = require('../lib/pixelmatch.cjs');
const { analyzeDiff } = require('../lib/opencv-diff.cjs');
const { compareTiles } = require('../lib/tile-compare.cjs');
const { prepareFigmaState, prepareCompareOnlyState, writeJson } = require('../lib/figma-cache.cjs');
const { extractDesignTokensFromFile } = require('../lib/design-tokens.cjs');
const { extractFromFile: extractImplementationData } = require('../lib/implementation-extractor.cjs');

function initRun(projectSlug, runId) {
  const manifest = createRunManifest(projectSlug, runId || '', path.resolve(process.cwd(), 'figma-pixel-runs'));
  if (!manifest?.runDir || !manifest?.subdirs) {
    console.error('Failed to initialize run directory');
    process.exit(1);
  }
  return manifest;
}


async function renderPage(pageUrl, screenshotPath, viewport, captureDir) {
  const renderJson = await renderPageCapture(pageUrl, screenshotPath, viewport.width, viewport.height);
  writeJson(path.join(captureDir, 'render-result.json'), renderJson);
  return renderJson;
}

function runPixelmatch(referenceImage, screenshotPath, pixelmatchDir) {
  const diffPath = path.join(pixelmatchDir, 'diff.png');
  const report = runPixelmatchDiff(referenceImage, screenshotPath, diffPath);
  const reportPath = path.join(pixelmatchDir, 'report.json');
  writeJson(reportPath, report);
  return { diffPath, reportPath, report };
}

async function runOpenCvAnalysis(referenceImage, screenshotPath, diffPath, pixelmatchDir, figmaNodePath) {
  const reportPath = path.join(pixelmatchDir, 'opencv-report.json');
  try {
    const report = await analyzeDiff(referenceImage, screenshotPath, diffPath, reportPath, figmaNodePath);
    if (!fs.existsSync(reportPath) && report) writeJson(reportPath, report);
    return { reportPath, report };
  } catch (error) {
    const report = {
      ok: false,
      error: error?.message || 'Node diff region analysis failed',
      reportPath,
    };
    if (!fs.existsSync(reportPath)) writeJson(reportPath, report);
    return { reportPath, report };
  }
}

function buildTopMismatches({ hasReferenceImage, viewport, renderJson, exportJson, pixelmatchReport, opencvReport, tileCompare }) {
  const top = [];
  if (!hasReferenceImage) top.push('reference image missing: figma/reference-image.png');
  if (exportJson && exportJson.ok === false) top.push('figma image export failed');
  if (viewport.fallbackUsed) top.push('viewport fallback used: no usable Figma node bounds');
  if (renderJson.failedRequests?.length) top.push(`failed requests: ${renderJson.failedRequests.length}`);
  if (renderJson.badResponses?.length) top.push(`bad responses: ${renderJson.badResponses.length}`);
  if (tileCompare?.topMismatchTiles?.length) {
    for (const t of tileCompare.topMismatchTiles.slice(0, 3)) {
      top.push(`tile y=${t.y}–${t.y + t.height}px: ${t.diffPercent}% mismatch`);
    }
  }
  if (opencvReport?.ok && Array.isArray(opencvReport.summary)) {
    top.push(...opencvReport.summary.slice(0, 5));
  }
  if (opencvReport?.ok && Array.isArray(opencvReport.largestRegions)) {
    for (const region of opencvReport.largestRegions.slice(0, 3)) {
      top.push(`region ${region.zone}: ${region.width}x${region.height}px, mean diff ${region.meanAbsDiff}`);
    }
  }
  if (pixelmatchReport?.diffPercent != null) top.push(`pixel mismatch: ${pixelmatchReport.diffPercent}%`);
  return top;
}

function runFinalReport(options) {
  return generateLayoutReport({
    output: options.outputDir,
    figma: options.figmaUrl,
    page: options.pageUrl,
    viewport: `${options.viewport.width}x${options.viewport.height}`,
    reference: options.referenceImage,
    screenshot: options.screenshotPath,
    diff: options.diffPath,
    pixelmatchReport: options.pixelmatchReportPath,
    opencvReport: options.opencvReportPath,
    top: options.top,
  });
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const compareOnly = flags.has('--compare-only');

const figmaUrl = positional[0];
const pageUrl = positional[1];
const projectSlug = positional[2] || 'project';
const runId = positional[3];

if (!figmaUrl || !pageUrl) {
  console.error('Usage: node scripts/run-pipeline.cjs <figma-url> <page-url> [project-slug] [run-id] [--compare-only]');
  process.exit(1);
}

async function main() {
  const manifest = initRun(projectSlug, runId);
  const figmaDir = manifest.subdirs.figma;
  const captureDir = manifest.subdirs.capture;
  const pixelmatchDir = manifest.subdirs.pixelmatch;
  const finalDir = manifest.subdirs.final;
  const sharedFigmaRoot = manifest.sharedDirs?.figma || path.join(manifest.projectDir, 'shared', 'figma');

  const figmaState = compareOnly
    ? await prepareCompareOnlyState(figmaUrl, figmaDir, sharedFigmaRoot)
    : await prepareFigmaState(figmaUrl, figmaDir, sharedFigmaRoot);
  const {
    parsedFigma,
    fetchedFigma,
    referenceImagePath,
    exportJson,
    exportAttempts,
    viewport,
    sharedPaths,
  } = figmaState;

  const hasReferenceImage = fs.existsSync(referenceImagePath);
  const screenshotPath = path.join(captureDir, 'captured-page.png');
  const renderJson = await renderPage(pageUrl, screenshotPath, viewport, captureDir);

  const figmaNodePath = path.join(figmaDir, 'figma-node.json');
  const designTokensPath = path.join(figmaDir, 'design-tokens.json');
  const implSpecPath = path.join(figmaDir, 'implementation-spec.json');

  if (fs.existsSync(figmaNodePath)) {
    // design tokens (legacy)
    if (!fs.existsSync(designTokensPath)) {
      try {
        const tokens = extractDesignTokensFromFile(figmaNodePath, parsedFigma.nodeId);
        writeJson(designTokensPath, tokens);
      } catch {}
    }
    // implementation spec (spec-first: full annotated tree for the build agent)
    if (!fs.existsSync(implSpecPath)) {
      try {
        const spec = extractImplementationData(figmaNodePath, parsedFigma.nodeId);
        writeJson(implSpecPath, spec);
      } catch {}
    }
  }

  let pixelmatch = { diffPath: '', reportPath: '', report: null };
  let opencv = { reportPath: '', report: null };
  let tileReport = null;
  if (hasReferenceImage) {
    pixelmatch = runPixelmatch(referenceImagePath, screenshotPath, pixelmatchDir);

    // Tile comparison: 300px horizontal bands → ranked mismatch zones
    try {
      tileReport = compareTiles(referenceImagePath, screenshotPath, { tileHeight: 300 });
      writeJson(path.join(pixelmatchDir, 'tile-report.json'), tileReport);
    } catch {}

    // OpenCV only for tiles that have mismatches
    if (tileReport?.topMismatchTiles?.length || !tileReport) {
      opencv = await runOpenCvAnalysis(referenceImagePath, screenshotPath, pixelmatch.diffPath, pixelmatchDir, figmaNodePath);
    }
  }

  const top = buildTopMismatches({
    hasReferenceImage,
    viewport,
    renderJson,
    exportJson,
    pixelmatchReport: pixelmatch.report,
    opencvReport: opencv.report,
    tileCompare: tileReport,
  });
  const final = runFinalReport({
    outputDir: finalDir,
    figmaUrl,
    pageUrl,
    viewport,
    referenceImage: hasReferenceImage ? referenceImagePath : '',
    screenshotPath,
    diffPath: pixelmatch.diffPath,
    pixelmatchReportPath: pixelmatch.reportPath,
    opencvReportPath: opencv.reportPath,
    top,
  });

  const runResult = {
    ok: true,
    runDir: manifest.runDir,
    manifestPath: path.join(manifest.runDir, 'run-manifest.json'),
    viewport,
    fallbackUsed: viewport.fallbackUsed,
    artifacts: {
      figmaNode: path.join(figmaDir, 'figma-node.json'),
      implementationSpec: fs.existsSync(implSpecPath) ? implSpecPath : null,
      designTokens: fs.existsSync(designTokensPath) ? designTokensPath : null,
      parsedFigmaUrl: path.join(figmaDir, 'parsed-figma-url.json'),
      viewport: path.join(figmaDir, 'viewport.json'),
      referenceImage: hasReferenceImage ? referenceImagePath : null,
      renderScreenshot: screenshotPath,
      renderReport: path.join(captureDir, 'render-result.json'),
      pixelmatchReport: pixelmatch.reportPath || null,
      pixelmatchDiff: pixelmatch.diffPath || null,
      tileReport: tileReport ? path.join(pixelmatchDir, 'tile-report.json') : null,
      opencvReport: opencv.reportPath || null,
      annotatedDiff: opencv.report?.annotatedDiff || null,
      finalReport: path.join(finalDir, 'report.json'),
      finalSummary: path.join(finalDir, 'summary.md'),
    },
    parsedFigma,
    fetchedFigma,
    exportImage: exportJson,
    exportAttempts,
    sharedFigmaCache: {
      root: sharedFigmaRoot,
      key: sharedPaths.key,
      cacheDir: sharedPaths.cacheDir,
    },
    render: renderJson,
    pixelmatch: pixelmatch.report,
    tileCompare: tileReport,
    opencv,
    final,
  };

  writeJson(path.join(manifest.runDir, 'run-result.json'), runResult);
  console.log(JSON.stringify(runResult, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
