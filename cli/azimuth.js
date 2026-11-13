// Azimuth - command-line tools for headless use (MIT Red Hat Sprite)
// Usage:
//   azimuth generate-normal --input albedo.png --output normal.png [options]
//   azimuth generate-mask   --input albedo.png --output mask.png [options]
//   azimuth light           --albedo albedo.png [--normal normal.png] [--mask mask.png] --output final.png [options]
//   azimuth info            --input albedo.png [--json]
//   azimuth bg-detect       --input albedo.png
// All commands print JSON to stdout when --json is used.
// Works offline, no server needed. Put this file on PATH or run: node cli/azimuth.js ...

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { generateTexture, prepareTextures, renderPixels, rgb, hex, presetDefaults, detectBackground, hasTransparency } from './core.js';

function parseArgs(argv) {
  const args = { _: [] };
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { json = true; continue; }
    if (a.startsWith('--config')) { args.config = argv[++i]; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-/g, '_');
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true; // boolean flag
      } else {
        // keep raw string, coerce later
        args[key] = next;
        i++;
      }
    } else args._.push(a);
  }
  args.json = json;
  // config file merge (config may be JSON path or stringified JSON)
  if (args.config) {
    try {
      const raw = fs.readFileSync(args.config, 'utf8');
      const cfg = JSON.parse(raw);
      for (const [k, v] of Object.entries(cfg)) {
        const kk = k.replace(/-/g, '_');
        if (args[kk] === undefined) args[kk] = v;
      }
    } catch (e) { throw new Error(`Cannot read config ${args.config}: ${e.message}`); }
  }
  return args;
}

function readPNG(p) {
  const buf = fs.readFileSync(p);
  const png = PNG.sync.read(buf);
  return { w: png.width, h: png.height, data: png.data };
}
function writePNG(p, img) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const png = new PNG({ width: img.w, height: img.h });
  png.data.set(img.data);
  fs.writeFileSync(p, PNG.sync.write(png));
}

