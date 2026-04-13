# Setup

Install the skill runtime dependencies during skill installation.

## Primary install step

```bash
cd /path/to/figma-pixel
node scripts/setup.cjs
```

This is the intended install-time setup hook.
If install-time setup was skipped, the runtime scripts may attempt setup automatically as a fallback.

## What it installs

- `playwright`
- `pixelmatch`
- `pngjs`

## Optional diff-region enrichment

This skill now supports an optional Node.js post-processing step.

Preferred runtime for that step:
- `node`
- local `pngjs`

If these are missing, the main pipeline still works and falls back to standard `pixelmatch` output.

## Credentials

This skill expects:
- `FIGMA_TOKEN`

Package setup can succeed without it, but Figma API scripts will not work until it is present.

## Notes

- `render-page.cjs` expects `playwright` to be installed.
- `pixelmatch-runner.cjs` expects `pngjs` and `pixelmatch`.
- You may override module resolution with:
  - `PLAYWRIGHT_MODULE_PATH`
  - `PNGJS_MODULE_PATH`
  - `PIXELMATCH_MODULE_PATH`

## Failure reporting

If setup fails, the skill writes:
- `setup-report.json`

Scripts should surface:
- which script triggered setup
- the attempted command
- stdout/stderr
- where to inspect the setup report
