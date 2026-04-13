#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createRunManifest } = require('../lib/run-manifest.cjs');
const { generateLayoutReport } = require('../lib/layout-report.cjs');
const { renderPage: renderPageCapture } = require('../lib/page-render.cjs');
const { runPixelmatch: runPixelmatchDiff } = require('../lib/pixelmatch.cjs');
const { analyzeDiff } = require('../lib/opencv-diff.cjs');
const { prepareFigmaState, writeJson } = require('../lib/figma-cache.cjs');

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

async function runOpenCvAnalysis(referenceImage, screenshotPath, diffPath, pixelmatchDir) {
  const reportPath = path.join(pixelmatchDir, 'opencv-report.json');
  try {
    const report = await analyzeDiff(referenceImage, screenshotPath, diffPath, reportPath);
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

function buildTopMismatches({ hasReferenceImage, viewport, renderJson, exportJson, pixelmatchReport, opencvReport }) {
  const top = [];
  if (!hasReferenceImage) top.push('reference image missing: figma/reference-image.png');
  if (exportJson && exportJson.ok === false) top.push('figma image export failed');
  if (viewport.fallbackUsed) top.push('viewport fallback used: no usable Figma node bounds');
  if (renderJson.failedRequests?.length) top.push(`failed requests: ${renderJson.failedRequests.length}`);
  if (renderJson.badResponses?.length) top.push(`bad responses: ${renderJson.badResponses.length}`);
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

const figmaUrl = process.argv[2];
const pageUrl = process.argv[3];
const projectSlug = process.argv[4] || 'project';
const runId = process.argv[5];

if (!figmaUrl || !pageUrl) {
  console.error('Usage: node scripts/run-pipeline.cjs <figma-url> <page-url> [project-slug] [run-id]');
  process.exit(1);
}

async function main() {
  const manifest = initRun(projectSlug, runId);
  const figmaDir = manifest.subdirs.figma;
  const captureDir = manifest.subdirs.capture;
  const pixelmatchDir = manifest.subdirs.pixelmatch;
  const finalDir = manifest.subdirs.final;
  const sharedFigmaRoot = manifest.sharedDirs?.figma || path.join(manifest.projectDir, 'shared', 'figma');

  const figmaState = await prepareFigmaState(figmaUrl, figmaDir, sharedFigmaRoot);
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

  let pixelmatch = { diffPath: '', reportPath: '', report: null };
  let opencv = { reportPath: '', report: null };
  if (hasReferenceImage) {
    pixelmatch = runPixelmatch(referenceImagePath, screenshotPath, pixelmatchDir);
    opencv = await runOpenCvAnalysis(referenceImagePath, screenshotPath, pixelmatch.diffPath, pixelmatchDir);
  }

  const top = buildTopMismatches({
    hasReferenceImage,
    viewport,
    renderJson,
    exportJson,
    pixelmatchReport: pixelmatch.report,
    opencvReport: opencv.report,
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
      figmaFile: path.join(figmaDir, 'figma-file.json'),
      figmaNode: path.join(figmaDir, 'figma-node.json'),
      parsedFigmaUrl: path.join(figmaDir, 'parsed-figma-url.json'),
      viewport: path.join(figmaDir, 'viewport.json'),
      referenceImage: hasReferenceImage ? referenceImagePath : null,
      renderScreenshot: screenshotPath,
      renderReport: path.join(captureDir, 'render-result.json'),
      pixelmatchReport: pixelmatch.reportPath || null,
      pixelmatchDiff: pixelmatch.diffPath || null,
      opencvReport: opencv.reportPath || null,
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
    opencv,
    final,
  };

  writeJson(path.join(manifest.runDir, 'run-result.json'), runResult);
  writeJson(path.join(manifest.runDir, 'pipeline-summary.json'), runResult);
  console.log(JSON.stringify(runResult, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
