/**
 * implementation-extractor.cjs
 *
 * Extracts a structured implementation spec from figma-node.json in one pass.
 * Output is optimised for the agent to use directly without re-querying the raw JSON.
 *
 * All bounding coordinates are normalised to the root frame (root top-left = 0,0).
 */

'use strict';

const fs = require('fs');

// ─── helpers ─────────────────────────────────────────────────────────────────

const SCALAR_TEXT_STYLE_FIELDS = ['fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'lineHeightPx', 'letterSpacing'];

function paintToHex(paint) {
  if (!paint || paint.type !== 'SOLID' || !paint.color) return null;
  if (paint.visible === false) return null;
  const { r: red, g: green, b: blue } = paint.color;
  const alpha = paint.opacity ?? paint.color.a ?? 1;
  const hex = '#' + [red, green, blue].map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0')).join('');
  return alpha < 0.99 ? { hex, opacity: +alpha.toFixed(3) } : hex;
}

function primaryFill(fills) {
  if (!Array.isArray(fills)) return null;
  for (const paint of fills) {
    const hexColor = paintToHex(paint);
    if (hexColor) return hexColor;
  }
  return null;
}

function primaryStroke(node) {
  if (!Array.isArray(node.strokes) || !node.strokes.length) return null;
  const strokePaint = node.strokes[0];
  const hexColor = paintToHex(strokePaint);
  if (!hexColor) return null;
  return { color: hexColor, weight: node.strokeWeight ?? 1, align: node.strokeAlign ?? 'INSIDE' };
}

function layoutOf(node) {
  if (!node.layoutMode) return null;
  return {
    mode: node.layoutMode,
    paddingTop: node.paddingTop ?? 0,
    paddingRight: node.paddingRight ?? 0,
    paddingBottom: node.paddingBottom ?? 0,
    paddingLeft: node.paddingLeft ?? 0,
    itemSpacing: node.itemSpacing ?? 0,
    counterAxisSpacing: node.counterAxisSpacing ?? null,
    primaryAxisAlignItems: node.primaryAxisAlignItems ?? null,
    counterAxisAlignItems: node.counterAxisAlignItems ?? null,
  };
}

function textStyleOf(node) {
  const nodeStyle = node.style;
  if (!nodeStyle) return null;
  return {
    fontFamily: nodeStyle.fontFamily ?? null,
    fontSize: nodeStyle.fontSize ?? null,
    fontWeight: nodeStyle.fontWeight ?? null,
    fontStyle: nodeStyle.fontStyle ?? null,
    lineHeightPx: nodeStyle.lineHeightPx ?? null,
    lineHeightUnit: nodeStyle.lineHeightUnit ?? null,
    letterSpacing: nodeStyle.letterSpacing ?? 0,
    textAlignH: nodeStyle.textAlignHorizontal ?? null,
    textAlignV: nodeStyle.textAlignVertical ?? null,
    color: primaryFill(node.fills),
  };
}

/**
 * Merge a base text style with an override entry from styleOverrideTable.
 */
function mergeTextStyle(base, override) {
  if (!override) return { ...base };
  const merged = { ...base };

  for (const field of SCALAR_TEXT_STYLE_FIELDS) {
    if (override[field] != null) merged[field] = override[field];
  }

  if (Array.isArray(override.fills) && override.fills.length) {
    const overrideFill = primaryFill(override.fills);
    if (overrideFill) merged.color = overrideFill;
  }
  return merged;
}

/**
 * Extract styled runs from a TEXT node's characterStyleOverrides + styleOverrideTable.
 * Returns an array of { start, end, characters, style } when multiple distinct
 * styles exist within the node, or null when every character shares one style.
 */
function extractStyledRuns(chars, charOverrides, overrideTable, baseStyle) {
  if (!charOverrides || !charOverrides.length) return null;
  if (!overrideTable) return null;

  const uniqueIds = new Set(charOverrides);
  if (uniqueIds.size <= 1) return null;

  const runs = [];
  let start = 0;
  let currentId = charOverrides[0];

  for (let charIndex = 1; charIndex <= charOverrides.length; charIndex++) {
    const nextId = charIndex < charOverrides.length ? charOverrides[charIndex] : null;
    if (nextId !== currentId) {
      const overrideEntry = currentId ? (overrideTable[String(currentId)] || {}) : {};
      runs.push({
        start,
        end: charIndex,
        characters: chars.slice(start, charIndex),
        style: mergeTextStyle(baseStyle, overrideEntry),
      });
      start = charIndex;
      currentId = nextId;
    }
  }

  return runs.length > 1 ? runs : null;
}

function boundsOf(node, offsetX, offsetY) {
  const boundingBox = node.absoluteBoundingBox || node.absoluteRenderBounds;
  if (!boundingBox) return null;
  return {
    x: Math.round(boundingBox.x - offsetX),
    y: Math.round(boundingBox.y - offsetY),
    width: Math.round(boundingBox.width),
    height: Math.round(boundingBox.height),
  };
}

function effectsOf(node) {
  if (!Array.isArray(node.effects) || !node.effects.length) return null;
  return node.effects
    .filter((effect) => effect.visible !== false)
    .map((effect) => ({
      type: effect.type,
      radius: effect.radius ?? null,
      color: effect.color ? paintToHex({ type: 'SOLID', color: effect.color, opacity: effect.color.a }) : null,
      offset: effect.offset ?? null,
    }));
}

// ─── tree walker ─────────────────────────────────────────────────────────────

function buildNode(node, offsetX, offsetY, depth, maxDepth, fontSet, colorSet, textList, warnList) {
  const bounds = boundsOf(node, offsetX, offsetY);
  if (!bounds) return null;

  const fill = primaryFill(node.fills);
  const stroke = primaryStroke(node);
  const layout = layoutOf(node);
  const nodeEffects = effectsOf(node);

  if (typeof fill === 'string') colorSet.add(fill);
  else if (fill?.hex) colorSet.add(fill.hex);

  const out = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible !== false,
    bounds,
  };

  if (fill) out.fill = fill;
  if (stroke) out.stroke = stroke;
  if (layout) out.layout = layout;
  if (nodeEffects?.length) out.effects = nodeEffects;

  const nodeCornerRadius = node.cornerRadius ?? null;
  const nodeRectCornerRadii = node.rectangleCornerRadii ?? null;
  if (nodeCornerRadius !== null) out.cornerRadius = nodeCornerRadius;
  if (nodeRectCornerRadii !== null) out.cornerRadii = nodeRectCornerRadii;

  if (node.opacity != null && node.opacity < 1) out.opacity = +node.opacity.toFixed(3);

  if (node.type === 'TEXT') {
    const style = textStyleOf(node);
    const chars = node.characters ?? '';
    out.characters = chars;
    out.style = style;
    if (style?.fontFamily) fontSet.add(style.fontFamily);
    if (style?.color && typeof style.color === 'string') colorSet.add(style.color);

    const styledRuns = extractStyledRuns(chars, node.characterStyleOverrides, node.styleOverrideTable, style);
    if (styledRuns) {
      out.styledRuns = styledRuns;
      warnList.push(
        `Node "${node.name}" (${node.id}) has inline style overrides — use styledRuns[] to render mixed bold/italic/colour spans`
      );
    }

    const textEntry = { id: node.id, name: node.name, characters: chars, bounds, style };
    if (styledRuns) textEntry.styledRuns = styledRuns;
    textList.push(textEntry);
    return out;
  }

  if (Array.isArray(node.fills)) {
    for (const paint of node.fills) {
      if (paint.visible === false && paint.type === 'SOLID') {
        warnList.push(`Node "${node.name}" (${node.id}) has an invisible fill — skip rendering it`);
      }
      if (paint.type === 'IMAGE' && paint.visible !== false) {
        out.imageRef = paint.imageRef ?? null;
      }
    }
  }

  if (depth < maxDepth && Array.isArray(node.children)) {
    const children = [];
    for (const child of node.children) {
      if (child.visible === false) {
        warnList.push(`Node "${child.name}" (${child.id}) has visible=false — do not render`);
        continue;
      }
      const childNode = buildNode(child, offsetX, offsetY, depth + 1, maxDepth, fontSet, colorSet, textList, warnList);
      if (childNode) children.push(childNode);
    }
    if (children.length) out.children = children;
  }

  return out;
}

