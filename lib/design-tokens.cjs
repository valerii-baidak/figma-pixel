const fs = require('fs');

function rgbaToHex({ r: red, g: green, b: blue }) {
  return '#' + [red, green, blue]
    .map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0'))
    .join('');
}

function paintToColor(paint) {
  if (!paint || paint.type !== 'SOLID' || !paint.color) return null;
  return {
    hex: rgbaToHex(paint.color),
    opacity: +(paint.opacity != null ? paint.opacity : (paint.color.a ?? 1)).toFixed(3),
  };
}

function traverseNodes(node, callback) {
  if (node.visible === false) return;
  callback(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) traverseNodes(child, callback);
  }
}

function extractDesignTokens(figmaNodeJson, nodeId) {
  const rootEntry = figmaNodeJson?.nodes?.[nodeId];
  const rootDoc = rootEntry?.document;
  if (!rootDoc) return null;

  const rootBounds = rootDoc.absoluteBoundingBox || rootDoc.absoluteRenderBounds || null;

  const fills = [];
  const typography = [];
  const spacing = [];
  const cornerRadius = [];
  const strokes = [];
  const colorIndex = new Map();

  traverseNodes(rootDoc, (node) => {
    const name = node.name || '';
    const id = node.id || '';

    // fills
    if (Array.isArray(node.fills)) {
      for (const paint of node.fills) {
        const color = paintToColor(paint);
        if (!color) continue;
        const key = `${color.hex}|${color.opacity}`;
        if (!colorIndex.has(key)) {
          colorIndex.set(key, { hex: color.hex, opacity: color.opacity, usedBy: [] });
          fills.push(colorIndex.get(key));
        }
        const entry = colorIndex.get(key);
        if (!entry.usedBy.includes(name)) entry.usedBy.push(name);
      }
    }

    // typography
    if (node.type === 'TEXT' && node.style) {
      const nodeStyle = node.style;
      const textColor = Array.isArray(node.fills) && node.fills[0]
        ? paintToColor(node.fills[0])
        : null;
      typography.push({
        nodeName: name,
        nodeId: id,
        fontFamily: nodeStyle.fontFamily || null,
        fontSize: nodeStyle.fontSize || null,
        fontWeight: nodeStyle.fontWeight || null,
        lineHeightPx: nodeStyle.lineHeightPx || null,
        lineHeightPercent: nodeStyle.lineHeightPercent || null,
        letterSpacing: nodeStyle.letterSpacing || null,
        textAlignHorizontal: nodeStyle.textAlignHorizontal || null,
        textTransform: nodeStyle.textCase || null,
        color: textColor?.hex || null,
      });
    }

    // auto-layout spacing
    if (
      node.layoutMode &&
      (node.paddingLeft != null || node.paddingTop != null || node.itemSpacing != null)
    ) {
      spacing.push({
        nodeName: name,
        nodeId: id,
        layoutMode: node.layoutMode,
        paddingLeft: node.paddingLeft ?? 0,
        paddingRight: node.paddingRight ?? 0,
        paddingTop: node.paddingTop ?? 0,
        paddingBottom: node.paddingBottom ?? 0,
        itemSpacing: node.itemSpacing ?? 0,
        counterAxisSpacing: node.counterAxisSpacing ?? null,
      });
    }

    // corner radius
    const hasRadius = node.cornerRadius != null || node.rectangleCornerRadii != null;
    if (hasRadius) {
      cornerRadius.push({
        nodeName: name,
        nodeId: id,
        cornerRadius: node.cornerRadius ?? null,
        rectangleCornerRadii: node.rectangleCornerRadii ?? null,
      });
    }

    // strokes
    if (Array.isArray(node.strokes) && node.strokes.length && node.strokeWeight) {
      for (const paint of node.strokes) {
        const color = paintToColor(paint);
        if (!color) continue;
        strokes.push({
          nodeName: name,
          nodeId: id,
          strokeWeight: node.strokeWeight,
          hex: color.hex,
          opacity: color.opacity,
          strokeAlign: node.strokeAlign || null,
        });
      }
    }
  });

  return {
    frame: rootBounds
      ? { width: Math.round(rootBounds.width), height: Math.round(rootBounds.height) }
      : null,
    fills,
    typography,
    spacing,
    cornerRadius,
    strokes,
  };
}

function extractDesignTokensFromFile(figmaNodePath, nodeId) {
  if (!fs.existsSync(figmaNodePath)) {
    throw new Error(`figma-node.json not found: ${figmaNodePath}`);
  }
  const figmaNodeJson = JSON.parse(fs.readFileSync(figmaNodePath, 'utf8'));
  const resolvedNodeId = nodeId || Object.keys(figmaNodeJson?.nodes || {})[0];
  if (!resolvedNodeId) throw new Error('No node ID found in figma-node.json');
  const tokens = extractDesignTokens(figmaNodeJson, resolvedNodeId);
  if (!tokens) throw new Error(`Node ${resolvedNodeId} not found in figma-node.json`);
  return tokens;
}

module.exports = { extractDesignTokensFromFile };
