---
name: figma-pixel
description: Compare, implement, and adjust webpage or UI layout against a Figma design. Use when the user provides a Figma URL and asks to build, recreate, match, compare, restyle, or tighten implementation to that design, including short prompts like "build this", "make this", "match this", "recreate this", "implement this", or "implement this design".
metadata:
  openclaw:
    emoji: 📐
    requires:
      env:
        - FIGMA_TOKEN
---

# Figma Pixel

## Overview

Use this skill when a user shares a Figma link and wants to build a page from that design or bring an existing implementation closer to it.
Treat Figma as the source of truth.
Capture the current page, compare it against the design, apply visible layout fixes, and iterate until the result is closer.

This skill should behave in a production-ready way:
- require a valid `FIGMA_TOKEN`
- prefer stable scripted flows over ad-hoc commands
- keep runtime artifacts out of the implementation project directory
- reuse shared Figma artifacts when possible
- stop clearly on real blockers instead of silently degrading

## Setup

Prerequisites:
- `FIGMA_TOKEN` must be set
- the target page must be reachable through a stable local or remote URL
- the implementation project must allow normal page rendering, fonts, and asset loading

This skill is intended to install its runtime dependencies during skill installation by running:

```bash
node scripts/setup.cjs
```

Treat install-time setup as the primary path.
Automatic setup during script execution is only a fallback when install-time setup was skipped.

Read `references/setup.md` for details.

## Workflow

1. Read the Figma source.
2. Parse the Figma URL and fetch or reuse Figma data.
3. Export the Figma reference image.
4. Open the implementation through the most stable available URL.
5. Capture the current rendered page.
6. Compare the implementation against the design.
7. Make visible layout fixes.
8. Re-run comparison and summarize the result.

Use `scripts/run-pipeline.cjs` as the primary orchestration entry point.
Prefer the pipeline over one-off script combinations unless you are debugging a specific failing stage.

Token discipline for this skill:
- Prefer compact artifacts first: `run-result.json`, `pipeline-summary.json`, `final/report.json`, `figma/viewport.json`, `figma/export-image-result.json`.
- Avoid large raw files unless the compact artifacts are insufficient.
- Do not invoke image or vision analysis by default.
- Keep progress updates short and spend tokens on fixes and verification.

## Step 1, read the Figma source

- Start from the Figma URL the user provided.
- Use `scripts/parse-figma-url.cjs` to extract file key and node id.
- Use `scripts/fetch-figma-api.cjs` to fetch file and node data when API access is available.
- Use Figma API output and Figma screenshots as the visual truth.
- Prefer the exact requested frame/node over guessing from nearby content.

Read `references/figma.md` for the expected Figma input layer.

## Step 2, prepare the reference image

- Start each comparison run by creating a dedicated run folder with `scripts/init-run-dir.cjs`.
- Store all outputs under `figma-pixel-runs/<project-slug>/<run-id>/`.
- Reuse shared Figma artifacts under `figma-pixel-runs/<project-slug>/shared/figma/` so repeated runs for the same file/node do not refetch the same Figma file, node, and reference image every time.
- Save the Figma-derived reference image in that run directory.
- Do not create ad-hoc working folders or scratch assets inside the implementation project for Figma processing, such as `.figma-source`, temporary export caches, or other non-project runtime files. Keep working files in the run directory or shared cache only.
- Derive viewport width and height from the Figma frame/node bounds, not from hardcoded values.
- Treat the exported Figma reference PNG as the exact visual target for comparison. Without the reference image, visual matching is unreliable.
- Use real Figma-derived screenshots, exports, or crops for visual content. Do not invent placeholder preview images, surrogate mock panels, or decorative stand-ins when the Figma design already shows the real visuals.
- When the design includes embedded preview panels, screenshots, or UI previews, prefer inserting those real Figma-derived images instead of recreating approximate placeholders.
- Keep the viewport/frame size explicit.
- Preserve enough metadata to trace the comparison later: URL, node id, size, label.

Read `references/artifacts.md` for the expected artifact set.

## Step 3, open the implementation stably

Prefer the most stable path that avoids unnecessary build-tool churn.

Use this order:
1. Existing stable local URL provided by the user.
2. Static serve of already-built files.
3. Static serve directly from source for simple HTML/CSS pages.
4. Project dev/build pipeline only when needed and healthy.

Do not get stuck debugging Vite, bundlers, or optional native dependencies unless the user explicitly wants pipeline repair.
If the page can be served statically, prefer that.

## Step 4, capture the current render

- Use `scripts/render-page.cjs` for deterministic capture.
- Wait for fonts and images.
- Disable animations and transitions before screenshotting.
- Capture full-page when comparing full-page designs.
- Record failed requests and bad responses.

If browser lookup is flaky, use `CHROMIUM_PATH` or `PLAYWRIGHT_MODULE_PATH` as explicit overrides.

## Step 5, compare the result

Use the available comparison tooling to produce a reliable visual diff.
Prefer the existing scripted comparison flow.
Use Playwright render capture and pixelmatch as the primary reliable comparison path.
When available, run the optional Node.js post-processing step after `pixelmatch` to group raw pixel differences into larger mismatch regions.

Always try to produce these artifacts:
- reference image
- rendered screenshot
- diff image
- mismatch percentage
- machine-readable report
- diff-region report when the runtime is available

## Step 6, make visible layout fixes

Prioritize the biggest contributors first:
- wrong section backgrounds
- missing or duplicated structural blocks
- wrong hero height or heading scale
- wrong section spacing and proportions
- missing right-column content in comparison sections
- missing repeated footer/meta rows when present in design
- oversized or undersized preview panels
- extra bottom whitespace or wrong page ending

Prefer visible, direct fixes over refactors.
Do not invent new content if the design already defines it.
Do not replace real preview visuals with invented placeholders when Figma already provides the real screenshot or crop source.
Use Figma API data and screenshots to ground spacing, sizing, structure, embedded preview imagery, and color decisions.
Do not invent page, section, card, or preview colors when the Figma file already defines them. Read and match section backgrounds, text colors, fills, borders, and accents directly from the Figma source.
Matching colors directly from Figma can materially reduce mismatch and should be preferred over manual palette guessing.

## Step 7, re-run and summarize

After each pass, summarize:
- current mismatch percentage
- paths to artifacts
- biggest remaining mismatches
- blockers, if any

When checking prior results, prefer the compact JSON outputs over rereading large markdown or raw tool logs.

Use `scripts/generate-layout-report.cjs` at the end of the pipeline to produce both:
- `report.json`
- `summary.md`

If tooling failed but useful artifacts exist, say so plainly and continue with the best available diff method.
If the page is unreachable, `FIGMA_TOKEN` is missing, or required artifacts cannot be produced, stop and report the blocking reason clearly.
At the end of the task, ask the user whether they want to clean up working files under `figma-pixel-runs/<project-slug>/` before deleting anything.

## Output contract

When this skill is used, always try to return:
- Figma source used
- reference image path
- rendered screenshot path
- diff image/report path
- mismatch percentage
- short human-readable layout summary
- top visible mismatches
- what was changed
- what failed, if anything

## References

- Read `references/setup.md` before first use.
- Read `references/figma.md` for the Figma input layer.
- Read `references/workflow.md` for a concise execution checklist.
- Read `references/artifacts.md` for the run directory contract and expected artifact outputs.
