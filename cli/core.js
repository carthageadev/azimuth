// Azimuth - core image logic (MIT, Red Hat Sprite 2026)
// Extracted verbatim from v3.6.0 single-file tool. Pure JS, no DOM.

export const linear = (v) => {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
export const srgb = (v) =>
  Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));

export function rgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}
export function hex(v) {
  return "#" + v.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
}

export const presetDefaults = {
  architecture: { strength: 100, facets: 20, floor: 30, cavity: 25 },
  object: { strength: 100, facets: 35, floor: 20, ceiling: 255, cavity: 35 },
  terrain: { strength: 110, facets: 50, floor: 35, cavity: 20 },
  character: { strength: 65, facets: 15, floor: 30, cavity: 20 },
};

export function generateTexture(albedo, options) {
  const w = albedo.w, h = albedo.h, N = w * h, a = albedo.data;
  const fg = new Uint8Array(N), lum = new Float32Array(N), labels = new Int32Array(N);
  labels.fill(-1);
  const bg = options.bg, hide = options.hide;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < N; i++) {
    const k = i * 4;
    fg[i] = a[k + 3] > 0 && !(hide && a[k] === bg[0] && a[k + 1] === bg[1] && a[k + 2] === bg[2]) ? 1 : 0;
    lum[i] = (0.2126 * a[k] + 0.7152 * a[k + 1] + 0.0722 * a[k + 2]) / 255;
    if (fg[i]) { lo = Math.min(lo, lum[i]); hi = Math.max(hi, lum[i]); }
  }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  const adjacent = (i) => {
    const x = i % w, y = (i / w) | 0, out = [];
    if (x) out.push(i - 1);
    if (x < w - 1) out.push(i + 1);
    if (y) out.push(i - w);
    if (y < h - 1) out.push(i + w);
    return out;
  };
  const queue = new Int32Array(N), clusters = [];
  for (let i = 0; i < N; i++) if (fg[i] && labels[i] < 0) {
    let head = 0, tail = 1;
    queue[0] = i;
    const id = clusters.length, pixels = [], k = i * 4;
    labels[i] = id;
    while (head < tail) {
      const p = queue[head++];
      pixels.push(p);
      for (const n of adjacent(p))
        if (fg[n] && labels[n] < 0 && a[n * 4] === a[k] && a[n * 4 + 1] === a[k + 1] && a[n * 4 + 2] === a[k + 2]) {
          labels[n] = id; queue[tail++] = n;
        }
    }
    clusters.push({ pixels, value: lum[i] });
  }
  const distance = new Float32Array(N); distance.fill(N);
  let head = 0, tail = 0;
  for (let i = 0; i < N; i++)
    if (fg[i] && (i % w === 0 || i % w === w - 1 || i < w || i >= N - w || adjacent(i).some((n) => !fg[n]))) {
      distance[i] = 1; queue[tail++] = i;
    }
  while (head < tail) {
    const p = queue[head++];
    for (const n of adjacent(p)) if (fg[n] && distance[n] > distance[p] + 1) { distance[n] = distance[p] + 1; queue[tail++] = n; }
  }
  const range = hi - lo, normalized = (i) => (range > 1e-5 ? (lum[i] - lo) / range : 0.75);
  const thin = new Uint8Array(N);
  if (options.merge) {
    for (const cluster of clusters) {
      if (cluster.value > lo + range * 0.24) continue;
      let interior = 0;
      for (const p of cluster.pixels)
        if (adjacent(p).length === 4 && adjacent(p).every((n) => labels[n] === labels[p])) interior++;
      if (interior / Math.max(1, cluster.pixels.length) < 0.15)
        for (const p of cluster.pixels) thin[p] = 1;
    }
  }
  const output = new Uint8ClampedArray(N * 4);
  if (options.kind === "mask") {
    const strength = options.strength / 100, floor = options.floor / 255, cavity = options.cavity / 100;
    for (const cluster of clusters) {
      let value = cluster.value;
      const t = range > 1e-5 ? (value - lo) / range : 0.75;
      let receive = floor + (1 - floor) * Math.pow(t, 1.15);
      let surrounded = 0;
      if (cavity && t < 0.35) {
        for (const p of cluster.pixels) {
          let higher = 0, total = 0;
          for (const n of adjacent(p)) if (fg[n] && labels[n] !== labels[p]) { total++; if (lum[n] > value + range * 0.15) higher++; }
          if (total && higher / total > 0.5) surrounded++;
        }
        receive *= 1 - cavity * Math.min(1, surrounded / Math.max(1, Math.sqrt(cluster.pixels.length)));
      }
      receive = 1 - strength + strength * receive;
      const v = Math.round(255 * Math.max(0, Math.min(options.ceiling / 255, receive)));
      for (const p of cluster.pixels) { output[p * 4] = output[p * 4 + 1] = output[p * 4 + 2] = v; output[p * 4 + 3] = a[p * 4 + 3]; }
    }
  } else {
    const preset = options.preset, scale = options.strength / 100;
    let field = new Float32Array(N);
    for (let i = 0; i < N; i++) if (fg[i]) {
      const convex = Math.sqrt(Math.min(distance[i], preset === "character" ? 8 : 16)) * (preset === "architecture" ? 0 : preset === "terrain" ? 0.12 : 0.65);
      field[i] = convex + normalized(i) * (preset === "architecture" ? 3.5 : preset === "terrain" ? 4 : preset === "character" ? 1.2 : 2.1);
    }
    for (let pass = 0; pass < (options.edgeWidth ?? (preset === "architecture" ? 1 : 3)); pass++) {
      const blurred = new Float32Array(N);
      for (let i = 0; i < N; i++) if (fg[i]) {
        let sum = field[i] * 2, count = 2;
        for (const n of adjacent(i)) if (fg[n]) { sum += field[n]; count++; }
        blurred[i] = sum / count;
      }
      field = blurred;
    }
    const dirs = new Float32Array(N * 3);
    const unit = (v) => { const len = Math.hypot(...v) || 1; return v.map((n) => n / len); };
    const normalGain = (options.normalStrength ?? 100) / 100;
    const quantize = (v) => {
      v = unit(v);
      const tilt = Math.hypot(v[0], v[1]);
      if (tilt < 0.12) return [0, 0, 1];
      const angle = (Math.round(Math.atan2(v[1], v[0]) / (Math.PI / 4)) * Math.PI) / 4;
      const elevation = preset === "architecture" ? Math.min(0.9, 0.6 * scale) : tilt < 0.3 ? 0.24 : tilt < 0.6 ? 0.48 : tilt < 0.85 ? 0.72 : 0.9;
      return [Math.cos(angle) * elevation, Math.sin(angle) * elevation, Math.sqrt(1 - elevation * elevation)];
    };
    for (let i = 0; i < N; i++) if (fg[i]) {
      const x = i % w, y = (i / w) | 0, at = (n) => (n >= 0 && n < N && fg[n] ? field[n] : field[i]);
      const dx = (x < w - 1 ? at(i + 1) : field[i]) - (x ? at(i - 1) : field[i]),
        dy = (y < h - 1 ? at(i + w) : field[i]) - (y ? at(i - w) : field[i]);
      const normal = unit([-dx * scale, dy * scale, 1]);
      dirs.set(normal, i * 3);
    }
    for (const cluster of clusters) {
      let sum = [0, 0, 0];
      for (const p of cluster.pixels) {
        if (preset === "architecture" && Math.hypot(dirs[p * 3], dirs[p * 3 + 1]) < 0.06) continue;
        for (let c = 0; c < 3; c++) sum[c] += dirs[p * 3 + c];
      }
      if (sum[2] === 0) sum = [0, 0, 1];
      const average = unit(sum), groups = new Map();
      const split = options.facets > 0 && cluster.pixels.length >= Math.round(180 - options.facets * 1.1);
      if (split) {
        for (const p of cluster.pixels) {
          const dx = dirs[p * 3], dy = dirs[p * 3 + 1], tilt = Math.hypot(dx, dy);
          const key = tilt > 0.35 ? Math.round(Math.atan2(dy, dx) / (Math.PI / 2)) : 9;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(p);
        }
      }
      const supported = [...groups.values()].filter((g) => g.length >= Math.max(16, cluster.pixels.length * 0.16));
      let allow = false;
      if (supported.length >= 2) {
        const means = supported.map((g) => { const s = [0, 0, 0]; for (const p of g) for (let c = 0; c < 3; c++) s[c] += dirs[p * 3 + c]; return unit(s); });
        for (let i = 0; i < means.length; i++) for (let j = 0; j < i; j++)
          if (means[i].reduce((s, v, c) => s + v * means[j][c], 0) < 0.8 - options.facets * 0.001) allow = true;
      }
      const base = quantize(average);
      for (const p of cluster.pixels) dirs.set(base, p * 3);
      if (allow) for (const g of supported) {
        const sum2 = [0, 0, 0];
        for (const p of g) {
          const x = p % w, y = (p / w) | 0, at = (n) => (n >= 0 && n < N && fg[n] ? field[n] : field[p]);
          const dx = (x < w - 1 ? at(p + 1) : field[p]) - (x ? at(p - 1) : field[p]),
            dy = (y < h - 1 ? at(p + w) : field[p]) - (y ? at(p - w) : field[p]);
          const v = unit([-dx * scale, dy * scale, 1]);
          for (let c = 0; c < 3; c++) sum2[c] += v[c];
        }
        const v = quantize(sum2);
        for (const p of g) dirs.set(v, p * 3);
      }
    }
    if (options.merge) {
      const assigned = new Uint8Array(N);
      head = 0; tail = 0;
      for (let i = 0; i < N; i++) if (fg[i] && !thin[i]) { assigned[i] = 1; queue[tail++] = i; }
      while (head < tail) {
        const p = queue[head++];
        for (const n of adjacent(p)) if (fg[n] && !assigned[n]) { assigned[n] = 1; dirs.set(dirs.subarray(p * 3, p * 3 + 3), n * 3); queue[tail++] = n; }
      }
    }
    const seen = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (fg[i] && !seen[i]) {
      const group = [];
      head = 0; tail = 1; queue[0] = i; seen[i] = 1;
      while (head < tail) {
        const p = queue[head++];
        group.push(p);
        for (const n of adjacent(p))
          if (fg[n] && !seen[n] && Math.abs(dirs[n * 3] - dirs[i * 3]) < 0.001 && Math.abs(dirs[n * 3 + 1] - dirs[i * 3 + 1]) < 0.001) { seen[n] = 1; queue[tail++] = n; }
      }
      if (group.length <= 2) {
        const neighbors = group.flatMap(adjacent).filter((n) => fg[n] && !group.includes(n));
        if (neighbors.length) { const n = neighbors[0]; for (const p of group) dirs.set(dirs.subarray(n * 3, n * 3 + 3), p * 3); }
      }
    }
    for (let i = 0; i < N; i++) {
      const normal = fg[i] ? unit([dirs[i * 3] * normalGain, dirs[i * 3 + 1] * normalGain, dirs[i * 3 + 2]]) : [0, 0, 1];
      for (let c = 0; c < 3; c++) output[i * 4 + c] = Math.round((normal[c] + 1) * 127.5);
      output[i * 4 + 3] = a[i * 4 + 3];
    }
  }
  for (let i = 0; i < N; i++) output[i * 4 + 3] = a[i * 4 + 3];
  return { w, h, data: output };
}

