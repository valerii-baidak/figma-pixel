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

function r255(v) { return Math.round((v ?? 0) * 255); }

function paintToHex(paint) {
  if (!paint || paint.type !== 'SOLID' || !paint.color) return null;
  if (paint.visible === false) return null;
  const { r, g, b } = paint.color;
  const a = paint.opacity ?? paint.color.a ?? 1;
  const hex = '#' + [r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
  return a < 0.99 ? { hex, opacity: +a.toFixed(3) } : hex;
}

function primaryFill(fills) {
  if (!Array.isArray(fills)) return null;
  for (const p of fills) {
    if (p.visible === false) continue;
    const c = paintToHex(p);
    if (c) return c;
  }
  return null;
}

function primaryStroke(node) {
  if (!Array.isArray(node.strokes) || !node.strokes.length) return null;
  const p = node.strokes[0];
  const c = paintToHex(p);
  if (!c) return null;
  return { color: c, weight: node.strokeWeight ?? 1, align: node.strokeAlign ?? 'INSIDE' };
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
  const s = node.style;
  if (!s) return null;
  const fill = primaryFill(node.fills);
  return {
    fontFamily: s.fontFamily ?? null,
    fontSize: s.fontSize ?? null,
    fontWeight: s.fontWeight ?? null,
    fontStyle: s.fontStyle ?? null,
    lineHeightPx: s.lineHeightPx ?? null,
    lineHeightUnit: s.lineHeightUnit ?? null,
    letterSpacing: s.letterSpacing ?? 0,
    textAlignH: s.textAlignHorizontal ?? null,
    textAlignV: s.textAlignVertical ?? null,
    color: fill ?? null,
  };
}

/**
 * Merge a base text style with an override entry from styleOverrideTable.
 */
function mergeTextStyle(base, override) {
  if (!override || !Object.keys(override).length) return { ...base };
  const merged = { ...base };
  if (override.fontFamily != null) merged.fontFamily = override.fontFamily;
  if (override.fontWeight != null) merged.fontWeight = override.fontWeight;
  if (override.fontStyle != null) merged.fontStyle = override.fontStyle;
  if (override.fontSize != null) merged.fontSize = override.fontSize;
  if (override.lineHeightPx != null) merged.lineHeightPx = override.lineHeightPx;
  if (override.letterSpacing != null) merged.letterSpacing = override.letterSpacing;
  if (Array.isArray(override.fills) && override.fills.length) {
    const c = primaryFill(override.fills);
    if (c) merged.color = c;
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
  if (!overrideTable || !Object.keys(overrideTable).length) return null;

  // If every character has the same override id, there's nothing to split
  const uniqueIds = new Set(charOverrides);
  if (uniqueIds.size <= 1) return null;

  const runs = [];
  let start = 0;
  let currentId = charOverrides[0];

  for (let i = 1; i <= charOverrides.length; i++) {
    const nextId = i < charOverrides.length ? charOverrides[i] : null;
    if (nextId !== currentId) {
      const ovEntry = currentId ? (overrideTable[String(currentId)] || {}) : {};
      runs.push({
        start,
        end: i,
        characters: chars.slice(start, i),
        style: mergeTextStyle(baseStyle, ovEntry),
      });
      start = i;
      currentId = nextId;
    }
  }

  return runs.length > 1 ? runs : null;
}

function boundsOf(node, ox, oy) {
  const bb = node.absoluteBoundingBox || node.absoluteRenderBounds;
  if (!bb) return null;
  return {
    x: Math.round(bb.x - ox),
    y: Math.round(bb.y - oy),
    width: Math.round(bb.width),
    height: Math.round(bb.height),
  };
}

function effects(node) {
  if (!Array.isArray(node.effects) || !node.effects.length) return null;
  return node.effects
    .filter((e) => e.visible !== false)
    .map((e) => ({
      type: e.type,
      radius: e.radius ?? null,
      color: e.color ? paintToHex({ type: 'SOLID', color: e.color, opacity: e.color.a }) : null,
      offset: e.offset ?? null,
    }));
}

// ─── tree walker ─────────────────────────────────────────────────────────────

function buildNode(node, ox, oy, depth, maxDepth, fontSet, colorSet, textList, warnList) {
  const bounds = boundsOf(node, ox, oy);
  if (!bounds) return null;

  const fill = primaryFill(node.fills);
  const stroke = primaryStroke(node);
  const layout = layoutOf(node);
  const eff = effects(node);

  // collect colors
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
  if (eff?.length) out.effects = eff;

  const cr = node.cornerRadius ?? null;
  const rcr = node.rectangleCornerRadii ?? null;
  if (cr !== null) out.cornerRadius = cr;
  if (rcr !== null) out.cornerRadii = rcr;

  if (node.opacity != null && node.opacity < 1) out.opacity = +node.opacity.toFixed(3);

  // warn about invisible fills
  if (Array.isArray(node.fills)) {
    for (const p of node.fills) {
      if (p.visible === false && p.type === 'SOLID') {
        warnList.push(`Node "${node.name}" (${node.id}) has an invisible fill — skip rendering it`);
      }
    }
  }

  if (node.type === 'TEXT') {
    const style = textStyleOf(node);
    const chars = node.characters ?? '';
    out.characters = chars;
    out.style = style;
    if (style?.fontFamily) fontSet.add(style.fontFamily);
    if (style?.color && typeof style.color === 'string') colorSet.add(style.color);

    // Extract inline styled runs (bold spans, colour changes, etc.)
    const charOverrides = node.characterStyleOverrides;
    const overrideTable = node.styleOverrideTable;
    const styledRuns = extractStyledRuns(chars, charOverrides, overrideTable, style);
    if (styledRuns) {
      out.styledRuns = styledRuns;
      warnList.push(
        `Node "${node.name}" (${node.id}) has inline style overrides — use styledRuns[] to render mixed bold/italic/colour spans`
      );
    }

    const textEntry = {
      id: node.id,
      name: node.name,
      characters: chars,
      bounds,
      style,
    };
    if (styledRuns) textEntry.styledRuns = styledRuns;
    textList.push(textEntry);
    return out;
  }

  // image fills → exportable
  if (Array.isArray(node.fills)) {
    for (const p of node.fills) {
      if (p.type === 'IMAGE' && p.visible !== false) {
        out.imageRef = p.imageRef ?? null;
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
      const c = buildNode(child, ox, oy, depth + 1, maxDepth, fontSet, colorSet, textList, warnList);
      if (c) children.push(c);
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

  const ox = rootBB.x;
  const oy = rootBB.y;
  const viewport = { width: Math.round(rootBB.width), height: Math.round(rootBB.height) };

  const fontSet = new Set();
  const colorSet = new Set();
  const textList = [];
  const warnList = [];

  // Build sections (top-level children of root)
  const sections = [];
  for (const child of (rootDoc.children || [])) {
    if (child.visible === false) {
      warnList.push(`Section "${child.name}" (${child.id}) has visible=false — skip`);
      continue;
    }
    const node = buildNode(child, ox, oy, 0, maxDepth, fontSet, colorSet, textList, warnList);
    if (node) sections.push(node);
  }

  // Color frequency
  const colorFreq = new Map();
  for (const c of colorSet) colorFreq.set(c, (colorFreq.get(c) || 0) + 1);
  const colors = [...colorFreq.entries()]
    .sort((a, b) => b[1] - a[1])
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
  if (!fs.existsSync(figmaNodePath)) {
    throw new Error(`figma-node.json not found: ${figmaNodePath}`);
  }
  const json = JSON.parse(fs.readFileSync(figmaNodePath, 'utf8'));
  const id = rootNodeId || Object.keys(json?.nodes || {})[0];
  if (!id) throw new Error('No node ID found in figma-node.json');
  return extractImplementationData(json, id, maxDepth);
}

module.exports = { extractImplementationData, extractFromFile };
