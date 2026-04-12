# Next pipeline step

## Still to finish

- Verify `figma/reference-image.png` export across real files and edge cases
- Make `run-pipeline.cjs` gracefully skip Backstop when no reference image exists
- Feed top mismatches into `generate-layout-report.cjs`
- Add a more explicit final manifest for the whole run

## Current state

The run contract and main pipeline skeleton are now in place.
The next important milestone is making the Figma reference image generation fully automatic.