export function prepareTextures(a, normal) {
  const W = a.w, H = a.h;
  const albedoLinear = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) albedoLinear[i * 3 + c] = linear(a.data[i * 4 + c]);
  const normals = new Float32Array(W * H * 3);
  const n = normal, valid = n && n.w === W && n.h === H;
  for (let i = 0; i < W * H; i++) {
    let v = valid ? [(n.data[i * 4] / 255) * 2 - 1, (n.data[i * 4 + 1] / 255) * 2 - 1, (n.data[i * 4 + 2] / 255) * 2 - 1] : [0, 0, 1],
      len = Math.hypot(...v) || 1;
    for (let c = 0; c < 3; c++) normals[i * 3 + c] = v[c] / len;
  }
  return { albedoLinear, normals };
}

export function renderPixels(outData, image, settings) {
  const { width: W, height: H, albedo: a, normal: n, mask: m, normals, albedoLinear, lightX: lx, lightY: ly } = image;
  const view = settings.view;
  const light = rgb(settings.lightColor).map(linear), bg = rgb(settings.backgroundColor),
    { hide, height: z, falloff: radius, power, ambient, maskMix } = settings;
  for (let i = 0; i < W * H; i++) {
    const alpha = hide && a.data[i * 4] === bg[0] && a.data[i * 4 + 1] === bg[1] && a.data[i * 4 + 2] === bg[2] ? 0 : a.data[i * 4 + 3];
    outData[i * 4 + 3] = alpha;
    if (!alpha) continue;
    if (view === "albedo") { for (let c = 0; c < 3; c++) outData[i * 4 + c] = a.data[i * 4 + c]; continue; }
    if (view === "normal") { for (let c = 0; c < 3; c++) outData[i * 4 + c] = n ? n.data[i * 4 + c] : [128, 128, 255][c]; continue; }
    const mask = m ? (0.2126 * m.data[i * 4] + 0.7152 * m.data[i * 4 + 1] + 0.0722 * m.data[i * 4 + 2]) / 255 : 1;
    if (view === "mask") { for (let c = 0; c < 3; c++) outData[i * 4 + c] = Math.round(mask * 255); continue; }
    const x = i % W, y = Math.floor(i / W), dx = lx - x, dy = y - ly,
      d = Math.max(0.000001, Math.hypot(dx, dy, z)),
      diffuse = Math.max(0, (normals[i * 3] * dx + normals[i * 3 + 1] * dy + normals[i * 3 + 2] * z) / d),
      atten = 1 / (1 + (d / Math.max(0.000001, radius)) ** 2),
      direct = power * diffuse * atten * (1 - maskMix + maskMix * mask);
    for (let c = 0; c < 3; c++) {
      const base = albedoLinear[i * 3 + c];
      outData[i * 4 + c] = Math.min(255, Math.max(0, srgb(base * (ambient + direct * light[c]))));
    }
  }
  return outData;
}

export function detectBackground(image) {
  const counts = new Map();
  const take = (x, y) => {
    const i = (y * image.w + x) * 4;
    if (image.data[i + 3] !== 255) return;
    const key = image.data[i] + "," + image.data[i + 1] + "," + image.data[i + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (let x = 0; x < image.w; x++) { take(x, 0); take(x, image.h - 1); }
  for (let y = 1; y < image.h - 1; y++) { take(0, y); take(image.w - 1, y); }
  if (!counts.size) return null;
  return [...counts].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
}

export function hasTransparency(image) {
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] < 255) return true;
  return false;
}
