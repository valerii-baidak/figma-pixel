# figma-pixel

`figma-pixel` is an OpenClaw skill for turning Figma layouts into real front-end pages and bringing existing implementations closer to the original design.

Use it when you need to:
- build a page from a Figma mockup
- compare an existing page with a Figma frame
- find and fix visual differences between design and implementation
- improve layout, spacing, typography, and overall structure

## Required environment

- `FIGMA_TOKEN`

You need a Figma personal access token for this skill to work.

How to create a Figma token:
- https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens

If Chromium system libraries are missing on Linux, install them with:

```bash
apt-get update && apt-get install -y libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 libgtk-3-0
```

Main packages used by the skill:
- `playwright`
- `backstopjs`
- `pixelmatch`
- `pngjs`

Repository:
- https://github.com/valerii-baidak/figma-pixel
