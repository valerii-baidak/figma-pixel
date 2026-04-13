#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createRunManifest } = require('../lib/run-manifest.cjs');
const { parseFigmaUrl } = require('../lib/parse-figma-url.cjs');
const { generateLayoutReport } = require('../lib/layout-report.cjs');
const { fetchFigmaApi } = require('../lib/figma-api.cjs');
const { exportFigmaImage } = require('../lib/figma-export.cjs');
const { renderPage: renderPageCapture } = require('../lib/page-render.cjs');
const { runPixelmatch: runPixelmatchDiff } = require('../lib/pixelmatch.cjs');
const { analyzeDiff } = require('../lib/opencv-diff.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function copyFileIfExists(fromPath, toPath) {
  if (!fromPath || !toPath || !fs.existsSync(fromPath)) return false;
  fs.mkdirSync(path.dirname(toPath), { recursive: true });
  fs.copyFileSync(fromPath, toPath);
  return true;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getNodeDocument(figmaNodeJson, nodeId) {
  if (!figmaNodeJson?.nodes || !nodeId) return null;
  return figmaNodeJson.nodes[nodeId]?.document || null;
}

function deriveViewportFromFigma(figmaNodeJson, nodeId) {
  const node = getNodeDocument(figmaNodeJson, nodeId);
  const directBounds = node?.absoluteBoundingBox || node?.absoluteRenderBounds || null;
  const childBounds = (!directBounds && Array.isArray(node?.children) && node.children.length === 1)
    ? (node.children[0]?.absoluteBoundingBox || node.children[0]?.absoluteRenderBounds || null)
    : null;
  const bounds = directBounds || childBounds || null;
  const width = Math.round(bounds?.width || 0);
  const height = Math.round(bounds?.height || 0);

  if (width > 0 && height > 0) {
    return { width, height, source: childBounds ? 'figma-child-frame' : 'figma-node', fallbackUsed: false };
  }

  return { width: 1600, height: 900, source: 'fallback', fallbackUsed: true };
}

function resolveExportNodeId(figmaNodeJson, nodeId) {
  const node = getNodeDocument(figmaNodeJson, nodeId);
  if (!node) return nodeId;
  if (node.type === 'CANVAS' && Array.isArray(node.children) && node.children.length === 1) {
    return node.children[0]?.id || nodeId;
  }
  return nodeId;
}

function initRun(projectSlug, runId) {
  const manifest = createRunManifest(projectSlug, runId || '', path.resolve(process.cwd(), 'figma-pixel-runs'));
  if (!manifest?.runDir || !manifest?.subdirs) {
    console.error('Failed to initialize run directory');
    process.exit(1);
  }
  return manifest;
}

function parseFigma(figmaUrl, figmaDir) {
  const parsed = parseFigmaUrl(figmaUrl);
  writeJson(path.join(figmaDir, 'parsed-figma-url.json'), parsed);
  return parsed;
}

async function fetchFigma(figmaUrl, figmaDir) {
  const fetched = await fetchFigmaApi(figmaUrl, figmaDir);
  writeJson(path.join(figmaDir, 'fetch-result.json'), fetched);
  return fetched;
}

function buildSharedFigmaKey(parsedFigma) {
  return [parsedFigma?.fileKey || 'file', parsedFigma?.nodeId || 'root']
    .map((part) => String(part).replace(/[^a-zA-Z0-9:_-]+/g, '-').replace(/:/g, '__'))
    .join('--');
}

function getSharedFigmaPaths(sharedFigmaRoot, parsedFigma) {
  const key = buildSharedFigmaKey(parsedFigma);
  const cacheDir = path.join(sharedFigmaRoot, key);
  return {
    key,
    cacheDir,
    parsedFigmaUrl: path.join(cacheDir, 'parsed-figma-url.json'),
    fetchResult: path.join(cacheDir, 'fetch-result.json'),
    figmaFile: path.join(cacheDir, 'figma-file.json'),
    figmaNode: path.join(cacheDir, 'figma-node.json'),
    exportImageResult: path.join(cacheDir, 'export-image-result.json'),
    exportImageAttempts: path.join(cacheDir, 'export-image-attempts.json'),
    referenceImage: path.join(cacheDir, 'reference-image.png'),
    viewport: path.join(cacheDir, 'viewport.json'),
  };
}

function primeRunFigmaDirFromShared(sharedPaths, figmaDir) {
  copyFileIfExists(sharedPaths.parsedFigmaUrl, path.join(figmaDir, 'parsed-figma-url.json'));
  copyFileIfExists(sharedPaths.fetchResult, path.join(figmaDir, 'fetch-result.json'));
  copyFileIfExists(sharedPaths.figmaFile, path.join(figmaDir, 'figma-file.json'));
  copyFileIfExists(sharedPaths.figmaNode, path.join(figmaDir, 'figma-node.json'));
  copyFileIfExists(sharedPaths.exportImageResult, path.join(figmaDir, 'export-image-result.json'));
  copyFileIfExists(sharedPaths.exportImageAttempts, path.join(figmaDir, 'export-image-attempts.json'));
  copyFileIfExists(sharedPaths.referenceImage, path.join(figmaDir, 'reference-image.png'));
  copyFileIfExists(sharedPaths.viewport, path.join(figmaDir, 'viewport.json'));
}

function persistRunFigmaDirToShared(figmaDir, sharedPaths) {
  fs.mkdirSync(sharedPaths.cacheDir, { recursive: true });
  copyFileIfExists(path.join(figmaDir, 'parsed-figma-url.json'), sharedPaths.parsedFigmaUrl);
  copyFileIfExists(path.join(figmaDir, 'fetch-result.json'), sharedPaths.fetchResult);
  copyFileIfExists(path.join(figmaDir, 'figma-file.json'), sharedPaths.figmaFile);
  copyFileIfExists(path.join(figmaDir, 'figma-node.json'), sharedPaths.figmaNode);
  copyFileIfExists(path.join(figmaDir, 'export-image-result.json'), sharedPaths.exportImageResult);
  copyFileIfExists(path.join(figmaDir, 'export-image-attempts.json'), sharedPaths.exportImageAttempts);
  copyFileIfExists(path.join(figmaDir, 'reference-image.png'), sharedPaths.referenceImage);
  copyFileIfExists(path.join(figmaDir, 'viewport.json'), sharedPaths.viewport);
}

async function tryExportFigmaImage(fileKey, nodeId, outputPath, nodeJson) {
  if (!fileKey || !nodeId) return null;
  try {
    return await exportFigmaImage(fileKey, nodeId, outputPath, nodeJson);
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      stderr: error?.message || 'Figma image export failed',
      imagePath: outputPath,
    };
  }
}

