const fs = require('fs');
const path = require('path');
const { parseFigmaUrl } = require('./parse-figma-url.cjs');

function fail(message) {
  throw new Error(message);
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
  if (!response.ok) fail(`${label} request failed: ${response.status}`);
  return response.json();
}

async function fetchFigmaApi(figmaUrl, outputDir = 'figma-pixel-runs/project/run-id/figma', options = {}) {
  if (!figmaUrl) fail('Usage: node scripts/fetch-figma-api.cjs <figma-url> [figma-output-dir]');

  if (options.ensureRuntime !== false) ensureRuntimePresent();

  const token = options.token || process.env.FIGMA_TOKEN;
  if (!token) {
    fail('Missing FIGMA_TOKEN. Set a Figma personal access token before running this skill.');
  }

  const parsed = parseFigmaUrl(figmaUrl);
  const { fileKey, nodeId } = parsed;

  if (!fileKey) fail('Could not extract file key from Figma URL');

  const resolvedOutputDir = path.resolve(outputDir);
  fs.mkdirSync(resolvedOutputDir, { recursive: true });

  const headers = { 'X-Figma-Token': token };

  let nodePath = null;
  if (nodeId) {
    const nodeJson = await fetchJson(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`, headers, 'Figma node');
    nodePath = path.join(resolvedOutputDir, 'figma-node.json');
    fs.writeFileSync(nodePath, JSON.stringify(nodeJson, null, 2));
  }

  return {
    ok: true,
    figmaUrl,
    fileKey,
    nodeId,
    nodePath,
  };
}

module.exports = { fetchJson, fetchFigmaApi };
