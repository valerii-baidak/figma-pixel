const fs = require('fs');
const path = require('path');
const { parseFigmaUrl } = require('./parse-figma-url.cjs');
const { fetchFigmaApi } = require('./figma-api.cjs');
const { exportFigmaImage } = require('./figma-export.cjs');

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
  if (first?.ok) return { result: first, attempts };

  const resolvedNodeId = resolveExportNodeId(figmaNodeJson, requestedNodeId);
  if (resolvedNodeId && resolvedNodeId !== requestedNodeId) {
    const second = await tryExportFigmaImage(fileKey, resolvedNodeId, outputPath, figmaNodeJson);
    if (second) attempts.push(second);
    if (second?.ok) return { result: second, attempts };
  }

  return { result: attempts[attempts.length - 1] || null, attempts };
}

async function prepareFigmaState(figmaUrl, figmaDir, sharedFigmaRoot) {
  const parsedFigma = parseFigmaUrl(figmaUrl);
  writeJson(path.join(figmaDir, 'parsed-figma-url.json'), parsedFigma);

  const sharedPaths = getSharedFigmaPaths(sharedFigmaRoot, parsedFigma);
  primeRunFigmaDirFromShared(sharedPaths, figmaDir);

  let fetchedFigma = readJsonIfExists(path.join(figmaDir, 'fetch-result.json'));
  if (!fetchedFigma?.ok) {
    fetchedFigma = await fetchFigmaApi(figmaUrl, figmaDir);
    writeJson(path.join(figmaDir, 'fetch-result.json'), fetchedFigma);
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

  return {
    parsedFigma,
    fetchedFigma,
    referenceImagePath,
    exportJson,
    exportAttempts,
    viewport,
    sharedPaths,
  };
}

module.exports = {
  prepareFigmaState,
  writeJson,
};
