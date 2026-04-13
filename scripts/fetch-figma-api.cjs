#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function ensureRuntimePresent() {
  const candidates = ['playwright', 'pixelmatch', 'pngjs', '@techstark/opencv-js'];
  const missing = [];

  for (const name of candidates) {
    try {
      require.resolve(name);
    } catch {
      missing.push(name);
    }
  }

  if (!missing.length) return;

  fail([
    `Missing runtime dependencies: ${missing.join(', ')}`,
    'Install them in the host environment:',
    'npm install playwright pixelmatch pngjs @techstark/opencv-js',
    'npx playwright install chromium',
  ].join('\n'));
}

async function fetchJson(url, headers, label) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    fail(`${label} request failed: ${response.status}`);
  }
  return response.json();
}

ensureRuntimePresent();

async function main() {
  const figmaUrl = process.argv[2];
  const outputDir = path.resolve(process.argv[3] || 'figma-pixel-runs/project/run-id/figma');

  if (!figmaUrl) {
    fail('Usage: node scripts/fetch-figma-api.cjs <figma-url> [figma-output-dir]');
  }

  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    fail('Missing FIGMA_TOKEN. Set a Figma personal access token before running this skill.');
  }

  let url;
  try {
    url = new URL(figmaUrl);
  } catch {
    fail('Invalid Figma URL');
  }

  const pathParts = url.pathname.split('/').filter(Boolean);
  const fileIndex = pathParts.findIndex((part) => part === 'file' || part === 'design');
  const fileKey = fileIndex >= 0 ? pathParts[fileIndex + 1] : null;
  const rawNodeId = url.searchParams.get('node-id') || url.searchParams.get('nodeId') || null;
  const decodedNodeId = rawNodeId ? decodeURIComponent(rawNodeId) : null;
  const nodeId = decodedNodeId ? decodedNodeId.replace(/-/g, ':') : null;

  if (!fileKey) {
    fail('Could not extract file key from Figma URL');
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const headers = { 'X-Figma-Token': token };

  const fileJson = await fetchJson(`https://api.figma.com/v1/files/${fileKey}`, headers, 'Figma file');
  const filePath = path.join(outputDir, 'figma-file.json');
  fs.writeFileSync(filePath, JSON.stringify(fileJson, null, 2));

  let nodePath = null;
  if (nodeId) {
    const nodeJson = await fetchJson(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`, headers, 'Figma node');
    nodePath = path.join(outputDir, 'figma-node.json');
    fs.writeFileSync(nodePath, JSON.stringify(nodeJson, null, 2));
  }

  console.log(JSON.stringify({
    ok: true,
    figmaUrl,
    fileKey,
    nodeId,
    filePath,
    nodePath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
