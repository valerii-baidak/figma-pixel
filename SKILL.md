---
name: figma-pixel
description: Compare a webpage or UI layout against a Figma design, then guide the agent to build or fix the implementation. Scripts handle capture, comparison, and reporting; the agent applies layout fixes based on Figma data and diff results. Use when the user provides a Figma URL and asks to build, recreate, match, compare, restyle, or tighten implementation to that design.
tools: Read, Write, Edit, Bash, Glob, Grep
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

This skill has two layers:
- **Scripts** — automated: parse Figma URLs, fetch API data, export reference images, render pages with Playwright, run pixelmatch/OpenCV comparison, and generate reports.
- **Agent** — guided: the LLM reads Figma API data and diff reports, then writes or edits HTML/CSS to fix mismatches. Layout fixes are made by the agent, not by the scripts.

The scripts do not auto-patch code. They produce the data and artifacts the agent needs to make accurate, Figma-grounded fixes.

This skill should behave in a production-ready way:
- require a valid `FIGMA_TOKEN`
- prefer stable scripted flows over ad-hoc commands
- **never create working folders, scratch files, or runtime artifacts inside the implementation project directory** — all run outputs go under the skill's own `figma-pixel-runs/` directory (i.e. alongside this SKILL.md file)
- reuse shared Figma artifacts when possible
- stop clearly on real blockers instead of silently degrading

## Setup

Prerequisites:
- `FIGMA_TOKEN` must be set
- the target page must be reachable through a stable local or remote URL
- the implementation project must allow normal page rendering, fonts, and asset loading
- the runtime environment must already provide the required Node.js packages and browser executable

Install these packages in the host environment before using the skill:

```bash
npm install playwright pixelmatch pngjs @techstark/opencv-js --save-prod
npx playwright install chromium
```

On Linux, Chromium may also require system libraries:

```bash
apt-get update && apt-get install -y libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 libgtk-3-0
```

This skill does not install dependencies at runtime.
Without these packages, system libraries, and a working browser executable, the skill will not work fully and some flows will fail immediately.
If required packages are missing, stop and report the missing dependency clearly.

Read `references/setup.md` for environment expectations.

## Workflow

1. Read the Figma source.
2. Parse the Figma URL and fetch or reuse Figma data.
3. Check fonts used in the design and ask the user whether to connect them.
4. Export the Figma reference image.
5. Open the implementation through the most stable available URL.
6. Capture the current rendered page.
7. Compare the implementation against the design.
8. Agent makes visible layout fixes based on Figma data and diff results.
9. Re-run comparison and summarize the result.

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
- Read visual properties directly from Figma API data whenever available instead of approximating them by eye.
- Treat Figma fills, strokes, effects, typography, corner radius, bounds, spacing, and image references as authoritative implementation inputs.

Read `references/figma.md` for the expected Figma input layer.

## Step 2, prepare the reference image

- Start each comparison run by creating a dedicated run folder with `scripts/init-run-dir.cjs`.
- Store all outputs under the skill's `figma-pixel-runs/<project-slug>/<run-id>/` directory — this folder lives next to SKILL.md, not inside the implementation project.
- Reuse shared Figma artifacts under `figma-pixel-runs/<project-slug>/shared/figma/` so repeated runs for the same file/node do not refetch the same Figma file, node, and reference image every time.
- Save the Figma-derived reference image in that run directory.
- Do not create ad-hoc working folders or scratch assets inside the implementation project for Figma processing, such as `.figma-source`, temporary export caches, or other non-project runtime files. Keep working files in the run directory or shared cache only.
- Derive viewport width and height from the Figma frame/node bounds, not from hardcoded values.
- Derive block, card, panel, image, and section width and height from Figma bounds instead of eyeballing proportions.
- Match section spacing from Figma, including padding, gap, inter-section spacing, and internal content spacing.
- Treat the exported Figma reference PNG as the exact visual target for comparison. Without the reference image, visual matching is unreliable.
- Use real Figma-derived screenshots, exports, or crops for visual content. Do not invent placeholder preview images, surrogate mock panels, or decorative stand-ins when the Figma design already shows the real visuals.
- When the design includes embedded preview panels, screenshots, or UI previews, prefer inserting those real Figma-derived images instead of recreating approximate placeholders.
- If the Figma node uses image fills or exportable assets, extract and use those assets instead of substituting similar images.
- Keep the viewport/frame size explicit.
- Preserve enough metadata to trace the comparison later: URL, node id, size, label.

Read `references/artifacts.md` for the expected artifact set.

## Step 2b, check and connect fonts

After fetching Figma data, extract the list of unique font families used in the design.
Read `fontFamily` values from `figma/design-tokens.json` (typography array) if available, or from `figma-node.json` directly.

Ask the user before proceeding:
> "This design uses the following fonts: **[Font A, Font B, ...]**. Should I connect them?
> Without the correct fonts the Playwright screenshot will render fallback fonts and the pixel comparison will be inaccurate."

If the user says **yes**:
- For each font, add a `<link>` or `@import` for Google Fonts (or the appropriate CDN) to the implementation's HTML or global CSS.
- Prefer `<link rel="preconnect">` + `<link rel="stylesheet">` in `<head>` for HTML pages.
- For CSS-only projects, add `@import url(...)` at the top of the main stylesheet.
- Verify the font loads in the browser before screenshotting (Playwright already waits for `document.fonts.ready`).

If the user says **no**, note that comparison results may be inaccurate due to font fallbacks and continue.

If the fonts are already present in the implementation (referenced in CSS or loaded via a font provider), skip the question and proceed.

## Step 2c, extract implementation spec (spec-first)

After fetching Figma data and before writing any HTML/CSS, run:

```bash
node scripts/extract-implementation-data.cjs <path-to-figma-node.json>
```

