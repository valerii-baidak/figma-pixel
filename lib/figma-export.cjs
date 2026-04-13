const fs = require('fs');
const path = require('path');
const { fetchJson } = require('./figma-api.cjs');

function fail(message) {
  throw new Error(message);
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) fail(`Reference image download failed: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
}

function pickExportTarget(nodeJson, requestedNodeId) {
  const document = nodeJson?.nodes?.[requestedNodeId]?.document || null;
  if (!document) {
    return { exportNodeId: requestedNodeId, reason: 'requested-node-missing' };
  }

  if (document.type === 'CANVAS' && Array.isArray(document.children) && document.children.length === 1) {
    const child = document.children[0];
    return {
      exportNodeId: child.id || requestedNodeId,
      reason: 'single-child-frame',
      requestedNodeType: document.type,
      exportNodeType: child.type,
    };
  }

  return {
    exportNodeId: requestedNodeId,
    reason: 'direct-node',
    requestedNodeType: document.type,
    exportNodeType: document.type,
  };
}

async function exportFigmaImage(fileKey, nodeId, outputPath = 'reference-image.png', nodeJson = null, options = {}) {
  if (!fileKey || !nodeId) {
    fail('Usage: node scripts/export-figma-image.cjs <file-key> <node-id> [output-path]');
  }

  const token = options.token || process.env.FIGMA_TOKEN;
  if (!token) fail('Missing FIGMA_TOKEN');

  const resolvedOutputPath = path.resolve(outputPath);
  const target = pickExportTarget(nodeJson, nodeId);
  const headers = { 'X-Figma-Token': token };
  const imageJson = await fetchJson(
    `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(target.exportNodeId)}&format=png&scale=1`,
    headers,
    'Figma image'
  );

  const imageUrl = imageJson?.images?.[target.exportNodeId] || null;
  if (!imageUrl) fail('Figma image export URL not found');

  await downloadFile(imageUrl, resolvedOutputPath);

  return {
    ok: true,
    fileKey,
    requestedNodeId: nodeId,
    exportNodeId: target.exportNodeId,
    reason: target.reason,
    requestedNodeType: target.requestedNodeType || null,
    exportNodeType: target.exportNodeType || null,
    imagePath: resolvedOutputPath,
  };
}

module.exports = { downloadFile, pickExportTarget, exportFigmaImage };
