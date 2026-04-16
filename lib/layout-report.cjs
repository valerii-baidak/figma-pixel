const fs = require('fs');
const path = require('path');

function readJsonSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function generateLayoutReport(options = {}) {
  const outputDir = path.resolve(options.output || 'figma-pixel-runs/project/run-id/final');
  const figma = options.figma || '';
  const page = options.page || '';
  const viewport = options.viewport || '';
  const referenceImage = options.reference || '';
  const screenshot = options.screenshot || '';
  const diffImage = options.diff || '';
  const pixelmatchReportPath = options.pixelmatchReport || '';
  const opencvReportPath = options.opencvReport || '';
  const topMismatches = Array.isArray(options.top)
    ? options.top.filter(Boolean)
    : String(options.top || '').split('|').map((s) => s.trim()).filter(Boolean);

  fs.mkdirSync(outputDir, { recursive: true });

  const pixelmatchReport = readJsonSafe(pixelmatchReportPath);
  const opencvReport = readJsonSafe(opencvReportPath);

  const mismatch = pixelmatchReport?.diffPercent ?? null;
  const match = mismatch == null ? null : +(100 - Number(mismatch)).toFixed(2);
  const status = mismatch == null ? 'blocked' : mismatch <= 5 ? 'pass' : mismatch <= 20 ? 'needs review' : 'needs work';

  const annotatedDiff = opencvReport?.annotatedDiff || null;

  const report = {
    figma,
    page,
    viewport,
    matchPercent: match,
    mismatchPercent: mismatch,
    status,
    viewportFallbackUsed: topMismatches.includes('viewport fallback used: no usable Figma node bounds'),
    artifacts: {
      referenceImage: referenceImage || null,
      screenshot: screenshot || null,
      diffImage: diffImage || null,
      annotatedDiff,
      pixelmatchReport: pixelmatchReportPath || null,
      opencvReport: opencvReportPath || null,
    },
    topMismatches,
  };

  const jsonPath = path.join(outputDir, 'report.json');
  const summaryPath = path.join(outputDir, 'summary.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const lines = [];
  lines.push('# Layout report');
  lines.push('');
  if (figma) lines.push(`- **Figma:** ${figma}`);
  if (page) lines.push(`- **Page:** ${page}`);
  if (viewport) lines.push(`- **Viewport:** ${viewport}`);
  if (report.viewportFallbackUsed) lines.push('- **Viewport source:** fallback (Figma bounds were unavailable)');
  if (match != null) lines.push(`- **Match:** ${match}%`);
  if (mismatch != null) lines.push(`- **Mismatch:** ${mismatch}%`);
  lines.push(`- **Status:** ${status}`);
  lines.push('');
  lines.push('## Artifacts');
  lines.push(`- reference image: ${referenceImage || 'n/a'}`);
  lines.push(`- screenshot: ${screenshot || 'n/a'}`);
  lines.push(`- diff image: ${diffImage || 'n/a'}`);
  lines.push(`- report json: ${jsonPath}`);
  lines.push('');
  lines.push('## Top mismatches');
  if (topMismatches.length) {
    for (const item of topMismatches) lines.push(`- ${item}`);
  } else {
    lines.push('- n/a');
  }
  lines.push('');
  lines.push('## OpenCV analysis');
  if (opencvReport?.ok) {
    lines.push(`- difference regions: ${opencvReport.differenceRegionCount ?? 'n/a'}`);
    if (Array.isArray(opencvReport.summary) && opencvReport.summary.length) {
      for (const item of opencvReport.summary.slice(0, 5)) lines.push(`- ${item}`);
    } else {
      lines.push('- n/a');
    }
    if (Array.isArray(opencvReport.largestRegions) && opencvReport.largestRegions.length) {
      lines.push('');
      lines.push('### Largest regions');
      for (const region of opencvReport.largestRegions.slice(0, 5)) {
        lines.push(`- ${region.zone}: ${region.width}x${region.height}px at (${region.x}, ${region.y}), mean diff ${region.meanAbsDiff}`);
      }
    }
  } else {
    lines.push(`- ${opencvReport?.error || 'not available'}`);
  }

  fs.writeFileSync(summaryPath, `${lines.join('\n')}\n`);
  return { ok: true, report: jsonPath, summary: summaryPath, status, mismatch };
}

module.exports = { generateLayoutReport };