This produces `implementation-spec.json` in the same directory as `figma-node.json`.
When using `run-pipeline.cjs`, this file is generated automatically — check `artifacts.implementationSpec` in the run result.

The spec gives you in one file:
- `viewport` — exact frame dimensions (width × height)
- `sections[]` — full annotated node tree with `bounds` (relative to root 0,0), `fill`, `stroke`, `cornerRadius`, `layout` (auto-layout mode/padding/gap), `effects`
- `texts[]` — flat list of every text node with `characters` and `style` (fontFamily, fontSize, fontWeight, lineHeightPx, color)
- `fonts[]` — unique font families used
- `colors[]` — all fill colors sorted by frequency, as `{ hex, count }`
- `warnings[]` — nodes with `visible=false` (do not render these) and invisible fills (skip those fills)

**Use `implementation-spec.json` as the primary reference when building or fixing layout.** Avoid repeated ad-hoc queries against the raw `figma-node.json` — the spec captures everything needed in a single structured pass.

**Always read `warnings[]` before writing any HTML.** Every entry in `warnings[]` is a node with `visible=false` or an invisible fill — do not render these nodes or their content. Rendering invisible nodes is a common source of incorrect content in the implementation.

Read `references/scripts.md` for the exact argument format and output contract.

## Step 3, build initial implementation (if starting from scratch)

Skip this step if an implementation already exists — go directly to Step 4.

If no implementation exists yet:
- Read `implementation-spec.json` (from Step 2c) for frame bounds, layout structure, colors, typography, spacing, and component hierarchy.
- Detect the project type from context: check for `package.json`, framework config files (`next.config.*`, `vite.config.*`, `nuxt.config.*`, etc.), or ask the user if unclear.
- Create the implementation using the conventions of the detected stack — follow its standard file and component conventions, and match the styling approach already used in the project.
- Use Figma-derived values for all properties — do not invent defaults.
- Do not add placeholder content or lorem ipsum when Figma already defines real content.
- After creating the file(s), continue to Step 4.

## Step 4, open the implementation stably

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
- diff-region report when the runtime is available
- diff image
- mismatch percentage
- machine-readable report

## Step 6, make visible layout fixes

This step is performed by the agent, not by the scripts.
The agent uses Figma API data, reference images, and diff reports from previous steps to decide what to change, then edits the implementation files (HTML, CSS, assets) directly.

Prioritize the biggest contributors first:
- wrong section backgrounds
- missing or duplicated structural blocks
- wrong hero height or heading scale
- wrong section spacing and proportions
- missing right-column content in comparison sections
- missing repeated footer/meta rows when present in design
- oversized or undersized preview panels
- extra bottom whitespace or wrong page ending
- mismatched colors, corner radius, typography, or imagery

Prefer visible, direct fixes over refactors.
Do not implement nodes where `visible === false` in the Figma API — these are hidden layers and must be skipped entirely. Check `visible` on every node before using its content, fills, or dimensions.
Do not invent new content if the design already defines it.
Do not replace real preview visuals with invented placeholders when Figma already provides the real screenshot or crop source.
Use Figma API data and screenshots to ground spacing, sizing, structure, embedded preview imagery, color decisions, corner radius, borders, effects, and typography.
Do not invent page, section, card, or preview colors when the Figma file already defines them. Read and match section backgrounds, text colors, fills, borders, and accents directly from the Figma source.
Matching colors directly from Figma can materially reduce mismatch and should be preferred over manual palette guessing.
Read and apply `cornerRadius` or `rectangleCornerRadii` from Figma for cards, buttons, inputs, images, and preview panels instead of defaulting to generic border radius values.
Match typography from Figma, including font family, font size, font weight, line height, letter spacing, and text alignment.
Match borders and visible effects from Figma, including stroke width, stroke color, shadow, blur, and opacity when they materially affect the rendered result.
Use the correct Figma-derived assets for images, thumbnails, screenshots, and fills. If an asset cannot be extracted from Figma, report the blocker clearly instead of silently substituting an incorrect image.
Prefer exact layout dimensions from Figma bounds over approximate CSS values. Avoid "close enough" sizing when the design provides exact measurements.

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

## Step 8, ask about the next iteration

After summarizing results, always ask the user whether to run another iteration.

Show the current mismatch percentage and the top remaining mismatches, then ask:
- whether to continue with another round of fixes
- which specific issues to prioritize in the next pass, or whether to let the agent decide based on the diff

Do not start the next iteration without explicit user confirmation.
If the user confirms, return to Step 6 and repeat from there.

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
- whether colors, radius, dimensions, spacing, typography, and images were matched or remain incorrect

Before considering the task done, verify this fidelity checklist:
- colors match Figma API values
- corner radius matches Figma
- dimensions match Figma bounds
- spacing, padding, and gaps match Figma
- typography matches Figma
- correct Figma-derived images or exports are used
- no invented placeholders remain where Figma provides real assets

## Security

- **FIGMA_TOKEN**: use a token with the minimum scope needed (read-only file access). Rotate the token if you suspect exposure. The skill does not persist the token in artifacts or logs, but verify your environment before sharing run outputs.
- **Playwright / Chromium**: the render step loads the target page URL in a headless browser. Network requests from the page will be executed. Run in an isolated environment (container, sandbox) if loading untrusted pages.
- **Artifacts**: screenshots and Figma exports under `figma-pixel-runs/` may contain sensitive UI content. Review and clean these folders before sharing or committing them.

## References

- Read `references/figma.md` for the Figma input layer.
- Read `references/workflow.md` for a concise execution checklist.
- Read `references/artifacts.md` for the run directory contract and expected artifact outputs.
- Read `references/scripts.md` for the exact CLI usage of every script, including `extract-implementation-data.cjs`.
