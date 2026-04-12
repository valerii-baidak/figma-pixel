#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function runNode(scriptPath, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
    shell: false,
  });
}

function parseJson(stdout, fallback = null) {
  try {
    return JSON.parse(String(stdout || '').trim());
  } catch {
    return fallback;
  }
}

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

function syncDirFiles(sourceDir, targetDir) {
  if (!sourceDir || !targetDir || !fs.existsSync(sourceDir)) return [];
  fs.mkdirSync(targetDir, { recursive: true });
  const copied = [];
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const fromPath = path.join(sourceDir, entry.name);
    const toPath = path.join(targetDir, entry.name);
    fs.copyFileSync(fromPath, toPath);
    copied.push(toPath);
  }
  return copied;
}

function failWith(result) {
  console.error(result.stderr || result.stdout || 'Command failed');
  process.exit(result.status || 1);
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

function initRun(initScript, projectSlug, runId) {
  const result = runNode(initScript, [projectSlug, runId || '']);
  if (result.status !== 0) failWith(result);
  const manifest = parseJson(result.stdout);
  if (!manifest?.runDir || !manifest?.subdirs) {
    console.error('Failed to initialize run directory');
    process.exit(1);
  }
  return manifest;
}

function parseFigma(parseScript, figmaUrl, figmaDir) {
  const result = runNode(parseScript, [figmaUrl]);
  const parsed = parseJson(result.stdout, {});
  writeJson(path.join(figmaDir, 'parsed-figma-url.json'), parsed);
  return parsed;
}

function fetchFigma(fetchScript, figmaUrl, figmaDir) {
  const result = runNode(fetchScript, [figmaUrl, figmaDir]);
  if (result.status !== 0) failWith(result);
  const fetched = parseJson(result.stdout, {});
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

function exportFigmaImage(exportScript, fileKey, nodeId, outputPath, nodeJsonPath) {
  if (!fileKey || !nodeId) return null;
  const args = [fileKey, nodeId, outputPath];
  if (nodeJsonPath) args.push(nodeJsonPath);
  const result = runNode(exportScript, args);
  if (result.status !== 0) {
    return parseJson(result.stdout, {
      ok: false,
      exitCode: result.status || 1,
      stderr: result.stderr || 'Figma image export failed',
      imagePath: outputPath,
    });
  }
  return parseJson(result.stdout, null);
}

function exportFigmaImageRobust(exportScript, fileKey, requestedNodeId, outputPath, figmaNodeJson, nodeJsonPath) {
  const attempts = [];

  const first = exportFigmaImage(exportScript, fileKey, requestedNodeId, outputPath, nodeJsonPath);
  if (first) attempts.push(first);
  if (first?.ok) {
    return { result: first, attempts };
  }

  const resolvedNodeId = resolveExportNodeId(figmaNodeJson, requestedNodeId);
  if (resolvedNodeId && resolvedNodeId !== requestedNodeId) {
    const second = exportFigmaImage(exportScript, fileKey, resolvedNodeId, outputPath, nodeJsonPath);
    if (second) attempts.push(second);
    if (second?.ok) {
      return { result: second, attempts };
    }
  }

  return { result: attempts[attempts.length - 1] || null, attempts };
}

function renderPage(renderScript, pageUrl, screenshotPath, viewport, captureDir) {
  const result = runNode(renderScript, [
    pageUrl,
    screenshotPath,
    String(viewport.width),
    String(viewport.height),
  ]);
  if (result.status !== 0) failWith(result);
  const renderJson = parseJson(result.stdout, {});
  writeJson(path.join(captureDir, 'render-result.json'), renderJson);
  return renderJson;
}

function runBackstop(backstopScript, pageUrl, referenceImage, viewport, projectSlug, outputDir) {
  const result = runNode(backstopScript, [
    '--url', pageUrl,
    '--mockup', referenceImage,
    '--viewport', `${viewport.width}x${viewport.height}`,
    '--label', projectSlug,
    '--output', outputDir,
    '--run-test', 'yes',
  ]);
  return parseJson(result.stdout, {
    exitCode: result.status || 1,
    stderr: result.stderr || '',
  });
}

function runPixelmatch(pixelmatchScript, referenceImage, screenshotPath, pixelmatchDir) {
  const diffPath = path.join(pixelmatchDir, 'diff.png');
  const result = runNode(pixelmatchScript, [referenceImage, screenshotPath, diffPath]);
  if (result.status !== 0) failWith(result);
  const report = parseJson(result.stdout, {});
  const reportPath = path.join(pixelmatchDir, 'report.json');
  writeJson(reportPath, report);
  return { diffPath, reportPath, report };
}

function buildTopMismatches({ hasReferenceImage, viewport, renderJson, backstopJson, exportJson }) {
  const top = [];
  if (!hasReferenceImage) top.push('reference image missing: figma/reference-image.png');
  if (exportJson && exportJson.ok === false) top.push('figma image export failed');
  if (viewport.fallbackUsed) top.push('viewport fallback used: no usable Figma node bounds');
  if (renderJson.failedRequests?.length) top.push(`failed requests: ${renderJson.failedRequests.length}`);
  if (renderJson.badResponses?.length) top.push(`bad responses: ${renderJson.badResponses.length}`);
  if (backstopJson?.exitCode && backstopJson.exitCode !== 0) top.push(`backstop exit: ${backstopJson.exitCode}`);
  return top;
}

function runFinalReport(reportScript, options) {
  const result = runNode(reportScript, [
    '--output', options.outputDir,
    '--figma', options.figmaUrl,
    '--page', options.pageUrl,
    '--viewport', `${options.viewport.width}x${options.viewport.height}`,
    '--reference', options.referenceImage,
    '--screenshot', options.screenshotPath,
    '--diff', options.diffPath,
    '--backstopSummary', options.backstopSummaryPath,
    '--pixelmatchReport', options.pixelmatchReportPath,
    '--top', options.top.join('|'),
  ]);
  if (result.status !== 0) failWith(result);
  return parseJson(result.stdout, {});
}

const figmaUrl = process.argv[2];
const pageUrl = process.argv[3];
const projectSlug = process.argv[4] || 'project';
const runId = process.argv[5];

if (!figmaUrl || !pageUrl) {
  console.error('Usage: node scripts/run-pipeline.cjs <figma-url> <page-url> [project-slug] [run-id]');
  process.exit(1);
}

const initScript = path.resolve(__dirname, 'init-run-dir.cjs');
const parseScript = path.resolve(__dirname, 'parse-figma-url.cjs');
const fetchScript = path.resolve(__dirname, 'fetch-figma-api.cjs');
const exportScript = path.resolve(__dirname, 'export-figma-image.cjs');
const renderScript = path.resolve(__dirname, 'render-page.cjs');
const backstopScript = path.resolve(__dirname, 'backstop-compare.cjs');
const pixelmatchScript = path.resolve(__dirname, 'pixelmatch-runner.cjs');
const reportScript = path.resolve(__dirname, 'generate-layout-report.cjs');

const manifest = initRun(initScript, projectSlug, runId);
const figmaDir = manifest.subdirs.figma;
const captureDir = manifest.subdirs.capture;
const backstopDir = manifest.subdirs.backstop;
const pixelmatchDir = manifest.subdirs.pixelmatch;
const finalDir = manifest.subdirs.final;
const sharedFigmaRoot = manifest.sharedDirs?.figma || path.join(manifest.projectDir, 'shared', 'figma');

const parsedFigma = parseFigma(parseScript, figmaUrl, figmaDir);
const sharedPaths = getSharedFigmaPaths(sharedFigmaRoot, parsedFigma);
primeRunFigmaDirFromShared(sharedPaths, figmaDir);

let fetchedFigma = readJsonIfExists(path.join(figmaDir, 'fetch-result.json'));
if (!fetchedFigma?.ok) {
  fetchedFigma = fetchFigma(fetchScript, figmaUrl, figmaDir);
}

const figmaNodePath = path.join(figmaDir, 'figma-node.json');
const figmaNodeJson = readJsonIfExists(figmaNodePath);
const referenceImagePath = path.join(figmaDir, 'reference-image.png');
let exportJson = readJsonIfExists(path.join(figmaDir, 'export-image-result.json'));
let exportAttempts = readJsonIfExists(path.join(figmaDir, 'export-image-attempts.json')) || [];

if (!fs.existsSync(referenceImagePath) || !exportJson?.ok) {
  const exportState = exportFigmaImageRobust(exportScript, fetchedFigma.fileKey, fetchedFigma.nodeId, referenceImagePath, figmaNodeJson, figmaNodePath);
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
const renderJson = renderPage(renderScript, pageUrl, screenshotPath, viewport, captureDir);

let backstopJson = null;
const backstopSummaryPath = path.join(backstopDir, 'backstop-run-summary.json');
if (hasReferenceImage) {
  backstopJson = runBackstop(backstopScript, pageUrl, referenceImagePath, viewport, projectSlug, backstopDir);
  if (!fs.existsSync(backstopSummaryPath)) writeJson(backstopSummaryPath, backstopJson);
}

let pixelmatch = { diffPath: '', reportPath: '', report: null };
if (hasReferenceImage) {
  pixelmatch = runPixelmatch(pixelmatchScript, referenceImagePath, screenshotPath, pixelmatchDir);
}

const top = buildTopMismatches({ hasReferenceImage, viewport, renderJson, backstopJson, exportJson });
const final = runFinalReport(reportScript, {
  outputDir: finalDir,
  figmaUrl,
  pageUrl,
  viewport,
  referenceImage: hasReferenceImage ? referenceImagePath : '',
  screenshotPath,
  diffPath: pixelmatch.diffPath,
  backstopSummaryPath: fs.existsSync(backstopSummaryPath) ? backstopSummaryPath : '',
  pixelmatchReportPath: pixelmatch.reportPath,
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
    backstopSummary: fs.existsSync(backstopSummaryPath) ? backstopSummaryPath : null,
    pixelmatchReport: pixelmatch.reportPath || null,
    pixelmatchDiff: pixelmatch.diffPath || null,
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
  backstop: backstopJson,
  pixelmatch: pixelmatch.report,
  final,
};

writeJson(path.join(manifest.runDir, 'run-result.json'), runResult);
writeJson(path.join(manifest.runDir, 'pipeline-summary.json'), runResult);
console.log(JSON.stringify(runResult, null, 2));
