---
name: figma-pixel
description: Compare, implement, and adjust webpage or UI layout against a Figma design. Use when the user provides a Figma URL and asks to build, recreate, match, compare, restyle, or tighten implementation to that design.
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

This skill should:
- require a valid `FIGMA_TOKEN`
- prefer stable scripted flows over ad-hoc commands
- keep runtime artifacts out of the implementation project directory
- reuse shared Figma artifacts when possible
- stop clearly on real blockers instead of silently degrading

## Setup

Prerequisites:
- `FIGMA_TOKEN` must be set
- the target page must be reachable through a stable local or remote URL
- the implementation project must render normally, including fonts and assets

Install runtime dependencies with:

```bash
node scripts/setup.cjs
```

Read `references/setup.md` before first use.

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
- prefer compact artifacts first: `run-result.json`, `pipeline-summary.json`, `final/report.json`, `figma/viewport.json`, `figma/export-image-result.json`
- avoid large raw files unless compact artifacts are insufficient
- do not invoke image or vision analysis by default
- keep progress updates short and spend tokens on fixes and verification

## Execution rules

- Start from the exact Figma URL the user provided.
- Prefer the exact requested frame or node over guessing from nearby content.
- Store outputs under `figma-pixel-runs/<project-slug>/<run-id>/`.
- Reuse shared Figma artifacts under `figma-pixel-runs/<project-slug>/shared/figma/`.
- Do not create scratch folders or runtime-only assets inside the implementation project.
- Derive viewport size from the Figma frame or node bounds.
- Use real Figma-derived screenshots, exports, or crops when the design already contains the real visuals.
- - Use real Figma-derived screenshots, exports, or crops when the design already contains the real visuals.
- Placeholder images are not acceptable when the Figma design contains real visuals.
- Use real Figma-derived assets only: export, screenshot, or crop.
- If the required visual cannot be extracted from Figma, stop and report the blocker clearly.
- Prefer the most stable serving path and avoid unnecessary build-tool churn.
- If one comparison tool fails but another still works, continue with the best available diff method.
- If the page is unreachable, `FIGMA_TOKEN` is missing, or required artifacts cannot be produced, stop and report the blocker clearly.

## Output contract

When this skill is used, always try to return:
- Figma source used
- reference image path
- rendered screenshot path
- diff image or report path
- mismatch percentage
- short layout summary
- top visible mismatches
- what was changed
- what failed, if anything

At the end of the task, ask the user whether they want to clean up working files under `figma-pixel-runs/<project-slug>/` before deleting anything.

## References

- Read `references/figma.md` for the Figma input layer.
- Read `references/workflow.md` for a concise execution checklist.
- Read `references/artifacts.md` for the run directory contract and expected artifact outputs.
