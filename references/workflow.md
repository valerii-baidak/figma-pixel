# Workflow checklist

## Trigger

Use this skill when:
- the user shares a Figma URL
- and asks to build, restyle, compare, match, or tighten layout to that design
- including short prompts like `build this`, `make this`, `match this`, `recreate this`, `implement this`, or `implement this design`

## Execution order

1. Read Figma source
2. Fetch or identify the correct reference frame/image
3. Create a dedicated run folder with `scripts/init-run-dir.cjs`
4. Choose the most stable serving path for the implementation
5. Capture the rendered page with Playwright
6. Run Backstop if available
7. Run pixelmatch as fallback or confirmation
8. Apply visible layout fixes
9. Re-run comparison
10. Report mismatch, artifacts, and blockers
11. Ask whether to clean up `figma-pixel-runs/<project-slug>/` working files

## Priorities

Write every artifact into `figma-pixel-runs/<project-slug>/<run-id>/`.
Reuse shared Figma API/export artifacts from `figma-pixel-runs/<project-slug>/shared/figma/` whenever the same Figma file/node is rerun.

Prefer `scripts/run-pipeline.cjs` as the orchestration entry point for the happy path. It should derive width and height from Figma node bounds, surface viewport fallback clearly when bounds are unavailable, and leave behind `run-manifest.json`, `run-result.json`, and `pipeline-summary.json` at the run root.
Do not create unrelated working files inside the implementation project. Scratch Figma files, temporary exports, and intermediate processing assets should live under the run directory or shared cache, not inside the page/app project.

Fix biggest visible mismatches first:
- section backgrounds
- hero size and heading scale
- missing content columns
- repeated footer/meta rows
- preview panel proportions
- use real Figma-derived crops/screenshots instead of invented preview placeholders
- page ending / extra whitespace
