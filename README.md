# figma-pixel

`figma-pixel` is an OpenClaw skill for turning Figma layouts into real front-end pages and bringing existing implementations closer to the original design.

Use it when you need to:
- build a page from a Figma mockup
- compare an existing page with a Figma frame
- find and fix visual differences between design and implementation
- improve layout, spacing, typography, and overall structure

## Required environment

- `FIGMA_TOKEN`
- host-installed Node.js packages: `playwright`, `pixelmatch`, `pngjs`
- a Chromium-compatible browser executable

You need a Figma personal access token for this skill to work.
The runtime reads `FIGMA_TOKEN` only to call the official Figma API for file metadata and image export. The token is not written to artifacts or logs.

Install the required packages before using the skill:

```bash
npm install playwright pixelmatch pngjs @techstark/opencv-js
npx playwright install chromium
```

On Linux, Chromium may also require system libraries:

```bash
apt-get update && apt-get install -y libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 libgtk-3-0
```

Without these packages, system libraries, and a working browser executable, the skill will not work fully.
Rendering, image diffing, or diff-region analysis may fail immediately depending on what is missing.

How to create a Figma token:
- https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens

Main packages used by the skill:
- `playwright`
- `pixelmatch`
- `pngjs`
- `@techstark/opencv-js`

Security notes:
- The skill does not install dependencies from inside the package.
- Runtime scripts fail with explicit prerequisite errors when dependencies are missing.
- Figma responses are stored locally as run artifacts for comparison and debugging.
- Exported image URLs returned by Figma are not persisted to stdout artifacts.

Repository:
- https://github.com/valerii-baidak/figma-pixel