function num(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function bool(v, def=false) {
  if (v === undefined) return def;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return !!v;
  if (typeof v === 'string') return !['0','false','no','off',''].includes(v.toLowerCase());
  return !!v;
}
function printHelp() {
  console.log(`Azimuth v3.6.0 - CLI (offline, MIT)

Commands:
  generate-normal  --input albedo.png --output normal.png [options]
  generate-mask    --input albedo.png --output mask.png [options]
  light            --albedo albedo.png [--normal n.png] [--mask m.png] --output final.png [options]
  info             --input albedo.png
  bg-detect        --input albedo.png

Generate options (normal):
  --preset architecture|object|terrain|character  (default object)
  --strength 0..200  (default 100, object)
  --normal-strength 0..300 (default 100)
  --edge-width 0..6 (default 3, architecture 1)
  --facets 0..100 (default per preset)
  --merge 0|1 true|false (default true)
  --bg "#2b7ca7" | "auto" | "r,g,b"  (default auto)
  --hide-bg 0|1 (default true unless transparent)
  --floor/--ceiling/--cavity only for mask

Lighting options (light):
  --light-color #ffffff
  --bg-color #2b7ca7 | auto
  --hide-bg 1 (default true)
  --height 25  --falloff 70  --power 2.5  --ambient 15  --mask-strength 100
  --light-x / --light-y  (default center)
  --view lit|albedo|normal|mask (default lit)

Headless use:
  - Add --json for machine-readable output.
  - Add --config params.json for reusable settings.
  - Exit codes: 0 ok, 1 usage/error. See README for JSON schemas.
`);
}

function applyPresetDefaults(opts, kind) {
  // kind: 'normal' | 'mask'
  const preset = (opts.preset || opts.gen_preset || 'object').toLowerCase();
  const defaults = presetDefaults[preset] || presetDefaults.object;
  if (kind === 'normal') {
    opts.strength = num(opts.strength, defaults.strength);
    opts.facets = num(opts.facets, defaults.facets);
    opts.normal_strength = num(opts.normal_strength, num(opts.normalStrength, 100));
    opts.edge_width = num(opts.edge_width, num(opts.edgeWidth, preset === 'architecture' ? 1 : 3));
    opts.merge = bool(opts.merge, true);
  } else if (kind === 'mask') {
    opts.strength = num(opts.strength, 100);
    opts.floor = num(opts.floor, defaults.floor);
    opts.ceiling = num(opts.ceiling, defaults.ceiling ?? 255);
    opts.cavity = num(opts.cavity, defaults.cavity);
  }
  opts.preset = preset;
  return opts;
}

function resolveBg(inputImg, opts) {
  const bgOpt = opts.bg || opts.bg_color || opts.bgColor || 'auto';
  const hide = bool(opts.hide_bg ?? opts.hideBg ?? opts.hide, true) && !hasTransparency(inputImg);
  let bg = null;
  if (bgOpt === 'auto') {
    bg = detectBackground(inputImg) || [43, 124, 167];
  } else if (typeof bgOpt === 'string' && bgOpt.startsWith('#')) {
    bg = rgb(bgOpt);
  } else if (typeof bgOpt === 'string' && bgOpt.includes(',')) {
    bg = bgOpt.split(',').map(Number);
  } else if (Array.isArray(bgOpt)) {
    bg = bgOpt;
  } else {
    bg = detectBackground(inputImg) || [43, 124, 167];
  }
  return { bg, hide: hide && bg !== null };
}

function toGenerateOptions(kind, img, opts) {
  opts = applyPresetDefaults({ ...opts }, kind);
  const { bg, hide } = resolveBg(img, opts);
  const base = {
    kind,
    preset: opts.preset,
    strength: opts.strength,
    normalStrength: opts.normal_strength,
    edgeWidth: opts.edge_width,
    facets: opts.facets,
    floor: opts.floor,
    ceiling: opts.ceiling,
    cavity: opts.cavity,
    merge: opts.merge,
    bg,
    hide,
    hints: null,
  };
  return base;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (!args._.length || args._[0] === '--help' || args._[0] === 'help' || args._[0] === '-h') {
    printHelp();
    return;
  }
  const cmd = args._[0].toLowerCase().replace(/_/g, '-');
  const out = (obj) => {
    if (args.json) console.log(JSON.stringify(obj, null, 2));
    else console.log(obj.message || JSON.stringify(obj));
  };

  if (cmd === 'generate-normal' || cmd === 'generate') {
    const input = args.input || args.albedo;
    const output = args.output || args.out;
    if (!input || !output) throw new Error('generate-normal requires --input albedo.png --output normal.png');
    const img = readPNG(input);
    const genOpts = toGenerateOptions('normal', img, args);
    const res = generateTexture(img, genOpts);
    writePNG(output, res);
    out({ ok: true, command: cmd, input, output, w: res.w, h: res.h, preset: genOpts.preset, strength: genOpts.strength, facets: genOpts.facets, bg: genOpts.bg, hide: genOpts.hide, message: `normal_map written: ${output} (${res.w}x${res.h})` });
  } else if (cmd === 'generate-mask' || cmd === 'gen-mask') {
    const input = args.input || args.albedo;
    const output = args.output || args.out;
    if (!input || !output) throw new Error('generate-mask requires --input albedo.png --output mask.png');
    const img = readPNG(input);
    const genOpts = toGenerateOptions('mask', img, args);
    const res = generateTexture(img, genOpts);
    writePNG(output, res);
    out({ ok: true, command: cmd, input, output, w: res.w, h: res.h, strength: genOpts.strength, floor: genOpts.floor, ceiling: genOpts.ceiling, cavity: genOpts.cavity, message: `light_mask written: ${output}` });
  } else if (cmd === 'light' || cmd === 'preview' || cmd === 'render') {
    const albedoPath = args.albedo || args.input;
    const output = args.output || args.out;
    if (!albedoPath || !output) throw new Error('light requires --albedo albedo.png --output final.png');
    const albedo = readPNG(albedoPath);
    const normal = args.normal ? readPNG(args.normal) : null;
    const mask = args.mask ? readPNG(args.mask) : null;
    const { albedoLinear, normals } = prepareTextures(albedo, normal);
    const W = albedo.w, H = albedo.h;
    const outData = new Uint8ClampedArray(W * H * 4);
    const bgOpt = args.bg_color || args.bgColor || args.bg || 'auto';
    let backgroundColor = args.bg_color || args.bgColor || '#2b7ca7';
    if (bgOpt === 'auto' || backgroundColor === 'auto') {
      const det = detectBackground(albedo);
      if (det) backgroundColor = hex(det);
    } else if (typeof bgOpt === 'string' && bgOpt.includes(',')) {
      backgroundColor = hex(bgOpt.split(',').map(Number));
    }
    const settings = {
      view: args.view || 'lit',
      lightColor: args.light_color || args.lightColor || '#ffffff',
      backgroundColor,
      hide: bool(args.hide_bg ?? args.hideBg ?? args.hide, true),
      height: num(args.height, 25),
      falloff: num(args.falloff, 70),
      power: num(args.power, 2.5),
      ambient: num(args.ambient, 15) / 100,
      maskMix: num(args.mask_strength ?? args.maskStrength, 100) / 100,
    };
    const lightX = num(args.light_x ?? args.lightX, W / 2);
    const lightY = num(args.light_y ?? args.lightY, H / 2);
    renderPixels(outData, { width: W, height: H, albedo, normal, mask, normals, albedoLinear, lightX, lightY }, settings);
    writePNG(output, { w: W, h: H, data: outData });
    out({ ok: true, command: cmd, albedo: albedoPath, output, w: W, h: H, settings, lightX, lightY, message: `lit_preview written: ${output}` });
  } else if (cmd === 'info') {
    const input = args.input || args.albedo;
    if (!input) throw new Error('info requires --input file.png');
    const img = readPNG(input);
    const bg = detectBackground(img);
    const transparent = hasTransparency(img);
    const info = { ok: true, path: input, w: img.w, h: img.h, transparent, bg: bg ? hex(bg) : null, bgRgb: bg, uniqueBorderColors: true };
    out(info);
  } else if (cmd === 'bg-detect' || cmd === 'detect-bg') {
    const input = args.input || args.albedo;
    if (!input) throw new Error('bg-detect requires --input file.png');
    const img = readPNG(input);
    const bg = detectBackground(img);
    out({ ok: true, path: input, bgHex: bg ? hex(bg) : null, bgRgb: bg });
  } else {
    printHelp();
    throw new Error(`unknown command: ${cmd}`);
  }
}

main().catch((e) => {
  const json = process.argv.includes('--json');
  if (json) console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  else console.error('error:', e.message);
  process.exit(1);
});
