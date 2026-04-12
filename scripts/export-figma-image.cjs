#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function fetchJson(url, headers, label) {
  const response = await fetch(url, { headers });
  if (!response.ok) fail(`${label} request failed: ${response.status}`);
  return response.json();
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

async function main() {
  const fileKey = process.argv[2];
  const nodeId = process.argv[3];
  const outputPath = path.resolve(process.argv[4] || 'reference-image.png');
  const nodeJsonPath = process.argv[5] ? path.resolve(process.argv[5]) : '';

  if (!fileKey || !nodeId) {
    fail('Usage: node scripts/export-figma-image.cjs <file-key> <node-id> [output-path] [figma-node-json]');
  }

  const token = process.env.FIGMA_TOKEN;
  if (!token) fail('Missing FIGMA_TOKEN');

  const nodeJson = nodeJsonPath && fs.existsSync(nodeJsonPath)
    ? JSON.parse(fs.readFileSync(nodeJsonPath, 'utf8'))
    : null;

  const target = pickExportTarget(nodeJson, nodeId);
  const headers = { 'X-Figma-Token': token };
  const imageJson = await fetchJson(
    `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(target.exportNodeId)}&format=png&scale=1`,
    headers,
    'Figma image'
  );

  const imageUrl = imageJson?.images?.[target.exportNodeId] || null;
  if (!imageUrl) fail('Figma image export URL not found');

  await downloadFile(imageUrl, outputPath);

  console.log(JSON.stringify({
    ok: true,
    fileKey,
    requestedNodeId: nodeId,
    exportNodeId: target.exportNodeId,
    reason: target.reason,
    requestedNodeType: target.requestedNodeType || null,
    exportNodeType: target.exportNodeType || null,
    imageUrl,
    imagePath: outputPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