// ─── public API ──────────────────────────────────────────────────────────────

function extractImplementationData(figmaNodeJson, rootNodeId, maxDepth = 6) {
  const resolvedId = rootNodeId || Object.keys(figmaNodeJson?.nodes || {})[0];
  const rootEntry = figmaNodeJson?.nodes?.[resolvedId];
  const rootDoc = rootEntry?.document;
  if (!rootDoc) return { ok: false, error: `Node ${resolvedId} not found` };

  const rootBB = rootDoc.absoluteBoundingBox || rootDoc.absoluteRenderBounds;
  if (!rootBB) return { ok: false, error: 'Root node has no bounding box' };

  const offsetX = rootBB.x;
  const offsetY = rootBB.y;
  const viewport = { width: Math.round(rootBB.width), height: Math.round(rootBB.height) };

  const fontSet = new Set();
  const colorSet = new Set();
  const textList = [];
  const warnList = [];

  const sections = [];
  for (const child of (rootDoc.children || [])) {
    if (child.visible === false) {
      warnList.push(`Section "${child.name}" (${child.id}) has visible=false — skip`);
      continue;
    }
    const node = buildNode(child, offsetX, offsetY, 0, maxDepth, fontSet, colorSet, textList, warnList);
    if (node) sections.push(node);
  }

  const colorFreq = new Map();
  for (const hexColor of colorSet) colorFreq.set(hexColor, (colorFreq.get(hexColor) || 0) + 1);
  const colors = [...colorFreq.entries()]
    .sort((entryA, entryB) => entryB[1] - entryA[1])
    .map(([hex, count]) => ({ hex, count }));

  return {
    ok: true,
    rootNodeId: resolvedId,
    viewport,
    sections,
    texts: textList,
    fonts: [...fontSet].sort(),
    colors,
    warnings: warnList,
  };
}

function extractFromFile(figmaNodePath, rootNodeId, maxDepth = 6) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(figmaNodePath, 'utf8'));
  } catch {
    throw new Error(`figma-node.json not found: ${figmaNodePath}`);
  }
  const id = rootNodeId || Object.keys(json?.nodes || {})[0];
  if (!id) throw new Error('No node ID found in figma-node.json');
  return extractImplementationData(json, id, maxDepth);
}

module.exports = { extractImplementationData, extractFromFile };
