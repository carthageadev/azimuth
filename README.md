# Azimuth v3.6.0

A pixel art normal map tool based on [Pixel Art Lighter](https://www.moonfell-rpg.com/pixel-lighter.html) by Red Hat Sprite, with a few quality-of-life fixes and a cleaner UI. Thanks to Red Hat Sprite for the original.

MIT License - Copyright (c) 2026 Red Hat Sprite.

## Small changes

- Refreshed flat pixel UI with bundled pixel fonts.
- Cleaner layout, with scrolling kept inside the art viewport.
- Same core logic, presets and lighting math as the original.

## Quick start

```powershell
cd azimuth
npm install
npm run dev      # Vite dev server http://localhost:5173
npm run build    # -> dist/ (open dist/index.html offline)
npm run preview  # preview the build
```

Runs fully offline, with no CDN and no external requests. Fonts are local.

## CLI - agent friendly

Works with Node 18+. Bin `azimuth`, or run `node cli/azimuth.js`.

```bash
# install deps once
npm install

# normal map
node cli/azimuth.js generate-normal --input public/examples/knight.png --output out/normal.png --preset object --strength 100 --json

# light mask
node cli/azimuth.js generate-mask --input public/examples/knight.png --output out/mask.png --floor 20 --cavity 35

# final lit preview
node cli/azimuth.js light --albedo public/examples/knight.png --normal out/normal.png --mask out/mask.png --output out/final.png --height 25 --falloff 70 --power 2.5 --ambient 15

# inspect
node cli/azimuth.js info --input public/examples/knight.png --json
node cli/azimuth.js bg-detect --input public/examples/knight.png --json

# reusable params
node cli/azimuth.js generate-normal --input albedo.png --output n.png --config params.json
```

### JSON outputs (for AI/agents)

Add `--json` to any command. Success returns `{"ok": true, ...}` on stdout with exit `0`.
Error returns exit `1`, plus `{"ok": false, "error": "..."}` when `--json` is set.

`generate-normal` returns: `input, output, w, h, preset, strength, facets, bg, hide`
`light` additionally returns: `settings {view, lightColor, backgroundColor, hide, height, falloff, power, ambient, maskMix}, lightX, lightY`
`info` returns: `path, w, h, transparent, bg (hex), bgRgb`

### Full flag reference

```
generate-normal / generate-mask / light / info / bg-detect

--input / --albedo <png>          (required, unless alias)
--output / --out <png>            (required for generators/light)
--normal <png>  --mask <png>      (light only)
--preset architecture|object|terrain|character
--strength 0..200                 (shape)
--normal-strength 0..300
--edge-width 0..6
--facets 0..100
--merge 0|1
--floor 0..255  --ceiling 0..255  --cavity 0..100   (mask)
--bg auto|#hex|r,g,b  --hide-bg 0|1
--light-color #hex --bg-color auto|#hex
--height 5..200 --falloff 10..200 --power 0..25 --ambient 0..100 --mask-strength 0..100
--light-x <px> --light-y <px>  --view lit|albedo|normal|mask
--config <json-file> --json
```

Example `params.json`:

```json
{
  "preset": "character",
  "strength": 65,
  "facets": 15,
  "bg": "auto"
}
```

## Project layout

```
azimuth/
  index.html              Vite entry
  vite.config.js          base './' for offline use
  package.json            node, bin azimuth
  src/
    main.js               imports style.css + app.js
    app.js                core UI and image logic
    style.css             styles + flat pixel overrides
  cli/
    core.js               pure generate/render logic
    azimuth.js            arg parsing + pngjs read/write
  public/
    fonts/                PressStart2P.ttf, Silkscreen-*.ttf
    examples/             skeleton_albedo.png, knight.png, crate.png
```

## Examples

`public/examples/` includes albedo inputs:

- `skeleton_albedo.png` (250x200) - skeleton demo, same as the original
- `knight.png` (32x32) - knight

Try the full pipeline:

```bash
node cli/azimuth.js generate-normal --input public/examples/skeleton_albedo.png --output out/skeleton_normal.png --preset object --json
node cli/azimuth.js generate-mask --input public/examples/skeleton_albedo.png --output out/skeleton_mask.png --floor 20 --json
node cli/azimuth.js light --albedo public/examples/skeleton_albedo.png --normal out/skeleton_normal.png --mask out/skeleton_mask.png --output out/skeleton_final.png --json
```

## Credits

Inspired by and based on [Pixel Art Lighter](https://www.moonfell-rpg.com/pixel-lighter.html) (c) 2026 Red Hat Sprite, MIT License. Pixel fonts are OFL-licensed Google Fonts (Press Start 2P, Silkscreen), bundled locally.
