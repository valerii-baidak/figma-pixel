#!/usr/bin/env node

const input = process.argv[2];

if (!input) {
  console.error('Usage: node scripts/parse-figma-url.cjs <figma-url>');
  process.exit(1);
}

let url;
try {
  url = new URL(input);
} catch {
  console.error('Invalid URL');
  process.exit(1);
}

const pathParts = url.pathname.split('/').filter(Boolean);
const fileIndex = pathParts.findIndex((part) => part === 'file' || part === 'design');
const fileKey = fileIndex >= 0 ? pathParts[fileIndex + 1] : null;
const rawNodeId = url.searchParams.get('node-id') || url.searchParams.get('nodeId') || null;
const decodedNodeId = rawNodeId ? decodeURIComponent(rawNodeId) : null;
const nodeId = decodedNodeId ? decodedNodeId.replace(/-/g, ':') : null;

const result = {
  url: input,
  fileKey,
  nodeId,
  pathname: url.pathname,
};

console.log(JSON.stringify(result, null, 2));

if (!fileKey) {
  process.exit(2);
}