async function exportFigmaImageRobust(fileKey, requestedNodeId, outputPath, figmaNodeJson) {
  const attempts = [];

  const first = await tryExportFigmaImage(fileKey, requestedNodeId, outputPath, figmaNodeJson);
  if (first) attempts.push(first);
  if (first?.ok) {
    return { result: first, attempts };
  }

  const resolvedNodeId = resolveExportNodeId(figmaNodeJson, requestedNodeId);
  if (resolvedNodeId && resolvedNodeId !== requestedNodeId) {
    const second = await tryExportFigmaImage(fileKey, resolvedNodeId, outputPath, figmaNodeJson);
    if (second) attempts.push(second);
    if (second?.ok) {
      return { result: second, attempts };
    }
  }

  return { result: attempts[attempts.length - 1] || null, attempts };
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
    const report = readJsonIfExists(reportPath) || {
      ok: false,
      error: error?.message || 'Node diff region analysis failed',
      reportPath,
    };
    if (!fs.existsSync(reportPath) && report) writeJson(reportPath, report);
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

  const parsedFigma = parseFigma(figmaUrl, figmaDir);
  const sharedPaths = getSharedFigmaPaths(sharedFigmaRoot, parsedFigma);
  primeRunFigmaDirFromShared(sharedPaths, figmaDir);

  let fetchedFigma = readJsonIfExists(path.join(figmaDir, 'fetch-result.json'));
  if (!fetchedFigma?.ok) {
    fetchedFigma = await fetchFigma(figmaUrl, figmaDir);
  }

  const figmaNodePath = path.join(figmaDir, 'figma-node.json');
  const figmaNodeJson = readJsonIfExists(figmaNodePath);
  const referenceImagePath = path.join(figmaDir, 'reference-image.png');
  let exportJson = readJsonIfExists(path.join(figmaDir, 'export-image-result.json'));
  let exportAttempts = readJsonIfExists(path.join(figmaDir, 'export-image-attempts.json')) || [];

  if (!fs.existsSync(referenceImagePath) || !exportJson?.ok) {
    const exportState = await exportFigmaImageRobust(fetchedFigma.fileKey, fetchedFigma.nodeId, referenceImagePath, figmaNodeJson);
    exportJson = exportState.result;
    exportAttempts = exportState.attempts || [];
    writeJson(path.join(figmaDir, 'export-image-result.json'), exportJson || {});
    writeJson(path.join(figmaDir, 'export-image-attempts.json'), exportAttempts);
  }

  let viewport = readJsonIfExists(path.join(figmaDir, 'viewport.json'));
  if (!viewport?.width || !viewport?.height) {
    viewport = deriveViewportFromFigma(figmaNodeJson, parsedFigma.nodeId);
    writeJson(path.join(figmaDir, 'viewport.json'), viewport);
  }

  persistRunFigmaDirToShared(figmaDir, sharedPaths);

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
