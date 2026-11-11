
      (() => {
    "use strict";

    function createApplicationState() {
      return {
        textures: { albedo: null, normal: null, mask: null },
        width: 250,
        height: 200,
        light: { x: 125, y: 100 },
        render: { normals: null, albedoLinear: null },
        lighting: { overrides: {}, settings: null },
        edit: { session: null, hints: null, undo: [], redo: [] },
      };
    }

    function createImageProcessor() {
      const linear = (v) => {
          v /= 255;
          return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        },
        srgb = (v) =>
          Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));

      function rgb(hex) {
        return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      }

      function hex(v) {
        return "#" + v.map((x) => x.toString(16).padStart(2, "0")).join("");
      }

      function copyHints(source) {
        return {
          ...source,
          surfaces: source.surfaces.slice(),
          light: source.light.slice(),
          mergedOutline: source.mergedOutline?.slice(),
          groups: source.groups.map((group) => ({ ...group })),
        };
      }

      function createHints(w, h, selectionColor) {
        return {
          w,
          h,
          surfaces: new Uint16Array(w * h),
          light: new Uint8Array(w * h),
          groups: [{ id: 1, direction: "none", tilt: 45 }],
          brightness: 0,
          relativeBrightness: true,
          selectionColor,
        };
      }

      function applySurfaceHints(output, foreground, hints, kind, gain = 1) {
        if (!hints) return output;
        const N = foreground.length;
        if (kind === "mask") {
          const value = Math.round((255 * (hints.brightness ?? 100)) / 100);
          for (let p = 0; p < N; p++)
            if (foreground[p] && hints.light[p]) {
              const original =
                  0.2126 * output[p * 4] +
                  0.7152 * output[p * 4 + 1] +
                  0.0722 * output[p * 4 + 2],
                v = hints.relativeBrightness
                  ? Math.round(
                      Math.max(0, Math.min(255, original + (255 * hints.brightness) / 100)),
                    )
                  : value;
              output[p * 4] = output[p * 4 + 1] = output[p * 4 + 2] = v;
            }
          return output;
        }
        for (const group of hints.groups) {
          if (!group.direction || group.direction === "none") continue;
          if (group.direction === "existing") {
            const delta = ((group.tilt - group.baseTilt) * Math.PI) / 180;
            for (let p = 0; p < N; p++)
              if (foreground[p] && hints.surfaces[p] === group.id) {
                const v = [0, 1, 2].map((c) => (output[p * 4 + c] / 255) * 2 - 1),
                  len = Math.hypot(...v) || 1,
                  angle = Math.atan2(v[1], v[0]),
                  tilt = Math.max(
                    0,
                    Math.min(
                      Math.PI / 2,
                      Math.acos(Math.max(-1, Math.min(1, v[2] / len))) + delta,
                    ),
                  ),
                  normal = [
                    Math.cos(angle) * Math.sin(tilt),
                    Math.sin(angle) * Math.sin(tilt),
                    Math.cos(tilt),
                  ];
                for (let c = 0; c < 3; c++)
                  output[p * 4 + c] = Math.round((normal[c] + 1) * 127.5);
              }
            continue;
          }
          const sum = [0, 0, 0];
          let count = 0;
          if (group.direction === "auto" || group.direction === "facet") {
            if (group.average) {
              const angle = Math.atan2(group.average[1], group.average[0]),
                tilt = (group.tilt * Math.PI) / 180;
              sum[0] = Math.cos(angle) * Math.sin(tilt);
              sum[1] = Math.sin(angle) * Math.sin(tilt);
              sum[2] = Math.cos(tilt);
            } else
              for (let p = 0; p < N; p++)
                if (foreground[p] && hints.surfaces[p] === group.id) {
                  for (let c = 0; c < 3; c++) sum[c] += (output[p * 4 + c] / 255) * 2 - 1;
                  count++;
                }
          } else {
            const tilt = group.direction === "front" ? 0 : (group.tilt * Math.PI) / 180,
              s = Math.sin(tilt) * gain;
            const direction = group.direction,
              diagonal = direction.includes("-"),
              factor = diagonal ? Math.SQRT1_2 : 1;
            sum[0] =
              (direction.includes("left") ? -s : direction.includes("right") ? s : 0) * factor;
            sum[1] =
              (direction.includes("up") ? s : direction.includes("down") ? -s : 0) * factor;
            sum[2] = Math.cos(tilt);
          }
          const len = Math.hypot(...sum) || 1,
            rgb = sum.map((v) => Math.round((v / len + 1) * 127.5));
          for (let p = 0; p < N; p++)
            if (foreground[p] && hints.surfaces[p] === group.id)
              for (let c = 0; c < 3; c++) output[p * 4 + c] = rgb[c];
        }
        return output;
      }

      function generateTexture(albedo, options) {
        const w = albedo.w,
          h = albedo.h,
          N = w * h,
          a = albedo.data,
          fg = new Uint8Array(N),
          lum = new Float32Array(N),
          labels = new Int32Array(N);
        labels.fill(-1);
        const bg = options.bg,
          hide = options.hide;
        let lo = Infinity,
          hi = -Infinity;
        for (let i = 0; i < N; i++) {
          const k = i * 4;
          fg[i] =
            a[k + 3] > 0 && !(hide && a[k] === bg[0] && a[k + 1] === bg[1] && a[k + 2] === bg[2]);
          lum[i] = (0.2126 * a[k] + 0.7152 * a[k + 1] + 0.0722 * a[k + 2]) / 255;
          if (fg[i]) {
            lo = Math.min(lo, lum[i]);
            hi = Math.max(hi, lum[i]);
          }
        }
        const adjacent = (i) => {
          const x = i % w,
            y = (i / w) | 0,
            out = [];
          if (x) out.push(i - 1);
          if (x < w - 1) out.push(i + 1);
          if (y) out.push(i - w);
          if (y < h - 1) out.push(i + w);
          return out;
        };
        const queue = new Int32Array(N),
          clusters = [];
        for (let i = 0; i < N; i++)
          if (fg[i] && labels[i] < 0) {
            let head = 0,
              tail = 1;
            queue[0] = i;
            const id = clusters.length,
              pixels = [],
              k = i * 4;
            labels[i] = id;
            while (head < tail) {
              const p = queue[head++];
              pixels.push(p);
              for (const n of adjacent(p))
                if (
                  fg[n] &&
                  labels[n] < 0 &&
                  a[n * 4] === a[k] &&
                  a[n * 4 + 1] === a[k + 1] &&
                  a[n * 4 + 2] === a[k + 2]
                ) {
                  labels[n] = id;
                  queue[tail++] = n;
                }
            }
            clusters.push({ pixels, value: lum[i] });
          }
        const distance = new Float32Array(N);
        distance.fill(N);
        let head = 0,
          tail = 0;
        for (let i = 0; i < N; i++)
          if (
            fg[i] &&
            (i % w === 0 ||
              i % w === w - 1 ||
              i < w ||
              i >= N - w ||
              adjacent(i).some((n) => !fg[n]))
          ) {
            distance[i] = 1;
            queue[tail++] = i;
          }
        while (head < tail) {
          const p = queue[head++];
          for (const n of adjacent(p))
            if (fg[n] && distance[n] > distance[p] + 1) {
              distance[n] = distance[p] + 1;
              queue[tail++] = n;
            }
        }
        const range = hi - lo,
          normalized = (i) => (range > 1e-5 ? (lum[i] - lo) / range : 0.75);
        const thin = new Uint8Array(N);
        if (options.merge) {
          for (const cluster of clusters) {
            if (cluster.value > lo + range * 0.24) continue;
            let interior = 0;
            for (const p of cluster.pixels)
              if (adjacent(p).length === 4 && adjacent(p).every((n) => labels[n] === labels[p]))
                interior++;
            if (interior / cluster.pixels.length < 0.15)
              for (const p of cluster.pixels) thin[p] = 1;
          }
        }
        const output = new Uint8ClampedArray(N * 4);
        if (options.kind === "mask") {
          const strength = options.strength / 100,
            floor = options.floor / 255,
            cavity = options.cavity / 100;
          for (const cluster of clusters) {
            let value = cluster.value;
            const t = range > 1e-5 ? (value - lo) / range : 0.75;
            let receive = floor + (1 - floor) * Math.pow(t, 1.15);
            let surrounded = 0;
            if (cavity && t < 0.35) {
              for (const p of cluster.pixels) {
                let higher = 0,
                  total = 0;
                for (const n of adjacent(p))
                  if (fg[n] && labels[n] !== labels[p]) {
                    total++;
                    if (lum[n] > value + range * 0.15) higher++;
                  }
                if (total && higher / total > 0.5) surrounded++;
              }
              receive *=
                1 -
                cavity * Math.min(1, surrounded / Math.max(1, Math.sqrt(cluster.pixels.length)));
            }
            receive = 1 - strength + strength * receive;
            const v = Math.round(255 * Math.max(0, Math.min(options.ceiling / 255, receive)));
            for (const p of cluster.pixels) {
              output[p * 4] = output[p * 4 + 1] = output[p * 4 + 2] = v;
              output[p * 4 + 3] = a[p * 4 + 3];
            }
          }
        } else {
          const preset = options.preset,
            scale = options.strength / 100;
          let field = new Float32Array(N);
          for (let i = 0; i < N; i++)
            if (fg[i]) {
              const convex =
                Math.sqrt(Math.min(distance[i], preset === "character" ? 8 : 16)) *
                (preset === "architecture" ? 0 : preset === "terrain" ? 0.12 : 0.65);
              field[i] =
                convex +
                normalized(i) *
                  (preset === "architecture"
                    ? 3.5
                    : preset === "terrain"
                      ? 4
                      : preset === "character"
                        ? 1.2
                        : 2.1);
            }
          for (
            let pass = 0;
            pass < (options.edgeWidth ?? (preset === "architecture" ? 1 : 3));
            pass++
          ) {
            const blurred = new Float32Array(N);
            for (let i = 0; i < N; i++)
              if (fg[i]) {
                let sum = field[i] * 2,
                  count = 2;
                for (const n of adjacent(i))
                  if (fg[n]) {
                    sum += field[n];
                    count++;
                  }
                blurred[i] = sum / count;
              }
            field = blurred;
          }
          const dirs = new Float32Array(N * 3);
          const unit = (v) => {
            const len = Math.hypot(...v) || 1;
            return v.map((n) => n / len);
          };
          const normalGain = (options.normalStrength ?? 100) / 100;
          const quantize = (v) => {
            v = unit(v);
            const tilt = Math.hypot(v[0], v[1]);
            if (tilt < 0.12) return [0, 0, 1];
            const angle = (Math.round(Math.atan2(v[1], v[0]) / (Math.PI / 4)) * Math.PI) / 4;
            const elevation =
              preset === "architecture"
                ? Math.min(0.9, 0.6 * scale)
                : tilt < 0.3
                  ? 0.24
                  : tilt < 0.6
                    ? 0.48
                    : tilt < 0.85
                      ? 0.72
                      : 0.9;
            return [
              Math.cos(angle) * elevation,
              Math.sin(angle) * elevation,
              Math.sqrt(1 - elevation * elevation),
            ];
          };
          for (let i = 0; i < N; i++)
            if (fg[i]) {
              const x = i % w,
                y = (i / w) | 0,
                at = (n) => (n >= 0 && n < N && fg[n] ? field[n] : field[i]);
              const dx = (x < w - 1 ? at(i + 1) : field[i]) - (x ? at(i - 1) : field[i]),
                dy = (y < h - 1 ? at(i + w) : field[i]) - (y ? at(i - w) : field[i]);
              const normal = unit([-dx * scale, dy * scale, 1]);
              dirs.set(normal, i * 3);
            }
          for (const cluster of clusters) {
            let sum = [0, 0, 0];
            for (const p of cluster.pixels) {
              if (preset === "architecture" && Math.hypot(dirs[p * 3], dirs[p * 3 + 1]) < 0.06)
                continue;
              for (let c = 0; c < 3; c++) sum[c] += dirs[p * 3 + c];
            }
            if (sum[2] === 0) sum = [0, 0, 1];
            const average = unit(sum),
              groups = new Map();
            const split =
              options.facets > 0 &&
              cluster.pixels.length >= Math.round(180 - options.facets * 1.1);
            if (split) {
              for (const p of cluster.pixels) {
                const dx = dirs[p * 3],
                  dy = dirs[p * 3 + 1],
                  tilt = Math.hypot(dx, dy);
                const key = tilt > 0.35 ? Math.round(Math.atan2(dy, dx) / (Math.PI / 2)) : 9;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(p);
              }
            }
            const supported = [...groups.values()].filter(
              (g) => g.length >= Math.max(16, cluster.pixels.length * 0.16),
            );
            let allow = false;
            if (supported.length >= 2) {
              const means = supported.map((g) => {
                const s = [0, 0, 0];
                for (const p of g) for (let c = 0; c < 3; c++) s[c] += dirs[p * 3 + c];
                return unit(s);
              });
              for (let i = 0; i < means.length; i++)
                for (let j = 0; j < i; j++)
                  if (
                    means[i].reduce((s, v, c) => s + v * means[j][c], 0) <
                    0.8 - options.facets * 0.001
                  )
                    allow = true;
            }
            const base = quantize(average);
            for (const p of cluster.pixels) dirs.set(base, p * 3);
            if (allow)
              for (const g of supported) {
                const sum = [0, 0, 0];
                for (const p of g) {
                  const x = p % w,
                    y = (p / w) | 0,
                    at = (n) => (n >= 0 && n < N && fg[n] ? field[n] : field[p]);
                  const dx = (x < w - 1 ? at(p + 1) : field[p]) - (x ? at(p - 1) : field[p]),
                    dy = (y < h - 1 ? at(p + w) : field[p]) - (y ? at(p - w) : field[p]);
                  const v = unit([-dx * scale, dy * scale, 1]);
                  for (let c = 0; c < 3; c++) sum[c] += v[c];
                }
                const v = quantize(sum);
                for (const p of g) dirs.set(v, p * 3);
              }
          }
          if (options.merge) {
            const assigned = new Uint8Array(N);
            head = 0;
            tail = 0;
            for (let i = 0; i < N; i++)
              if (fg[i] && !thin[i]) {
                assigned[i] = 1;
                queue[tail++] = i;
              }
            while (head < tail) {
              const p = queue[head++];
              for (const n of adjacent(p))
                if (fg[n] && !assigned[n]) {
                  assigned[n] = 1;
                  dirs.set(dirs.subarray(p * 3, p * 3 + 3), n * 3);
                  queue[tail++] = n;
                }
            }
          }
          const seen = new Uint8Array(N);
          for (let i = 0; i < N; i++)
            if (fg[i] && !seen[i]) {
              const group = [];
              head = 0;
              tail = 1;
              queue[0] = i;
              seen[i] = 1;
              while (head < tail) {
                const p = queue[head++];
                group.push(p);
                for (const n of adjacent(p))
                  if (
                    fg[n] &&
                    !seen[n] &&
                    Math.abs(dirs[n * 3] - dirs[i * 3]) < 0.001 &&
                    Math.abs(dirs[n * 3 + 1] - dirs[i * 3 + 1]) < 0.001
                  ) {
                    seen[n] = 1;
                    queue[tail++] = n;
                  }
              }
              if (group.length <= 2) {
                const neighbors = group
                  .flatMap(adjacent)
                  .filter((n) => fg[n] && !group.includes(n));
                if (neighbors.length) {
                  const n = neighbors[0];
                  for (const p of group) dirs.set(dirs.subarray(n * 3, n * 3 + 3), p * 3);
                }
              }
            }
          for (let i = 0; i < N; i++) {
            const normal = fg[i]
              ? unit([dirs[i * 3] * normalGain, dirs[i * 3 + 1] * normalGain, dirs[i * 3 + 2]])
              : [0, 0, 1];
            for (let c = 0; c < 3; c++) output[i * 4 + c] = Math.round((normal[c] + 1) * 127.5);
            output[i * 4 + 3] = a[i * 4 + 3];
          }
        }
        for (let i = 0; i < N; i++) output[i * 4 + 3] = a[i * 4 + 3];
        applySurfaceHints(
          output,
          fg,
          options.hints,
          options.kind,
          (options.normalStrength ?? 100) / 100,
        );
        return { w, h, data: output };
      }

      function prepareTextures(a, normal) {
        const W = a.w, H = a.h;
        const albedoLinear = new Float32Array(W * H * 3);
        for (let i = 0; i < W * H; i++)
          for (let c = 0; c < 3; c++) albedoLinear[i * 3 + c] = linear(a.data[i * 4 + c]);
        const normals = new Float32Array(W * H * 3);
        const n = normal,
          valid = n && n.w === W && n.h === H;
        for (let i = 0; i < W * H; i++) {
          let v = valid
              ? [
                  (n.data[i * 4] / 255) * 2 - 1,
                  (n.data[i * 4 + 1] / 255) * 2 - 1,
                  (n.data[i * 4 + 2] / 255) * 2 - 1,
                ]
              : [0, 0, 1],
            len = Math.hypot(...v) || 1;
          for (let c = 0; c < 3; c++) normals[i * 3 + c] = v[c] / len;
        }
        return { albedoLinear, normals };
      }

      function renderPixels(out, image, settings) {
        const { width: W, height: H, albedo: a, normal: n, mask: m, normals, albedoLinear, lightX: lx, lightY: ly } = image;
        const view = settings.view;
        const light = rgb(settings.lightColor).map(linear),
          bg = rgb(settings.backgroundColor),
          { hide, height: z, falloff: radius, power, ambient, maskMix } = settings;
        for (let i = 0; i < W * H; i++) {
          const alpha =
            hide &&
            a.data[i * 4] === bg[0] &&
            a.data[i * 4 + 1] === bg[1] &&
            a.data[i * 4 + 2] === bg[2]
              ? 0
              : a.data[i * 4 + 3];
          out.data[i * 4 + 3] = alpha;
          if (!alpha) continue;
          if (view === "albedo") {
            for (let c = 0; c < 3; c++) out.data[i * 4 + c] = a.data[i * 4 + c];
            continue;
          }
          if (view === "normal") {
            for (let c = 0; c < 3; c++)
              out.data[i * 4 + c] = n ? n.data[i * 4 + c] : [128, 128, 255][c];
            continue;
          }
          const mask = m
            ? (0.2126 * m.data[i * 4] + 0.7152 * m.data[i * 4 + 1] + 0.0722 * m.data[i * 4 + 2]) /
              255
            : 1;
          if (view === "mask") {
            for (let c = 0; c < 3; c++) out.data[i * 4 + c] = Math.round(mask * 255);
            continue;
          }
          const x = i % W,
            y = Math.floor(i / W),
            dx = lx - x,
            dy = y - ly,
            d = Math.max(0.000001, Math.hypot(dx, dy, z)),
            diffuse = Math.max(
              0,
              (normals[i * 3] * dx + normals[i * 3 + 1] * dy + normals[i * 3 + 2] * z) / d,
            ),
            atten = 1 / (1 + (d / Math.max(0.000001, radius)) ** 2),
            direct = power * diffuse * atten * (1 - maskMix + maskMix * mask);
          for (let c = 0; c < 3; c++) {
            const base = albedoLinear[i * 3 + c];
            out.data[i * 4 + c] = Math.min(
              255,
              Math.max(0, srgb(base * (ambient + direct * light[c]))),
            );
          }
        }
        return out;
      }

      const presetDefaults = {
        architecture: { strength: 100, facets: 20, floor: 30, cavity: 25 },
        object: { strength: 100, facets: 35, floor: 20, ceiling: 255, cavity: 35 },
        terrain: { strength: 110, facets: 50, floor: 35, cavity: 20 },
        character: { strength: 65, facets: 15, floor: 30, cavity: 20 },
      };
      return Object.freeze({ linear, srgb, rgb, hex, copyHints, createHints, applySurfaceHints,
        generateTexture, prepareTextures, renderPixels, presetDefaults });
    }

    function createFileAccess() {
      const versions = { albedo: 0, normal: 0, mask: 0 },
        handles = { albedo: null, normal: null, mask: null },
        stamps = { albedo: null, normal: null, mask: null },
        watchErrors = { albedo: null, normal: null, mask: null },
        exportsInProgress = new Set();
      let lastBrowseHandle = null;
      // A stable picker ID remembers the directory in supporting browsers.
      // IndexedDB also retains the latest file handle across page reloads.
      let pickerDB = null;
      try {
        const request = indexedDB.open("azimuth-files", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("locations");
        request.onsuccess = () => {
          pickerDB = request.result;
          const read = pickerDB.transaction("locations").objectStore("locations").get("latest");
          read.onsuccess = () => { if (!lastBrowseHandle) lastBrowseHandle = read.result || null; };
        };
        request.onerror = () => {};
      } catch {}
      function rememberPickerHandle(handle) {
        lastBrowseHandle = handle;
        try { pickerDB?.transaction("locations", "readwrite").objectStore("locations").put(handle, "latest"); } catch {}
      }
      let polling = false;
      const canWatch = typeof window.showOpenFilePicker === "function" && window.isSecureContext;

      function readImage(uri) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            try {
              const c = document.createElement("canvas");
              c.width = img.naturalWidth;
              c.height = img.naturalHeight;
              const x = c.getContext("2d");
              x.drawImage(img, 0, 0);
              resolve({
                w: c.width,
                h: c.height,
                data: x.getImageData(0, 0, c.width, c.height).data,
              });
            } catch (e) {
              reject(e);
            }
          };
          img.onerror = () => reject(Error("Cannot decode this image. Try a PNG file."));
          img.src = uri;
        });
      }
      async function writePNG(handle, blob, verify = false) {
        const writable = await handle.createWritable();
        try {
          await writable.write(blob);
          await writable.close();
        } catch (error) {
          try { await writable.abort(); } catch {}
          throw error;
        }
        if (!verify) return;
        const saved = await handle.getFile();
        const expected = new Uint8Array(await blob.arrayBuffer());
        const actual = new Uint8Array(await saved.arrayBuffer());
        if (expected.length !== actual.length || expected.some((value, i) => value !== actual[i]))
          throw Error("Saved PNG did not update correctly. Try saving again or choose another location.");
      }
      async function pollFiles(callbacks) {
        if (callbacks.isPaused() || exportsInProgress.size || polling || !canWatch)
          return;
        polling = true;
        try {
          for (const kind of ["albedo", "normal", "mask"]) {
            const handle = handles[kind];
            if (!handle) continue;
            try {
              if (
                handle.queryPermission &&
                (await handle.queryPermission({ mode: "read" })) !== "granted"
              ) {
                watchErrors[kind] = "reopen the file to allow reading";
                continue;
              }
              const file = await handle.getFile();
              if (handles[kind] !== handle || exportsInProgress.has(kind)) continue;
              const stamp = file.lastModified + ":" + file.size;
              if (stamp !== stamps[kind]) {
                const ok = await callbacks.onChanged(kind, file, false);
                if (handles[kind] !== handle || exportsInProgress.has(kind)) continue;
                if (ok) {
                  stamps[kind] = stamp;
                  watchErrors[kind] = null;
                } else watchErrors[kind] = "save still in progress; retrying";
              } else watchErrors[kind] = null;
            } catch (e) {
              watchErrors[kind] = "cannot read file; retrying, or Browse again";
            }
          }
        } finally {
          polling = false;
          callbacks.onStatus();
        }
      }
      async function pickPNG() {
        const picked = await window.showOpenFilePicker({
          id: "azimuth-files",
          ...(lastBrowseHandle ? { startIn: lastBrowseHandle } : {}),
          multiple: false,
          excludeAcceptAllOption: true,
          types: [{ description: "PNG textures", accept: { "image/png": [".png"] } }],
        });
        rememberPickerHandle(picked[0]);
        return picked[0];
      }
      async function pickSavePNG(filename) {
        if (typeof window.showSaveFilePicker !== "function") return null;
        return window.showSaveFilePicker({
          id: "azimuth-files",
          ...(lastBrowseHandle ? { startIn: lastBrowseHandle } : {}),
          suggestedName: filename,
          types: [{ description: "PNG image", accept: { "image/png": [".png"] } }],
        });
      }
      async function withPNG(file, onURL) {
        if (!/\.png$/i.test(file.name)) throw Error("Choose a PNG texture file.");
        const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
        if (signature.length !== 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => signature[i] === value))
          throw Error("This file is not a valid PNG.");
        const uri = URL.createObjectURL(file);
        try { return await onURL(uri); }
        finally { URL.revokeObjectURL(uri); }
      }
      function startWatching(callbacks) {
        if (!canWatch) return;
        const poll = () => pollFiles(callbacks);
        setInterval(poll, 1000);
        window.addEventListener("focus", poll);
        document.addEventListener("visibilitychange", poll);
      }
      async function exportPNG(image, filename, { verify = false, onHandle = () => {} } = {}) {
        // Snapshot before opening the asynchronous picker.
        const width = image.w ?? image.width, height = image.h ?? image.height;
        const pixels = new Uint8ClampedArray(image.data);
        const handle = await pickSavePNG(filename);
        const output = document.createElement("canvas");
        output.width = width;
        output.height = height;
        output.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
        const blob = await new Promise((resolve) => output.toBlob(resolve, "image/png"));
        if (!blob) throw Error("Could not create PNG.");
        if (handle) {
          rememberPickerHandle(handle);
          onHandle(handle);
          await writePNG(handle, blob, verify);
        } else {
          const uri = URL.createObjectURL(blob), link = document.createElement("a");
          link.href = uri;
          link.download = filename;
          link.click();
          setTimeout(() => URL.revokeObjectURL(uri), 1000);
        }
        return handle;
      }
      return Object.freeze({ versions, handles, stamps, errors: watchErrors, saving: exportsInProgress,
        canWatch, readImage, pickPNG, exportPNG, withPNG, startWatching });
    }

    function createUIControls() {
      const $ = (id) => document.getElementById(id);

      function syncRange(input) {
        if (input.type !== "range" || input.id === "picker-hue") return;
        const min = input.min === "" ? 0 : Number(input.min);
        const max = input.max === "" ? 100 : Number(input.max);
        const ratio = max > min ? Math.min(1, Math.max(0, (Number(input.value) - min) / (max - min))) : 0;
        input.style.setProperty("--slider-fill", `calc(${ratio * 100}% + ${5.5 - 11 * ratio}px)`);
      }
      function setRangeValue(id, value) {
        const input = typeof id === "string" ? $(id) : id;
        input.value = String(value);
        syncRange(input);
      }
      document.addEventListener("input", (event) => {
        if (event.target instanceof HTMLInputElement) syncRange(event.target);
      });
      document.querySelectorAll('input[type="range"]').forEach(syncRange);
      function reportIssue(message) {
        console.warn("Azimuth: " + message);
      }
      function shortcutModalOpen() {
        return !$("art-color-picker").hidden || $("tool-info-dialog").open || $("texture-mismatch").open;
      }
      function shortcutContextBlocked(target) {
        return shortcutTextEntry(target) || shortcutModalOpen();
      }
      const shortcutHandlers = [];
      function onShortcut(handler) {
        if (!shortcutHandlers.length) {
          document.addEventListener("keydown", (event) => {
            for (const shortcut of shortcutHandlers) shortcut(event);
          });
        }
        shortcutHandlers.push(handler);
      }
      function shortcutTextEntry(target) {
        return !!target.closest('textarea,[contenteditable]:not([contenteditable="false"]),input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="color"]):not([type="file"])');
      }

      function setTextureInfo(kind, name, size = null) {
        const node = $(kind + "-info");
        node.dataset.name = name;
        if (!size) {
          delete node.dataset.width;
          delete node.dataset.height;
          node.textContent = name;
          return;
        }
        node.dataset.width = String(size.w);
        node.dataset.height = String(size.h);
        const filename = document.createElement("span");
        filename.className = "texture-filename";
        filename.textContent = name;
        filename.dataset.tooltip = name;
        const resolution = document.createElement("span");
        resolution.className = "texture-resolution";
        resolution.textContent = size.w + " x " + size.h;
        node.replaceChildren(filename, resolution);
      }
      function textureInfoSnapshot(kind) {
        const node = $(kind + "-info");
        return {
          name: node.dataset.name ?? node.textContent,
          size: node.dataset.width ? { w: Number(node.dataset.width), h: Number(node.dataset.height) } : null,
        };
      }
      function readLighting(readNumber) {
        return {
          lightColor: $("light-color").value,
          backgroundColor: $("bg-color").value,
          hide: $("hide-bg").checked,
          height: readNumber("height"),
          falloff: readNumber("falloff"),
          power: readNumber("power"),
          ambient: readNumber("ambient") / 100,
          maskMix: readNumber("mask-strength") / 100,
        };
      }
      function renderShortcutText(node, text) {
        node.replaceChildren();
        let last = 0;
        const parenthetical = node.id === "tooltip",
          pattern = parenthetical
            ? /\(?\b(?:(?:(?:Ctrl|Control|Shift|Alt|Command|Cmd|Meta)(?:\+|-))+(?:Click|Drag|wheel|[A-Z])|Numpad [1-9]|appState.width|B|M|S|F|C|Enter)\b\)?/gi
            : /\b(?:(?:(?:Ctrl|Control|Shift|Alt|Command|Cmd|Meta)(?:\+|-))+(?:Click|Drag|wheel|[A-Z])|Hold Space|Click|Drag|Numpad [1-9]|appState.width|B|M|S|F|C|Enter)\b/gi;
        for (const match of text.matchAll(pattern)) {
          node.appendChild(document.createTextNode(text.slice(last, match.index)));
          const shortcut = document.createElement("span");
          shortcut.className = "tooltip-shortcut";
          shortcut.textContent = parenthetical
            ? "(" + match[0].replace(/[()]/g, "").replace(/Numpad /gi, "") + ")"
            : match[0];
          node.appendChild(shortcut);
          last = match.index + match[0].length;
        }
        node.appendChild(document.createTextNode(text.slice(last)));
      }
      function styleShortcutMentions(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
          nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes)
          if (
            /\b(?:(?:(?:Ctrl|Control|Shift|Alt|Command|Cmd|Meta)(?:\+|-))+(?:Click|Drag|wheel|[A-Z])|Hold Space|Click)\b/i.test(
              node.textContent,
            ) &&
            !node.parentElement.closest(".tooltip-shortcut")
          ) {
            const span = document.createElement("span");
            renderShortcutText(span, node.textContent);
            node.replaceWith(span);
          }
      }

      return Object.freeze({ element: $, syncRange, setRangeValue, reportIssue, shortcutModalOpen,
        shortcutContextBlocked, shortcutTextEntry, onShortcut, setTextureInfo, textureInfoSnapshot, readLighting,
        renderShortcutText, styleShortcutMentions });
    }

    function createColorPickerController({ uiControls, processor }) {
      const { element: $ } = uiControls;
      const { rgb, hex } = processor;
      function rgbToHsv(channels) {
        const [r, g, b] = channels.map((v) => v / 255),
          max = Math.max(r, g, b),
          min = Math.min(r, g, b),
          d = max - min;
        let hue = 0;
        if (d) {
          if (max === r) hue = ((g - b) / d) % 6;
          else if (max === g) hue = (b - r) / d + 2;
          else hue = (r - g) / d + 4;
        }
        return [(hue * 60 + 360) % 360, max ? d / max : 0, max];
      }
      function hsvToRgb(h, s, v) {
        const c = v * s,
          x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
          m = v - c;
        const a =
          h < 60
            ? [c, x, 0]
            : h < 120
              ? [x, c, 0]
              : h < 180
                ? [0, c, x]
                : h < 240
                  ? [0, x, c]
                  : h < 300
                    ? [x, 0, c]
                    : [c, 0, x];
        return a.map((n) => Math.round((n + m) * 255));
      }
      let pickerTarget = null,
        pickerHsv = [0, 0, 1],
        pickerDragging = false;
      const colorPopup = $("art-color-picker");
      function pickerHsl() {
        const [h, s, v] = pickerHsv,
          l = v * (1 - s / 2);
        return [h, l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l), l];
      }
      function pickerRenderFields() {
        const mode = $("picker-mode").value,
          container = $("picker-fields");
        container.replaceChildren();
        const channels = hsvToRgb(...pickerHsv),
          hsl = pickerHsl();
        const names =
          mode === "rgb" ? ["R", "G", "B"] : mode === "hsl" ? ["H", "S", "L"] : ["HEX"];
        const values =
          mode === "rgb"
            ? channels
            : mode === "hsl"
              ? [Math.round(hsl[0]), Math.round(hsl[1] * 100), Math.round(hsl[2] * 100)]
              : [hex(channels)];
        for (let i = 0; i < names.length; i++) {
          const label = document.createElement("label"),
            input = document.createElement("input"),
            caption = document.createElement("span");
          input.type = mode === "hex" ? "text" : "number";
          input.value = values[i];
          input.setAttribute("aria-label", names[i]);
          if (mode !== "hex") {
            input.min = 0;
            input.max = mode === "rgb" ? 255 : i === 0 ? 359 : 100;
            input.step = 1;
          } else {
            input.maxLength = 7;
            input.spellcheck = false;
          }
          input.addEventListener("input", () => pickerReadFields(mode));
          input.addEventListener("change", () => pickerPaint(true));
          caption.textContent = names[i];
          label.append(input, caption);
          container.appendChild(label);
        }
      }
      function pickerPaint(fields = true) {
        const channels = hsvToRgb(...pickerHsv),
          value = hex(channels);
        $("picker-sv").style.backgroundColor = "hsl(" + pickerHsv[0] + " 100% 50%)";
        $("picker-dot").style.left = pickerHsv[1] * 100 + "%";
        $("picker-dot").style.top = (1 - pickerHsv[2]) * 100 + "%";
        $("picker-hue").value = Math.round(pickerHsv[0]);
        $("picker-preview").style.background = value;
        $("picker-sv").setAttribute(
          "aria-valuetext",
          "Saturation " +
            Math.round(pickerHsv[1] * 100) +
            "%, brightness " +
            Math.round(pickerHsv[2] * 100) +
            "%",
        );
        if (fields) pickerRenderFields();
        if (pickerTarget && pickerTarget.value !== value) {
          pickerTarget.value = value;
          pickerTarget.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      function pickerReadFields(mode) {
        const inputs = [...$("picker-fields").querySelectorAll("input")];
        if (mode === "hex") {
          const value = inputs[0].value;
          if (!/^#?[0-9a-f]{6}$/i.test(value)) return;
          pickerHsv = rgbToHsv(rgb("#" + value.replace("#", "")));
        } else {
          const values = inputs.map((input) => Number(input.value));
          if (inputs.some((input) => input.value === "" || !input.checkValidity())) return;
          if (mode === "rgb") pickerHsv = rgbToHsv(values);
          else {
            const [h, sPercent, lPercent] = values,
              s = sPercent / 100,
              l = lPercent / 100,
              v = l + s * Math.min(l, 1 - l);
            pickerHsv = [h, v ? 2 * (1 - l / v) : 0, v];
          }
        }
        pickerPaint(false);
      }
      function openArtPicker(target) {
        pickerTarget = target;
        pickerHsv = rgbToHsv(rgb(target.value));
        colorPopup.hidden = false;
        $("picker-status").textContent = "";
        pickerPaint();
        const r = target.getBoundingClientRect(),
          p = colorPopup.getBoundingClientRect();
        colorPopup.style.left =
          Math.max(8, Math.min(window.innerWidth - p.width - 8, r.left)) + "px";
        colorPopup.style.top =
          Math.max(8, Math.min(window.innerHeight - p.height - 8, r.bottom + 5)) + "px";
        $("picker-sv").focus({ preventScroll: true });
      }
      function closeArtPicker() {
        colorPopup.hidden = true;
        pickerDragging = false;
        pickerTarget = null;
      }
      document.querySelectorAll("input[type=color]").forEach((input) => {
        input.addEventListener("click", (e) => {
          e.preventDefault();
          openArtPicker(input);
        });
      });
      function pickerSetPoint(e) {
        const r = $("picker-sv").getBoundingClientRect();
        pickerHsv[1] = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        pickerHsv[2] = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
        pickerPaint();
      }
      $("picker-sv").addEventListener("pointerdown", (e) => {
        e.preventDefault();
        pickerDragging = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        pickerSetPoint(e);
      });
      $("picker-sv").addEventListener("pointermove", (e) => {
        if (pickerDragging) pickerSetPoint(e);
      });
      for (const name of ["pointerup", "pointercancel"])
        $("picker-sv").addEventListener(name, () => (pickerDragging = false));
      $("picker-sv").addEventListener("keydown", (e) => {
        const amount = e.shiftKey ? 0.1 : 0.01;
        if (e.key === "ArrowLeft") pickerHsv[1] -= amount;
        else if (e.key === "ArrowRight") pickerHsv[1] += amount;
        else if (e.key === "ArrowUp") pickerHsv[2] += amount;
        else if (e.key === "ArrowDown") pickerHsv[2] -= amount;
        else return;
        e.preventDefault();
        pickerHsv[1] = Math.max(0, Math.min(1, pickerHsv[1]));
        pickerHsv[2] = Math.max(0, Math.min(1, pickerHsv[2]));
        pickerPaint();
      });
      $("picker-hue").addEventListener("input", (e) => {
        pickerHsv[0] = Number(e.target.value);
        pickerPaint();
      });
      $("picker-mode").addEventListener("change", pickerRenderFields);
      $("picker-eyedropper").disabled = typeof window.EyeDropper !== "function";
      $("picker-eyedropper").addEventListener("click", async () => {
        try {
          const result = await new window.EyeDropper().open();
          pickerHsv = rgbToHsv(rgb(result.sRGBHex));
          pickerPaint();
        } catch (error) {
          if (error.name !== "AbortError")
            $("picker-status").textContent = "Screen sampling is unavailable.";
        }
      });
      document.addEventListener("pointerdown", (e) => {
        if (!colorPopup.hidden && !colorPopup.contains(e.target) && e.target !== pickerTarget)
          closeArtPicker();
      });
      document.addEventListener(
        "keydown",
        (e) => {
          if (e.key === "Escape" && !colorPopup.hidden) {
            e.preventDefault();
            e.stopImmediatePropagation();
            closeArtPicker();
          }
        },
        true,
      );
      window.addEventListener("resize", closeArtPicker);
      window.addEventListener("scroll", closeArtPicker, true);
    }

    function createTooltipController({ uiControls, getEditSession }) {
      const { element: $, renderShortcutText, styleShortcutMentions } = uiControls;
      const descriptions = {
        "Show Texture": "Shows the edited texture. \nUncheck to use the main View setting.",
        "Apply Direction":
          "Applies the direction angle to the current selection. \nAdjust Angle Strenght if needed.",
        "Face Angle":
          "Visualizes the selected facing direction. \nClick a facet to apply it to the current selection. \nNormal Strength affects the visualization.",
        "Angle Strength":
          "Adjusts how much the normal angle is applied. \nLower values make the normal more front-facing.",
        "Brightness Adjustment":
          "Relative - Adjusts brightness relative to its original value.\nFixed - Set the entire selection to a fixed value.",
        Contiguous:
          "Selects all pixels of the same value, even if they are not connected.\nPress (C) to toggle.",
        "Wand Source": "Choose the map used by the Wand tool.",
        "Selection Color": "Set the hint color.",
        Zoom: "Change preview scale. Pinch or Ctrl-wheel to zoom. 100% shows native pixels.",
        Fit: "Fit the whole image inside the canvas.",
        Export: "Save this texture as a PNG file.",
        Preset: "Use presets as a starting point for the selected subject type.",
        "Shape Strength": "Strength of the estimated shape.",
        "Normal Strength": "Adjust the intensity of the entire Normal Map.",
        "Edge Width": "Smoothing width. \nLow values preserve thin, sharp edges.",
        "Shading Strength": "Amount of albedo shading used in the Light Mask map.",
        "Merge Outlines": "Attempt to include pixel art outlines into nearby facets.",
        "Facet Splitting": "Allow large color clusters to use several surface directions.",
        "Lightest Value": "Cap generated highlights at this grayscale value (0â€“255).",
        "Darkest Value": "Minimum light reception before cavity darkening.",
        "Cavity Darkening": "Reduce light reception in enclosed dark clusters.",

        Albedo: "Base color texture.",
        Normal: "Surface direction texture.",
        "Light Mask": "Controls how much light each pixel receives.",
        View: "Select the displayed texture or lighting result.\nFinal (Numpad 1)\nAlbedo (Numpad 2)\nNormal (Numpad 3)\nLight Mask (Numpad 4)",
        "Light Color": "Color of the point light.",
        Height: "Height of the light above the surface. Alt+Drag",
        Falloff: "Distance over which light fades. Ctrl+Drag",
        Brightness: "Strength of the point light. Shift+Drag",
        Ambient: "Uses albedo color to set ambient light intensity.",
        "Hide BG": "Hide pixels matching the background color.",
        "BG Color": "Color used to identify the background.",
        "Detect BG": "Sample the most common color along the image border.",
        "Light Cursor":
          "Simple - Shows a basic point light. (Numpad 7)\nAdvanced - Shows additional light settings. (Numpad 8)\nOff - Hides the cursor. (Numpad 9)",
        "Follow Mouse": "Makes the Light Cursor follow your mouse.\nPress (F) to toggle.",
      };
      const tooltip = document.createElement("div");
      tooltip.id = "tooltip";
      tooltip.hidden = true;
      tooltip.setAttribute("role", "tooltip");
      document.body.appendChild(tooltip);
      const mapButtonTips = {
        "generate-normal": "Generate a Normal Map texture from the Albedo.",
        "modify-normal": "Manually edit the Normal Map texture.",
        "generate-mask": "Generate a Light Mask texture from the Albedo.",
        "modify-mask": "Manually edit the Light Mask texture.",
      };
      for (const button of document.querySelectorAll(".generation-buttons button"))
        button.title = mapButtonTips[button.id] || descriptions[button.textContent.trim()] || "";
      styleShortcutMentions($("hint-help"));
      styleShortcutMentions($("tool-info-content"));
      const tipTargets = [
        ...document.querySelectorAll(
          ".texture-heading label,.view-field,.color-field,.cursor-field,.toggle,.slider-heading>span,#detect-bg,#generator label,#modifier label,#modifier .direction-label,#zoom-fit,[title],[data-shortcut-tooltip]",
        ),
      ];
      for (const target of tipTargets) {
        const name = target.matches(".slider-heading>span")
            ? target.firstChild.textContent.trim().replace(/\s+/g, " ")
            : [...target.childNodes]
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent)
                .join("")
                .trim()
                .replace(/\s+/g, " "),
          title = target.getAttribute("title"),
          description =
            title ||
            (target.closest("#modifier") && name === "Brightness"
              ? "Adjusts the brightness value of the current selection."
              : descriptions[name]);
        target.removeAttribute("title");
        if (!description) continue;
        let anchor = target;
        if (target.tagName === "LABEL" && !target.closest(".texture-heading")) {
          const text = [...target.childNodes].find(
            (n) => n.nodeType === 3 && n.textContent.trim(),
          );
          if (text) {
            anchor = document.createElement("span");
            anchor.textContent = text.textContent;
            target.replaceChild(anchor, text);
          }
        }
        anchor.dataset.tooltip = description;
        anchor.classList.add("tip-target");
        if (!anchor.matches("button,input,select,a,[tabindex]")) anchor.tabIndex = 0;
        anchor.setAttribute("aria-description", description);
        if (target.contains($("modifier-show-texture"))) anchor.dataset.textureTooltip = "modify";
        if (target.contains($("generator-show-texture")))
          anchor.dataset.textureTooltip = "generate";
      }
      let tooltipTimer = null,
        tooltipAnchor = null;
      function hideTooltip() {
        clearTimeout(tooltipTimer);
        tooltipTimer = null;
        tooltip.hidden = true;
        tooltipAnchor = null;
      }
      function queueTooltip(anchor) {
        if (!anchor || anchor === tooltipAnchor) return;
        hideTooltip();
        tooltipAnchor = anchor;
        tooltipTimer = setTimeout(() => {
          if (tooltipAnchor !== anchor || !anchor.isConnected) return;
          const r = anchor.getBoundingClientRect();
          if (!r.width || !r.height) {
            hideTooltip();
            return;
          }
          const session = getEditSession();
          const description =
            anchor.dataset.textureTooltip && session
              ? "Shows the " +
                (session.mode === "modify" ? "edited " : "generated ") +
                (session.kind === "normal" ? "Normal" : "Light Mask") +
                " texture.\nHold or Press (S) to toggle."
              : anchor.dataset.tooltip;
          renderShortcutText(tooltip, description);
          tooltip.hidden = false;
          const t = tooltip.getBoundingClientRect();
          tooltip.style.left =
            Math.max(
              6,
              Math.min(window.innerWidth - t.width - 6, r.left + r.width / 2 - t.width / 2),
            ) + "px";
          tooltip.style.top =
            (r.top - t.height - 8 >= 6
              ? r.top - t.height - 8
              : Math.min(window.innerHeight - t.height - 6, r.bottom + 8)) + "px";
        }, 450);
      }
      const tooltipTarget = (e) =>
        e.target instanceof Element ? e.target.closest("[data-tooltip]") : null;
      document.addEventListener("pointerover", (e) => queueTooltip(tooltipTarget(e)));
      document.addEventListener("pointerout", (e) => {
        if (!tooltipAnchor) return;
        const next =
          e.relatedTarget instanceof Element ? e.relatedTarget.closest("[data-tooltip]") : null;
        if (next !== tooltipAnchor) hideTooltip();
      });
      document.addEventListener("focusin", (e) => queueTooltip(tooltipTarget(e)));
      document.addEventListener("focusout", hideTooltip);
      document.addEventListener("pointerdown", hideTooltip, true);
      document.addEventListener("keydown", hideTooltip);
      window.addEventListener("scroll", hideTooltip, true);
      window.addEventListener("resize", hideTooltip);
      window.addEventListener("blur", hideTooltip);
    }

    function createTextureDocument({
      appState,
      uiControls,
      processor,
      fileAccess,
      fitCanvas,
      isZoomInitialized,
      renderPixels,
      requestDraw,
      updateTextureButtons,
    }) {
      const { element: $, setRangeValue, reportIssue, setTextureInfo } = uiControls;
      const { hex } = processor;
      const { readImage } = fileAccess;
      const canvas = $("canvas"), ctx = canvas.getContext("2d");
      function backgroundSample() {
        const a = appState.textures.albedo;
        if (!a) return;
        const counts = new Map();
        function take(x, y) {
          const i = (y * a.w + x) * 4;
          if (a.data[i + 3] !== 255) return;
          const key = a.data[i] + "," + a.data[i + 1] + "," + a.data[i + 2];
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        for (let x = 0; x < a.w; x++) {
          take(x, 0);
          take(x, a.h - 1);
        }
        for (let y = 1; y < a.h - 1; y++) {
          take(0, y);
          take(a.w - 1, y);
        }
        if (counts.size)
          $("bg-color").value = hex(
            [...counts]
              .sort((a, b) => b[1] - a[1])[0][0]
              .split(",")
              .map(Number),
          );
      }
      function updateDefaultFalloff() {
        const value = 70;
        const input = $("falloff");
        input.defaultValue = String(value);
        setRangeValue(input, value);
        appState.lighting.overrides.falloff = value;
      }
      function rebuild() {
        const a = appState.textures.albedo;
        if (!a) return;
        const oldW = appState.width,
          oldH = appState.height;
        appState.width = a.w;
        appState.height = a.h;
        if (!isZoomInitialized() || oldW !== appState.width || oldH !== appState.height) {
          appState.light.x = appState.width / 2;
          appState.light.y = appState.height / 2;
        } else {
          appState.light.x = (appState.light.x / oldW) * appState.width;
          appState.light.y = (appState.light.y / oldH) * appState.height;
        }
        if (canvas.width !== appState.width) canvas.width = appState.width;
        if (canvas.height !== appState.height) canvas.height = appState.height;
        if (!isZoomInitialized() || oldW !== appState.width || oldH !== appState.height) fitCanvas();
        Object.assign(appState.render, processor.prepareTextures(a, appState.textures.normal));
        requestDraw();
      }
      $("export-canvas").addEventListener("click", async () => {
        if (!appState.textures.albedo || appState.edit.session) return;
        const image = renderPixels(ctx, "lit");
        const name = (
            $("albedo-info").querySelector(".texture-filename")?.textContent || "Texture"
          ).replace(/\.[^.]+$/, ""),
          filename = name + "-Final.png";
        try {
          await fileAccess.exportPNG(image, filename);
        } catch (error) {
          if (error.name !== "AbortError")
            reportIssue("Could not save preview: " + error.message);
        }
      });

      function compatibleTexture(kind) {
        const t = appState.textures[kind],
          a = appState.textures.albedo;
        return t && a && t.w === a.w && t.h === a.h ? t : null;
      }
      function clearTexture(kind) {
        fileAccess.versions[kind]++;
        fileAccess.handles[kind] = null;
        fileAccess.stamps[kind] = null;
        fileAccess.errors[kind] = null;
        appState.textures[kind] = null;
        $(kind + "-file").value = "";
        setTextureInfo(kind, kind === "normal"
            ? "Flat surface"
            : kind === "mask"
              ? "All pixels receive light"
              : "No albedo");
      }
      function imageDimensionsMismatch(kind, data) {
        return ["albedo", "normal", "mask"].some(
          (k) =>
            k !== kind && appState.textures[k] && (appState.textures[k].w !== data.w || appState.textures[k].h !== data.h),
        );
      }
      function confirmNewResolution() {
        const dialog = $("texture-mismatch");
        if (dialog.open) return Promise.resolve(false);
        return new Promise((resolve) => {
          let done = false;
          const finish = (accepted) => {
            if (done) return;
            done = true;
            dialog.removeEventListener("click", click);
            dialog.removeEventListener("cancel", cancel);
            dialog.removeEventListener("close", closed);
            dialog.close();
            resolve(accepted);
          };
          const click = (e) => {
            const button = e.target.closest("[data-resolution-choice]");
            if (button) finish(button.dataset.resolutionChoice === "continue");
          };
          const cancel = (e) => {
            e.preventDefault();
            finish(false);
          };
          const closed = () => finish(false);
          dialog.addEventListener("click", click);
          dialog.addEventListener("cancel", cancel);
          dialog.addEventListener("close", closed);
          dialog.showModal();
        });
      }
      async function load(kind, uri, name, detectBackground = true) {
        const version = ++fileAccess.versions[kind];
        try {
          const data = await readImage(uri);
          if (version !== fileAccess.versions[kind]) return false;
          if (detectBackground && imageDimensionsMismatch(kind, data)) {
            if (!(await confirmNewResolution()) || version !== fileAccess.versions[kind]) return false;
            for (const k of ["albedo", "normal", "mask"])
              if (
                k !== kind &&
                appState.textures[k] &&
                (appState.textures[k].w !== data.w || appState.textures[k].h !== data.h)
              )
                clearTexture(k);
            appState.edit.hints = null;
            appState.edit.undo = [];
            appState.edit.redo = [];
            appState.render.normals = null;
            appState.render.albedoLinear = null;
          }
          appState.textures[kind] = data;
          setTextureInfo(kind, name, data);
          if (kind === "albedo" && detectBackground) {
            appState.edit.hints = null;
            // Fresh loads use alpha if any pixel is transparent or translucent.
            // Automatic refresh preserves manual Hide BG choices.
            let hasTransparency = false;
            for (let i = 3; i < data.data.length; i += 4) {
              if (data.data[i] < 255) { hasTransparency = true; break; }
            }
            if (hasTransparency) $("hide-bg").checked = false;
            backgroundSample();
            updateDefaultFalloff();
          }
          rebuild();
          requestDraw();
          return true;
        } catch (e) {
          if (version === fileAccess.versions[kind]) {
            reportIssue(name + ": " + e.message);
          }
          return false;
        }
      }
      async function linkExportedTexture(kind, handle, texture) {
        let file;
        try {
          file = await handle.getFile();
        } catch (error) {
          reportIssue("Texture saved, but could not link it. Browse the saved file to link it.");
          return;
        }
        if (appState.textures[kind] !== texture) return;
        fileAccess.handles[kind] = handle;
        fileAccess.stamps[kind] = file.lastModified + ":" + file.size;
        fileAccess.errors[kind] = null;
        setTextureInfo(kind, file.name, texture);
        watchStatus();
        requestDraw();
      }
      function watchStatus() {
        if (appState.edit.session) {
          $("watch-status").textContent = "Automatic refresh paused";
          return;
        }
        if (!fileAccess.canWatch) {
          $("watch-status").textContent = "Automatic file refresh may not be supported.";
          return;
        }
        const linked = Object.keys(fileAccess.handles).filter((k) => fileAccess.handles[k]),
          errors = linked.filter((k) => fileAccess.errors[k]);
        $("watch-status").textContent = errors.length
          ? errors.map((k) => k + ": " + fileAccess.errors[k]).join(" Â· ")
          : "";
      }

      for (const kind of ["albedo", "normal", "mask"]) {
        $("open-" + kind).addEventListener("click", async () => {
          if (!fileAccess.canWatch) {
            $(kind + "-file").click();
            return;
          }
          try {
            const handle = await fileAccess.pickPNG();
            const file = await handle.getFile();
            const ok = await loadFile(kind, file);
            if (ok) {
              fileAccess.handles[kind] = handle;
              fileAccess.stamps[kind] = file.lastModified + ":" + file.size;
              fileAccess.errors[kind] = null;
              watchStatus();
            }
          } catch (e) {
            if (e.name !== "AbortError") {
              $("watch-status").textContent =
                "Could not open a linked file: " + e.message + "; use the fallback file picker.";
              $(kind + "-file").click();
            }
          }
        });
        $(kind + "-file").addEventListener("change", async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          if (await loadFile(kind, f)) {
            fileAccess.handles[kind] = null;
            fileAccess.stamps[kind] = null;
            fileAccess.errors[kind] = null;
          }
          watchStatus();
        });
        $("clear-" + kind).addEventListener("click", () => {
          clearTexture(kind);
          if (kind === "albedo") {
            appState.render.normals = null;
            appState.render.albedoLinear = null;
            requestDraw();
          } else rebuild();
          watchStatus();
        });
      }

      fileAccess.startWatching({
        isPaused: () => !!appState.edit.session || $("texture-mismatch").open || document.hidden,
        onChanged: loadFile,
        onStatus: watchStatus,
      });
      watchStatus();

      for (const kind of ["normal", "mask"]) {
        $("export-" + kind).addEventListener("click", async () => {
          if (appState.edit.session || fileAccess.saving.has(kind)) return;
          const texture = appState.textures[kind];
          if (!texture) {
            reportIssue("Load or generate a " + kind + " texture first.");
            return;
          }
          const name = (
              $("albedo-info").querySelector(".texture-filename")?.textContent || "Texture"
            ).replace(/\.[^.]+$/, ""),
            filename = name + (kind === "normal" ? "-Normal" : "-Light Mask") + ".png";
          fileAccess.saving.add(kind);
          $("export-" + kind).disabled = true;

          try {
            const handle = await fileAccess.exportPNG(texture, filename, {
              verify: true,
              onHandle: () => { ++fileAccess.versions[kind]; },
            });
            if (handle) await linkExportedTexture(kind, handle, texture);
          } catch (error) {
            if (error.name !== "AbortError") reportIssue("Could not save texture: " + error.message);
          } finally {
            fileAccess.saving.delete(kind);
            updateTextureButtons();
          }
        });
      }
      for (const kind of ["albedo", "normal", "mask"]) {
        const button = $("open-" + kind);
        button.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          button.classList.add("drag-over");
        });
        button.addEventListener("dragleave", () => button.classList.remove("drag-over"));
        button.addEventListener("drop", async (e) => {
          e.preventDefault();
          button.classList.remove("drag-over");
          if (appState.edit.session) return;
          const item = [...e.dataTransfer.items].find((item) => item.kind === "file");
          const fallback = e.dataTransfer.files[0];
          const handlePromise =
            fileAccess.canWatch && item && item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null;
          try {
            const handle = handlePromise ? await handlePromise : null;
            if (handle && handle.kind !== "file")
              throw Error("Drop an image file, not a folder.");
            const file = handle ? await handle.getFile() : fallback;
            if (!file) return;
            if (await loadFile(kind, file)) {
              fileAccess.handles[kind] = handle;
              fileAccess.stamps[kind] = handle ? file.lastModified + ":" + file.size : null;
              fileAccess.errors[kind] = null;
              watchStatus();
            }
          } catch (error) {
            reportIssue("Could not load dropped file: " + error.message);
          }
        });
      }
      document.addEventListener("dragover", (e) => {
        if ([...e.dataTransfer.types].includes("Files")) e.preventDefault();
      });
      document.addEventListener("drop", (e) => {
        if ([...e.dataTransfer.types].includes("Files")) e.preventDefault();
      });

      async function loadFile(kind, file, detectBackground = true) {
        try {
          return await fileAccess.withPNG(file, (uri) => load(kind, uri, file.name, detectBackground));
        } catch (error) {
          reportIssue(error.message);
          return false;
        }
      }
      return Object.freeze({ backgroundSample, compatibleTexture, load, rebuild, watchStatus });
    }

    function createCanvasPresenter({
      appState,
      uiControls,
      processor,
      fileAccess,
      compatibleTexture,
      drawHintOverlay,
      editingHints,
      getSelectionRevision,
      previewGeneration,
      saveHintUndo,
      sliderNumber,
      updateHandCursor,
      updateHintControls,
      updatePanHint,
    }) {
      const { element: $ } = uiControls;
      const canvas = $("canvas"), ctx = canvas.getContext("2d");
      const viewport = $("canvas-viewport");
      let queued = false;
      function updateTextureButtons() {
        const busy = !!appState.edit.session;
        $("export-canvas").disabled = busy || !appState.textures.albedo;
        for (const kind of ["albedo", "normal", "mask"]) {
          $("open-" + kind).disabled = busy;
          $("clear-" + kind).disabled = busy || !appState.textures[kind];
        }
        for (const kind of ["normal", "mask"]) {
          $("generate-" + kind).disabled = busy || !appState.textures.albedo;
          $("modify-" + kind).disabled = busy || !appState.textures[kind] || !appState.textures.albedo;
          $("export-" + kind).disabled = busy || fileAccess.saving.has(kind) || !appState.textures[kind];
        }
      }
      function requestDraw() {
        updateTextureButtons();
        updatePanHint();
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          draw();
        });
      }

      function updateMapStatus() {
        const node = $("loaded-status");
        if (!node.querySelector("[data-map-status]")) {
          for (const [kind, label] of [
            ["albedo", "Albedo"],
            ["normal", "Normal Map"],
            ["mask", "Light Mask"],
          ]) {
            const item = document.createElement("span");
            item.dataset.mapStatus = kind;
            item.textContent = label;
            node.appendChild(item);
          }
        }
        for (const item of node.querySelectorAll("[data-map-status]")) {
          const loaded = !!appState.textures[item.dataset.mapStatus];
          item.classList.toggle("missing", !loaded);
          item.setAttribute(
            "aria-label",
            item.textContent + (loaded ? " available" : " not loaded"),
          );
        }
      }
      function draw() {
        document.querySelectorAll(".reset").forEach((button) => {
          const id = button.dataset.slider,
            atDefault = Math.abs(sliderNumber(id) - Number($(id).defaultValue)) < 0.000001;
          button.classList.toggle("at-default", atDefault);
          button.disabled = atDefault;
        });
        for (const [id, label, suffix] of [
          ["height", "height-value", " px"],
          ["falloff", "falloff-value", " px"],
          ["power", "power-value", ""],
          ["ambient", "ambient-value", "%"],
          ["mask-strength", "mask-value", "%"],
        ])
          if (!$(label).querySelector("input"))
            $(label).textContent =
              (id === "power"
                ? Number(sliderNumber(id).toFixed(1))
                : Math.trunc(sliderNumber(id))) + suffix;
        $("resolution").textContent = appState.textures.albedo ? appState.width + " x " + appState.height : "";
        updateMapStatus();
        const a = appState.textures.albedo;
        if (!a) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          drawScrollbarUnderlay();
          return;
        }
        ctx.putImageData(
          renderPixels(
            ctx,
            appState.edit.session &&
              $(appState.edit.session.mode === "modify" ? "modifier-show-texture" : "generator-show-texture")
                .checked
              ? appState.edit.session.kind
              : $("view").value,
          ),
          0,
          0,
        );
        drawOverlays();
      }

      let overlayQueued = false;
      function requestOverlayDraw() {
        if (overlayQueued) return;
        overlayQueued = true;
        requestAnimationFrame(() => {
          overlayQueued = false;
          if (!queued) drawOverlays();
        });
      }
      const normalSphereFaces = [];
      let normalSphereSummary = null,
        normalSphereHighlight = null;
      function buildNormalSphere() {
        const svg = $("normal-direction-sphere"),
          ns = "http://www.w3.org/2000/svg",
          radius = 56;
        const point = (tilt, angle) => [
          64 + radius * Math.sin(tilt) * Math.cos(angle),
          64 - radius * Math.sin(tilt) * Math.sin(angle),
        ];
        function face(points, vector) {
          const polygon = document.createElementNS(ns, "polygon");
          polygon.setAttribute("points", points.map((p) => p.join(",")).join(" "));
          polygon.setAttribute("stroke", "#626c78");
          polygon.setAttribute("stroke-width", ".6");
          svg.appendChild(polygon);
          const shade = Math.round(
              62 + 60 * Math.max(0, vector[0] * -0.35 + vector[1] * 0.45 + vector[2] * 0.8),
            ),
            base = "rgb(" + shade + "," + (shade + 5) + "," + (shade + 11) + ")";
          normalSphereFaces.push({ polygon, vector, base });
          polygon.setAttribute("role", "button");
          polygon.setAttribute("tabindex", "-1");
          const tilt = (Math.acos(Math.max(-1, Math.min(1, vector[2]))) * 180) / Math.PI;
          polygon.setAttribute(
            "aria-label",
            "Apply facet direction, " + Math.round(tilt) + " degrees tilt",
          );
          const apply = () => applySphereFacet(vector);
          polygon.addEventListener("click", apply);
          polygon.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              apply();
            }
          });
        }
        const bands = [0, 12, 28, 45, 65, 90].map((v) => (v * Math.PI) / 180),
          sectors = 12;
        face(
          Array.from({ length: sectors }, (_, i) =>
            point(bands[1], ((i - 0.5) * Math.PI * 2) / sectors),
          ),
          [0, 0, 1],
        );
        for (let ring = 1; ring < bands.length - 1; ring++)
          for (let i = 0; i < sectors; i++) {
            const a0 = ((i - 0.5) * Math.PI * 2) / sectors,
              a1 = ((i + 0.5) * Math.PI * 2) / sectors,
              t0 = bands[ring],
              t1 = bands[ring + 1],
              t = (t0 + t1) / 2,
              a = (a0 + a1) / 2;
            face(
              [point(t0, a0), point(t1, a0), point(t1, a1), point(t0, a1)],
              [Math.sin(t) * Math.cos(a), Math.sin(t) * Math.sin(a), Math.cos(t)],
            );
          }
      }
      function applySphereFacet(vector) {
        if (!editingHints() || appState.edit.session.kind !== "normal" || !appState.edit.hints.surfaces.some((v) => v))
          return;
        saveHintUndo();
        const group = appState.edit.hints.groups[0];
        group.direction = "facet";
        group.average = vector.slice();
        group.tilt = (Math.acos(Math.max(-1, Math.min(1, vector[2]))) * 180) / Math.PI;
        updateHintControls(false);
        previewGeneration();
        requestDraw();
      }
      function normalFaceIndex(vector) {
        let best = -1,
          score = -Infinity;
        for (let i = 0; i < normalSphereFaces.length; i++) {
          const dot = normalSphereFaces[i].vector.reduce((sum, v, c) => sum + v * vector[c], 0);
          if (dot > score) {
            score = dot;
            best = i;
          }
        }
        return best;
      }
      function updateNormalSphere() {
        if (!editingHints() || appState.edit.session.kind !== "normal") return;
        if (!normalSphereFaces.length) buildNormalSphere();
        const texture = appState.textures.normal,
          selection = appState.edit.hints.surfaces,
          color = appState.edit.hints.selectionColor || "#65baff";
        if (
          normalSphereSummary &&
          normalSphereSummary.texture === texture &&
          normalSphereSummary.selection === selection &&
          normalSphereSummary.revision === getSelectionRevision() &&
          normalSphereSummary.color === color
        )
          return;
        const sum = [0, 0, 0],
          votes = new Uint32Array(normalSphereFaces.length);
        let count = 0;
        if (texture && texture.w === appState.width && texture.h === appState.height)
          for (let p = 0; p < appState.width * appState.height; p++) {
            if (!selection[p] || !texture.data[p * 4 + 3]) continue;
            const vector = [0, 1, 2].map((c) => (texture.data[p * 4 + c] / 255) * 2 - 1),
              len = Math.hypot(...vector) || 1;
            for (let c = 0; c < 3; c++) {
              vector[c] /= len;
              sum[c] += vector[c];
            }
            if (vector[2] >= 0) votes[normalFaceIndex(vector)]++;
            count++;
          }
        const length = Math.hypot(...sum),
          coherence = count ? length / count : 0,
          mixed = count > 0 && (coherence < 0.95 || votes.filter((v) => v > 0).length > 1),
          mean = length > 1e-6 ? sum.map((v) => v / length) : null,
          best = mean && mean[2] >= 0 ? normalFaceIndex(mean) : -1;
        $("normal-direction-sphere").classList.toggle("has-selection", count > 0);
        normalSphereFaces.forEach((face, i) => {
          face.polygon.setAttribute("aria-disabled", String(!count));
          face.polygon.setAttribute("tabindex", count ? "0" : "-1");
          const active = count && !mixed && i === best,
            secondary = mixed && votes[i] > 0;
          face.polygon.setAttribute("fill", active || secondary ? color : face.base);
          face.polygon.setAttribute("fill-opacity", secondary && !active ? ".55" : "1");
          face.polygon.setAttribute("stroke", "#626c78");
          face.polygon.setAttribute("stroke-width", ".6");
        });
        if (!normalSphereHighlight) {
          normalSphereHighlight = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "polygon",
          );
          normalSphereHighlight.setAttribute("fill", "none");
          normalSphereHighlight.setAttribute("pointer-events", "none");
          normalSphereHighlight.setAttribute("stroke-linejoin", "round");
          $("normal-direction-sphere").appendChild(normalSphereHighlight);
        }
        normalSphereHighlight.setAttribute(
          "points",
          best >= 0 && count && !mixed
            ? normalSphereFaces[best].polygon.getAttribute("points")
            : "",
        );
        normalSphereHighlight.setAttribute("stroke", color);
        normalSphereHighlight.setAttribute("stroke-width", "1.5");
        let text = "";
        if (count) {
          if (mixed || !mean) text = "Mixed directions";
          else {
            const tilt = Math.round(
                (Math.acos(Math.max(-1, Math.min(1, mean[2]))) * 180) / Math.PI,
              ),
              angle = Math.atan2(mean[1], mean[0]),
              names = [
                "Right",
                "Upper right",
                "Up",
                "Upper left",
                "Left",
                "Lower left",
                "Down",
                "Lower right",
              ],
              direction =
                tilt < 8
                  ? "Front"
                  : mean[2] < 0
                    ? "Back-facing"
                    : names[(Math.round(angle / (Math.PI / 4)) + 8) % 8];
            text = (mixed ? "Mixed Â· " : "") + direction + " Â· " + tilt + "Â°";
          }
        }
        $("normal-direction-readout").textContent = text;
        $("normal-direction-sphere").setAttribute("aria-label", text);
        normalSphereSummary = { texture, selection, revision: getSelectionRevision(), color };
      }

      function drawScrollbarUnderlay() {
        const viewport = $("canvas-viewport"),
          layer = $("scrollbar-underlay"),
          context = layer.getContext("2d"),
          rect = viewport.getBoundingClientRect(),
          ratio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(rect.width * ratio)),
          height = Math.max(1, Math.round(rect.height * ratio));
        if (layer.width !== width) layer.width = width;
        if (layer.height !== height) layer.height = height;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, rect.width, rect.height);
        const right = viewport.clientLeft + viewport.clientWidth,
          bottom = viewport.clientTop + viewport.clientHeight;
        if (!appState.textures.albedo || (right >= rect.width && bottom >= rect.height)) return;
        context.save();
        context.beginPath();
        context.rect(right, 0, rect.width - right, rect.height);
        context.rect(0, bottom, right, rect.height - bottom);
        context.clip();
        context.imageSmoothingEnabled = false;
        const image = canvas.getBoundingClientRect();
        context.drawImage(
          canvas,
          image.left - rect.left,
          image.top - rect.top,
          image.width,
          image.height,
        );
        drawHintOverlay(context, image, rect, ratio);
        context.restore();
      }
      function drawOverlays() {
        drawScrollbarUnderlay();
        updateNormalSphere();
        const overlay = $("cursor-overlay"),
          overlayCtx = overlay.getContext("2d"),
          hintOverlay = $("hint-cursor-overlay"),
          hintCtx = hintOverlay.getContext("2d"),
          overlayViewport = $("canvas-viewport"),
          viewportBounds = overlayViewport.getBoundingClientRect(),
          viewportRect = {
            left: viewportBounds.left + overlayViewport.clientLeft,
            top: viewportBounds.top + overlayViewport.clientTop,
            width: overlayViewport.clientWidth,
            height: overlayViewport.clientHeight,
          },
          pixelRatio = window.devicePixelRatio || 1,
          width = Math.max(1, Math.round(viewportRect.width * pixelRatio)),
          height = Math.max(1, Math.round(viewportRect.height * pixelRatio));
        for (const layer of [overlay, hintOverlay]) {
          layer.style.left = overlayViewport.clientLeft + "px";
          layer.style.top = overlayViewport.clientTop + "px";
          layer.style.width = viewportRect.width + "px";
          layer.style.height = viewportRect.height + "px";
          if (layer.width !== width) layer.width = width;
          if (layer.height !== height) layer.height = height;
          const context = layer.getContext("2d");
          context.setTransform(1, 0, 0, 1, 0, 0);
          context.clearRect(0, 0, width, height);
        }
        updateHandCursor();
        if (!appState.textures.albedo) return;
        const view =
            appState.edit.session &&
            $(appState.edit.session.mode === "modify" ? "modifier-show-texture" : "generator-show-texture")
              .checked
              ? appState.edit.session.kind
              : $("view").value,
          z = sliderNumber("height"),
          radius = sliderNumber("falloff"),
          power = sliderNumber("power");
        drawHintOverlay(overlayCtx, canvas.getBoundingClientRect(), viewportRect, pixelRatio);
        if ($("show-marker").value !== "off" && view === "lit") {
          const ctx = overlayCtx,
            imageRect = canvas.getBoundingClientRect(),
            scale = imageRect.width / appState.width;
          ctx.setTransform(
            pixelRatio * scale,
            0,
            0,
            pixelRatio * scale,
            (imageRect.left - viewportRect.left) * pixelRatio,
            (imageRect.top - viewportRect.top) * pixelRatio,
          );

          const stem = Math.round((55 * Math.log1p(Math.max(0, z - 1) / 100)) / Math.log(6)),
            cx = Math.round(appState.light.x),
            cy = Math.round(appState.light.y),
            by = cy - stem;
          ctx.save();
          ctx.fillStyle = $("light-color").value;
          const cursorOpacity = Math.max(0, Math.min(1, power)),
            cursorGrowth = -Math.expm1(-Math.max(0, power) / 6),
            cursorHaloRadius = Math.round(2 + 9 * cursorGrowth),
            cursorCoreRadius =
              power >= 0.75
                ? Math.max(3, Math.round(1 + 5 * cursorGrowth))
                : Math.round(1 + 5 * cursorGrowth);
          function dot(x, y, alpha = 1) {
            ctx.globalAlpha = alpha * cursorOpacity;
            ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
          }
          function ring(x, y, r, alpha, dashed = false) {
            r = Math.max(1, Math.round(r));
            let a = r,
              b = 0,
              err = 1 - r;
            while (a >= b) {
              if (!dashed || Math.floor(b / 4) % 2 === 0)
                for (const [dx, dy] of [
                  [a, b],
                  [b, a],
                  [-b, a],
                  [-a, b],
                  [-a, -b],
                  [-b, -a],
                  [b, -a],
                  [a, -b],
                ])
                  dot(x + dx, y + dy, alpha);
              b++;
              if (err < 0) err += 2 * b + 1;
              else {
                a--;
                err += 2 * (b - a) + 1;
              }
            }
          }

          function disk(x, y, r, alpha) {
            r = Math.max(1, Math.round(r));
            const edge = r - 0.5;
            ctx.globalAlpha = alpha * cursorOpacity;
            for (let dy = -(r - 1); dy < r; dy++) {
              const span = Math.floor(Math.sqrt(edge * edge - dy * dy));
              ctx.fillRect(x - span, y + dy, span * 2 + 1, 1);
            }
          }
          if ($("show-marker").value === "simple") {
            disk(cx, cy, cursorHaloRadius, 0.12 + Math.min(1, power / 6) * 0.2);
            disk(cx, cy, cursorCoreRadius, 1);
          } else {
            ring(
              cx,
              by,
              Math.min(radius, Math.ceil(Math.hypot(appState.width, appState.height) + Math.abs(stem)) + 1),
              0.3 + Math.min(1, power / 6) * 0.3,
              true,
            );
            for (let y = Math.max(0, by); y <= cy; y++) dot(cx, y, 0.35);
            disk(cx, cy, 1, 0.8);
            disk(cx, by, cursorHaloRadius, 0.12 + Math.min(1, power / 6) * 0.2);
            disk(cx, by, cursorCoreRadius, 1);
          }
          ctx.restore();
        }
      }

      function renderPixels(target, view) {
        const settings = uiControls.readLighting(sliderNumber);
        appState.lighting.settings = settings;
        return processor.renderPixels(target.createImageData(appState.width, appState.height), {
          width: appState.width,
          height: appState.height,
          albedo: appState.textures.albedo,
          normal: compatibleTexture("normal"),
          mask: compatibleTexture("mask"),
          normals: appState.render.normals,
          albedoLinear: appState.render.albedoLinear,
          lightX: appState.light.x,
          lightY: appState.light.y,
        }, { ...settings, view });
      }
      return Object.freeze({ renderPixels, requestDraw, requestOverlayDraw, updateTextureButtons });
    }

    function createGenerationSessions({
      appState,
      uiControls,
      processor,
      fileAccess,
      cancelSelectionGesture,
      ensureHints,
      freshHints,
      getSelectionColor,
      positionToolPopup,
      rebuild,
      requestDraw,
      saveHintUndo,
      updateHintControls,
      updatePanHint,
      updateTextureButtons,
      watchStatus,
    }) {
      const {
        element: $,
        setRangeValue,
        reportIssue,
        shortcutModalOpen,
        shortcutContextBlocked,
        onShortcut,
        setTextureInfo,
        textureInfoSnapshot,
      } = uiControls;
      const { rgb, applySurfaceHints, generateTexture, copyHints, presetDefaults } = processor;
      let generationTimer = null;
      function resetGenerationPreset() {
        const defaults =
          appState.edit.session && appState.edit.session.kind === "mask"
            ? { strength: 100, facets: 0, floor: 20, ceiling: 255, cavity: 35 }
            : presetDefaults[$("gen-preset").value];
        for (const key of [
          "strength",
          "normal-strength",
          "edge-width",
          "facets",
          "floor",
        "ceiling",
          "cavity",
        ])
          setRangeValue("gen-" + key, defaults[key] ??
            (key === "normal-strength"
              ? 100
              : key === "edge-width"
                ? $("gen-preset").value === "architecture"
                  ? 1
                  : $("gen-preset").value === "character"
                    ? 2
                    : 3
                : 0));
        if (appState.edit.session && appState.edit.session.kind === "mask") setRangeValue("gen-strength", 100);
        previewGeneration();
      }
      function generationOptions() {
        return {
          kind: appState.edit.session.kind,
          preset: appState.edit.session.kind === "mask" ? "object" : $("gen-preset").value,
          strength: Number($("gen-strength").value),
          normalStrength: Number($("gen-normal-strength").value),
          edgeWidth: Number($("gen-edge-width").value),
          facets: Number($("gen-facets").value),
          floor: Number($("gen-floor").value),
          ceiling: Number($("gen-ceiling").value),
          cavity: Number($("gen-cavity").value),
          hints: null,
          merge: $("gen-merge").checked,
          bg: rgb($("bg-color").value),
          hide: $("hide-bg").checked,
        };
      }
      function previewGeneration() {
        if (!appState.edit.session) return;
        const token = appState.edit.session;
        for (const key of [
          "strength",
          "normal-strength",
          "edge-width",
          "facets",
          "floor",
        "ceiling",
          "cavity",
        ])
          $("gen-" + key + "-value").textContent =
            $("gen-" + key).value + ((key === "floor" || key === "ceiling") ? "" : key === "edge-width" ? " px" : "%");
        clearTimeout(generationTimer);
        $(appState.edit.session?.mode === "modify" ? "modifier-status" : "generator-status").textContent =
          "";
        $(appState.edit.session?.mode === "modify" ? "modifier-apply" : "generator-apply").disabled = true;
        generationTimer = setTimeout(() => {
          if (appState.edit.session !== token) return;
          try {
            let data;
            if (token.mode === "modify") data = modifiedTexture(token);
            else {
              data = generateTexture(appState.textures.albedo, generationOptions());
              token.base = data;
            }
            appState.textures[token.kind] = data;
            token.result = data;
            setTextureInfo(token.kind, "Generated preview", data);
            rebuild();
            $(
              appState.edit.session?.mode === "modify" ? "modifier-status" : "generator-status",
            ).textContent = "";
            $(appState.edit.session?.mode === "modify" ? "modifier-apply" : "generator-apply").disabled =
              false;
          } catch (error) {
            $(
              appState.edit.session?.mode === "modify" ? "modifier-status" : "generator-status",
            ).textContent = error.message;
          }
        }, 100);
      }

      function openGeneration(kind) {
        if (!appState.textures.albedo) {
          reportIssue("Load an albedo texture before generating.");
          return;
        }
        if (appState.textures.albedo.w * appState.textures.albedo.h > 2048 * 2048) {
          reportIssue("Generation supports up to 4,194,304 pixels per image (2048 x 2048).");
          return;
        }
        if (appState.edit.session) closeGeneration(false);
        ensureHints();
        appState.edit.undo = [];
        appState.edit.redo = [];
        appState.edit.session = {
          hintSnapshot: copyHints(appState.edit.hints),
          kind,
          previous: appState.textures[kind],
          info: textureInfoSnapshot(kind),
          result: null,
          mode: "generate",
        };
        fileAccess.versions[kind]++;
        $("generator-title").textContent =
          kind === "normal" ? "Generate Normal Map" : "Generate Light Mask";
        $("gen-strength-label").firstChild.textContent =
          kind === "normal" ? "Shape Strength " : "Shading Strength ";
        $("gen-strength").max = kind === "normal" ? "200" : "100";
        document
          .querySelectorAll(".normal-option")
          .forEach((el) => (el.hidden = kind !== "normal"));
        document.querySelectorAll(".mask-option").forEach((el) => (el.hidden = kind !== "mask"));
        updateTextureButtons();
        updateHintControls();
        enterPopupLighting();
        $("generator").show();
        positionToolPopup($("generator"));
        resetGenerationPreset();
      }
      let textureToggleHold = null;
      function popupTextureCheckbox() {
        return $(
          appState.edit.session.mode === "modify" ? "modifier-show-texture" : "generator-show-texture",
        );
      }
      function setPopupTextureView(value) {
        if (!appState.edit.session) return;
        popupTextureCheckbox().checked = value;
        requestDraw();
      }
      function cancelTextureToggleHold() {
        if (textureToggleHold) {
          const hold = textureToggleHold;
          textureToggleHold = null;
          if (appState.edit.session === hold.session) setPopupTextureView(hold.original);
        }
      }
      window.addEventListener("keydown", (e) => {
        if (
          e.key.toLowerCase() !== "s" ||
          e.ctrlKey ||
          e.metaKey ||
          e.altKey ||
          e.defaultPrevented ||
          !appState.edit.session ||
          shortcutContextBlocked(e.target)
        )
          return;
        e.preventDefault();
        if (e.repeat || textureToggleHold) return;
        textureToggleHold = {
          session: appState.edit.session,
          original: popupTextureCheckbox().checked,
          start: performance.now(),
        };
        setPopupTextureView(!textureToggleHold.original);
      });
      window.addEventListener("keyup", (e) => {
        if (e.key.toLowerCase() !== "s" || !textureToggleHold) return;
        const hold = textureToggleHold;
        textureToggleHold = null;
        if (appState.edit.session === hold.session && performance.now() - hold.start >= 250)
          setPopupTextureView(hold.original);
      });
      window.addEventListener("blur", cancelTextureToggleHold);

      function enterPopupLighting() {
        appState.edit.session.mainLightSettings = {
          cursor: $("show-marker").value,
          follow: $("follow-mouse").checked,
        };
        $("show-marker").value = "off";
        $("show-marker").disabled = false;
        $("follow-mouse").checked = true;
        updatePanHint();
      }
      function leavePopupLighting() {
        cancelTextureToggleHold();
        const settings = appState.edit.session.mainLightSettings;
        if (settings) {
          $("show-marker").value = settings.cursor;
          $("follow-mouse").checked = settings.follow;
        }
        $("show-marker").disabled = false;
      }
      onShortcut((e) => {
        if (
          e.key !== "Enter" ||
          e.repeat ||
          e.defaultPrevented ||
          !appState.edit.session ||
          e.ctrlKey ||
          e.metaKey ||
          e.altKey ||
          e.shiftKey
        )
          return;
        if (
          e.target.closest(
            'textarea,select,[contenteditable],input:not([type="range"]):not([type="checkbox"])',
          ) ||
          shortcutModalOpen()
        )
          return;
        const button = $(appState.edit.session.mode === "modify" ? "modifier-apply" : "generator-apply"),
          focusedButton = e.target.closest("button");
        if (focusedButton && focusedButton !== button) return;
        e.preventDefault();
        if (!button.disabled) button.click();
      });
      function closeGeneration(apply) {
        if (!appState.edit.session) return;
        clearTimeout(generationTimer);
        const g = appState.edit.session;
        if (apply && !g.result) return;
        if (apply) {
          appState.textures[g.kind] = g.result;
          fileAccess.handles[g.kind] = null;
          fileAccess.stamps[g.kind] = null;
          fileAccess.errors[g.kind] = null;
          setTextureInfo(g.kind, g.kind === "normal" ? "Generated Normal Map" : "Generated Light Mask", g.result);
        } else {
          appState.edit.hints = g.hintSnapshot;
          appState.textures[g.kind] = g.previous;
          setTextureInfo(g.kind, g.info.name, g.info.size);
        }
        cancelSelectionGesture();
        leavePopupLighting();
        appState.edit.session = null;
        appState.edit.hints = null;
        appState.edit.undo = [];
        appState.edit.redo = [];
        $("generator").close();
        $("modifier").close();

        updateTextureButtons();
        rebuild();
        watchStatus();
      }
      for (const kind of ["normal", "mask"])
        $("generate-" + kind).addEventListener("click", () => openGeneration(kind));
      $("gen-preset").addEventListener("change", resetGenerationPreset);
      for (const key of [
        "strength",
        "normal-strength",
        "edge-width",
        "facets",
        "floor",
        "ceiling",
        "cavity",
        "merge",
      ])
        $("gen-" + key).addEventListener("input", previewGeneration);
      $("generator-apply").addEventListener("click", () => closeGeneration(true));
      for (const id of ["generator-cancel", "generator-close"])
        $(id).addEventListener("click", () => closeGeneration(false));
      $("generator").addEventListener("cancel", (e) => {
        e.preventDefault();
        closeGeneration(false);
      });

      function modifiedTexture(token) {
        const a = appState.textures.albedo,
          N = appState.width * appState.height,
          fg = new Uint8Array(N),
          bg = rgb($("bg-color").value);
        for (let p = 0; p < N; p++)
          fg[p] =
            a.data[p * 4 + 3] > 0 &&
            !(
              $("hide-bg").checked &&
              a.data[p * 4] === bg[0] &&
              a.data[p * 4 + 1] === bg[1] &&
              a.data[p * 4 + 2] === bg[2]
            );
        const data = applySurfaceHints(
          (token.working || token.base.data).slice(),
          fg,
          appState.edit.hints,
          token.kind,
          1,
        );
        if (token.kind === "normal" && token.mapStrength !== 100) {
          const gain = token.mapStrength / 100;
          for (let p = 0; p < N; p++) {
            if (!fg[p]) continue;
            const x = ((data[p * 4] / 255) * 2 - 1) * gain,
              y = ((data[p * 4 + 1] / 255) * 2 - 1) * gain,
              z = (data[p * 4 + 2] / 255) * 2 - 1,
              len = Math.hypot(x, y, z) || 1;
            data[p * 4] = Math.round((x / len + 1) * 127.5);
            data[p * 4 + 1] = Math.round((y / len + 1) * 127.5);
            data[p * 4 + 2] = Math.round((z / len + 1) * 127.5);
          }
        }
        return { w: appState.width, h: appState.height, data };
      }
      function openModify(kind) {
        if (!appState.textures.albedo) {
          reportIssue("Load an albedo texture before modifying.");
          return;
        }
        if (appState.edit.session) closeGeneration(false);
        appState.edit.hints = freshHints();
        appState.edit.undo = [];
        appState.edit.redo = [];
        $("hint-contiguous").checked = true;
        $("hint-selection-source").value = "albedo";
        const previous = appState.textures[kind];
        let base = previous;
        if (!base || base.w !== appState.width || base.h !== appState.height) {
          const data = new Uint8ClampedArray(appState.width * appState.height * 4);
          for (let p = 0; p < appState.width * appState.height; p++) {
            data.set(
              kind === "normal"
                ? [128, 128, 255, appState.textures.albedo.data[p * 4 + 3]]
                : [255, 255, 255, appState.textures.albedo.data[p * 4 + 3]],
              p * 4,
            );
          }
          base = { w: appState.width, h: appState.height, data };
        }
        setRangeValue("modifier-normal-strength", 100);
        $("modifier-normal-strength-value").textContent = "100%";
        appState.edit.session = {
          mode: "modify",
          kind,
          base,
          working: base.data.slice(),
          previous,
          mapStrength: 100,
          info: textureInfoSnapshot(kind),
          result: null,
          hintSnapshot: copyHints(appState.edit.hints),
        };
        fileAccess.versions[kind]++;
        $("modifier-title").textContent =
          kind === "normal" ? "Modify Normal Map" : "Modify Light Mask";
        $("modifier")
          .querySelectorAll(".normal-option")
          .forEach((el) => (el.hidden = kind !== "normal"));
        $("modifier")
          .querySelectorAll(".mask-option")
          .forEach((el) => (el.hidden = kind !== "mask"));
        $("hint-color").value = getSelectionColor();
        updateHintControls();
        updateTextureButtons();
        enterPopupLighting();
        $("modifier").show();
        positionToolPopup($("modifier"));
        previewGeneration();
        requestDraw();
      }
      $("modifier-normal-strength").addEventListener("input", () => {
        if (!appState.edit.session || appState.edit.session.mode !== "modify") return;
        saveHintUndo();
        appState.edit.session.mapStrength = Number($("modifier-normal-strength").value);
        $("modifier-normal-strength-value").textContent = appState.edit.session.mapStrength + "%";
        previewGeneration();
      });
      for (const kind of ["normal", "mask"])
        $("modify-" + kind).addEventListener("click", () => openModify(kind));
      $("modifier-apply").addEventListener("click", () => closeGeneration(true));
      for (const id of ["modifier-close", "modifier-cancel"])
        $(id).addEventListener("click", () => closeGeneration(false));
      $("modifier").addEventListener("cancel", (e) => {
        e.preventDefault();
        closeGeneration(false);
      });
      onShortcut((e) => {
        if (e.key !== "Escape" || !appState.edit.session || e.defaultPrevented) return;
        if (
          ($("art-color-picker") && !$("art-color-picker").hidden) ||
          $("tool-info-dialog").open ||
          $("texture-mismatch").open
        )
          return;
        e.preventDefault();
        closeGeneration(false);
      });
      for (const id of ["generator-show-texture", "modifier-show-texture"])
        $(id).addEventListener("change", requestDraw);
      return Object.freeze({
        cancelTextureToggleHold,
        modifiedTexture,
        popupTextureCheckbox,
        previewGeneration,
      });
    }

    function createSelectionEditor({
      appState,
      uiControls,
      processor,
      isSpaceHeld,
      modifiedTexture,
      position,
      previewGeneration,
      requestDraw,
      requestOverlayDraw,
      updateHandCursor,
    }) {
      const {
        element: $,
        setRangeValue,
        shortcutContextBlocked,
        onShortcut,
        renderShortcutText,
      } = uiControls;
      const { rgb, copyHints } = processor;
      const canvas = $("canvas");
      const viewport = $("canvas-viewport");
      let hintCursor = null;
      let sharedHintColor = "#65baff";
      try {
        const saved = localStorage.getItem("azimuth-hint-color");
        if (/^#[0-9a-f]{6}$/i.test(saved || "")) sharedHintColor = saved;
      } catch {}

      function ensureHints() {
        if (!appState.edit.hints || appState.edit.hints.w !== appState.width || appState.edit.hints.h !== appState.height) appState.edit.hints = freshHints();
      }

      function captureHintState() {
        return {
          hints: copyHints(appState.edit.hints),
          working: appState.edit.session?.working?.slice(),
          mapStrength: appState.edit.session?.mapStrength,
          source: $("hint-selection-source").value,
          contiguous: $("hint-contiguous").checked,
        };
      }
      function saveHintUndo() {
        appState.edit.redo = [];
        appState.edit.undo.push(captureHintState());
        if (appState.edit.undo.length > 20) appState.edit.undo.shift();
      }
      function restoreHintState(entry) {
        appState.edit.hints = copyHints(entry.hints);
        if (entry.working) appState.edit.session.working = entry.working.slice();
        if (entry.mapStrength !== undefined) {
          appState.edit.session.mapStrength = entry.mapStrength;
          setRangeValue("modifier-normal-strength", entry.mapStrength);
          $("modifier-normal-strength-value").textContent = entry.mapStrength + "%";
        }
        if (entry.source) $("hint-selection-source").value = entry.source;
        if (entry.contiguous !== undefined) $("hint-contiguous").checked = entry.contiguous;
        updateHintControls();
        previewGeneration();
        requestDraw();
      }
      function undoHintEdit() {
        if (!editingHints() || !appState.edit.undo.length) return;
        appState.edit.redo.push(captureHintState());
        restoreHintState(appState.edit.undo.pop());
      }
      function redoHintEdit() {
        if (!editingHints() || !appState.edit.redo.length) return;
        appState.edit.undo.push(captureHintState());
        restoreHintState(appState.edit.redo.pop());
      }

      function editingHints() {
        return appState.edit.session && appState.edit.session.mode === "modify";
      }
      function selectingHints() {
        return editingHints();
      }

      let selectionBoundaryRevision = 0,
        selectionBoundaryCache = null;
      function updateHintControls(selectionChanged = true) {
        if (selectionChanged) selectionBoundaryRevision++;
        ensureHints();
        appState.edit.hints.selectionColor = sharedHintColor;
        for (const option of $("hint-selection-source").options) {
          const texture =
            option.value === appState.edit.session?.kind && appState.edit.session?.working
              ? { w: appState.width, h: appState.height }
              : appState.textures[option.value];
          option.disabled = !texture || texture.w !== appState.width || texture.h !== appState.height;
        }
        const group = appState.edit.hints.groups[0];
        $("hint-color").value = appState.edit.hints.selectionColor || "#65baff";
        const hasNormalSelection = appState.edit.hints.surfaces.some((v) => v),
          hasMixedNormals = hasNormalSelection && selectionHasMixedNormals();
        $("hint-direction").value = group.direction;
        document.querySelectorAll("[data-direction]").forEach((button) => {
          const active = button.dataset.direction === group.direction;
          button.disabled =
            !hasNormalSelection || (button.dataset.direction === "auto" && !hasMixedNormals);
          button.classList.toggle("selected", active);
          button.setAttribute("aria-pressed", String(active));
        });
        $("hint-tilt").max = Math.max(85, Math.ceil(group.tilt));
        setRangeValue("hint-tilt", group.tilt);
        $("hint-tilt-value").textContent = Number(group.tilt.toFixed(1)) + "Â°";
        $("hint-tilt").disabled = !hasNormalSelection;
        $("hint-tilt-label").classList.toggle("disabled", !hasNormalSelection);
        const hasLightSelection = appState.edit.hints.light.some((value) => value !== 0);
        $("hint-brightness").disabled = !hasLightSelection;
        $("hint-brightness").closest("label").classList.toggle("disabled", !hasLightSelection);
        $("hint-brightness-label").textContent = "Brightness";
        $("hint-relative").value = appState.edit.hints.relativeBrightness ? "relative" : "fixed";
        $("hint-brightness").min = appState.edit.hints.relativeBrightness ? -100 : 0;
        setRangeValue("hint-brightness", appState.edit.hints.brightness ?? 100);
        $("hint-brightness-value").textContent =
          (appState.edit.hints.relativeBrightness && appState.edit.hints.brightness > 0 ? "+" : "") +
          Math.round(appState.edit.hints.brightness ?? 100) +
          "%";
        $("hint-undo").disabled = !appState.edit.undo.length;
        $("hint-redo").disabled = !appState.edit.redo.length;
        $("hint-fill-holes").disabled = !findSelectionHoles().length;
      }
      function selectionSourceTexture() {
        const kind = $("hint-selection-source").value;
        if (editingHints() && kind === appState.edit.session.kind) {
          if (
            !appState.edit.session.selectionTexture ||
            appState.edit.session.selectionTexture.data !== appState.edit.session.working
          )
            appState.edit.session.selectionTexture = { w: appState.width, h: appState.height, data: appState.edit.session.working };
          return appState.edit.session.selectionTexture;
        }
        return appState.textures[kind];
      }
      $("hint-selection-source").addEventListener("change", () => {
        if (!editingHints()) return;
        saveHintUndo();
        commitSelectionEdit();
        appState.edit.hints.surfaces.fill(0);
        appState.edit.hints.light.fill(0);
        appState.edit.hints.mergedOutline = null;
        colorClusterCache = null;
        updateHintControls();
        previewGeneration();
        requestDraw();
      });
      let colorClusterCache = null;
      function cachedColorClusters() {
        const a = selectionSourceTexture(),
          albedo = appState.textures.albedo,
          bg = $("bg-color").value,
          hide = $("hide-bg").checked;
        if (
          colorClusterCache &&
          colorClusterCache.source === a &&
          colorClusterCache.albedo === albedo &&
          colorClusterCache.bg === bg &&
          colorClusterCache.hide === hide
        )
          return colorClusterCache;
        const N = appState.width * appState.height,
          labels = new Int32Array(N),
          colors = new Map(),
          clusters = [],
          background = rgb(bg);
        labels.fill(-1);
        const valid = (p) =>
          a &&
          a.w === appState.width &&
          a.h === appState.height &&
          a.data[p * 4 + 3] > 0 &&
          albedo.data[p * 4 + 3] > 0 &&
          !(
            hide &&
            albedo.data[p * 4] === background[0] &&
            albedo.data[p * 4 + 1] === background[1] &&
            albedo.data[p * 4 + 2] === background[2]
          );
        const key = (p) => (a.data[p * 4] << 16) | (a.data[p * 4 + 1] << 8) | a.data[p * 4 + 2];
        for (let p = 0; p < N; p++) {
          if (!valid(p)) continue;
          const k = key(p);
          if (!colors.has(k)) colors.set(k, []);
          colors.get(k).push(p);
        }
        for (let start = 0; start < N; start++) {
          if (labels[start] >= 0 || !valid(start)) continue;
          const id = clusters.length,
            pixels = [start],
            color = key(start);
          labels[start] = id;
          for (let i = 0; i < pixels.length; i++) {
            const p = pixels[i],
              x = p % appState.width,
              y = (p / appState.width) | 0,
              neighbors = [];
            if (x) neighbors.push(p - 1);
            if (x < appState.width - 1) neighbors.push(p + 1);
            if (y) neighbors.push(p - appState.width);
            if (y < appState.height - 1) neighbors.push(p + appState.width);
            for (const q of neighbors)
              if (labels[q] < 0 && valid(q) && key(q) === color) {
                labels[q] = id;
                pixels.push(q);
              }
          }
          clusters.push(pixels);
        }
        colorClusterCache = { source: a, albedo, bg, hide, labels, colors, clusters };
        return colorClusterCache;
      }
      function hintPixels(e) {
        const r = canvas.getBoundingClientRect(),
          x = Math.floor(((e.clientX - r.left) * appState.width) / r.width),
          y = Math.floor(((e.clientY - r.top) * appState.height) / r.height);
        if (x < 0 || x >= appState.width || y < 0 || y >= appState.height) return [];
        const cache = cachedColorClusters(),
          p = y * appState.width + x,
          id = cache.labels[p];
        if (id < 0) return [];
        const a = cache.source,
          key = (a.data[p * 4] << 16) | (a.data[p * 4 + 1] << 8) | a.data[p * 4 + 2];
        return $("hint-contiguous").checked ? cache.clusters[id] : cache.colors.get(key);
      }
      function commitSelectionEdit() {
        if (!editingHints()) return;
        const token = appState.edit.session,
          strength = token.mapStrength;
        token.mapStrength = 100;
        token.working = modifiedTexture(token).data;
        token.mapStrength = strength;
        appState.edit.hints.groups = [{ id: 1, direction: "none", tilt: 45 }];
        appState.edit.hints.brightness = appState.edit.hints.relativeBrightness ? 0 : 100;
      }
      function selectionOriginalTilt() {
        let sum = 0,
          count = 0;
        const data = appState.edit.session.working;
        for (let p = 0; p < appState.width * appState.height; p++)
          if (appState.edit.hints.surfaces[p]) {
            const v = [0, 1, 2].map((c) => (data[p * 4 + c] / 255) * 2 - 1),
              len = Math.hypot(...v) || 1;
            sum += (Math.acos(Math.max(-1, Math.min(1, v[2] / len))) * 180) / Math.PI;
            count++;
          }
        return count ? sum / count : 45;
      }
      function selectionHasMixedNormals() {
        if (!editingHints() || appState.edit.session.kind !== "normal") return false;
        const data = appState.edit.session.working;
        let first = null;
        for (let p = 0; p < appState.width * appState.height; p++) {
          if (!appState.edit.hints.surfaces[p]) continue;
          const v = [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]];
          if (!first) first = v;
          else if (v.some((value, c) => value !== first[c])) return true;
        }
        return false;
      }
      function averageSelectionDirection() {
        const sum = [0, 0, 0],
          data = appState.edit.session.working;
        for (let p = 0; p < appState.width * appState.height; p++)
          if (appState.edit.hints.surfaces[p]) {
            const v = [0, 1, 2].map((c) => (data[p * 4 + c] / 255) * 2 - 1),
              len = Math.hypot(...v) || 1;
            for (let c = 0; c < 3; c++) sum[c] += v[c] / len;
          }
        const len = Math.hypot(...sum) || 1;
        return sum.map((v) => v / len);
      }
      function markHints(e, first = false) {
        const pixels = hintPixels(e);
        if (!pixels.length) {
          if (!e.altKey) clearModifierSelection();
          return;
        }
        if (e.altKey) {
          const selection = appState.edit.session.kind === "normal" ? appState.edit.hints.surfaces : appState.edit.hints.light;
          if (!pixels.some((p) => selection[p])) return;
          saveHintUndo();
          commitSelectionEdit();
          for (const p of pixels) {
            selection[p] = 0;
            if (appState.edit.hints.mergedOutline) appState.edit.hints.mergedOutline[p] = 0;
          }
          if (appState.edit.session.kind === "normal") {
            const tilt = selectionOriginalTilt();
            appState.edit.hints.groups[0].tilt = tilt;
            appState.edit.hints.groups[0].baseTilt = tilt;
          }
          updateHintControls();
          previewGeneration();
          requestDraw();
          return;
        }
        if (first) saveHintUndo();
        const selection = appState.edit.session.kind === "normal" ? appState.edit.hints.surfaces : appState.edit.hints.light,
          removing = pixels.every((p) => selection[p] === 1);
        if (removing || !e.shiftKey) commitSelectionEdit();
        if (appState.edit.hints.mergedOutline) for (const p of pixels) appState.edit.hints.mergedOutline[p] = 0;
        if (appState.edit.session.kind === "normal") {
          const id = 1,
            toggle = pixels.every((p) => appState.edit.hints.surfaces[p] === id);
          if (!toggle && !e.shiftKey) appState.edit.hints.surfaces.fill(0);
          for (const p of pixels) appState.edit.hints.surfaces[p] = toggle ? 0 : id;
        } else {
          const toggle = pixels.every((p) => appState.edit.hints.light[p] === 1),
            adding = !toggle;
          if (adding && !e.shiftKey) appState.edit.hints.light.fill(0);
          const hadSelection = appState.edit.hints.light.some((value) => value === 1);
          if (adding && !hadSelection && !appState.edit.hints.relativeBrightness) {
            const source = appState.edit.session.working;
            let sum = 0;
            for (const p of pixels)
              sum +=
                0.2126 * source[p * 4] + 0.7152 * source[p * 4 + 1] + 0.0722 * source[p * 4 + 2];
            appState.edit.hints.brightness = Number(((sum / pixels.length / 255) * 100).toFixed(4));
          }
          for (const p of pixels) appState.edit.hints.light[p] = adding ? 1 : 0;
        }
        if (appState.edit.session.kind === "normal" && appState.edit.hints.groups[0].direction === "none") {
          const tilt = selectionOriginalTilt();
          appState.edit.hints.groups[0].tilt = tilt;
          appState.edit.hints.groups[0].baseTilt = tilt;
        }
        updateHintControls();
        previewGeneration();
        requestDraw();
      }

      function drawHintOverlay(ctx, rect, viewportRect, pixelRatio) {
        if (!editingHints() || !appState.edit.hints) return;
        const scale = rect.width / appState.width;
        ctx.save();
        ctx.setTransform(
          pixelRatio * scale,
          0,
          0,
          pixelRatio * scale,
          (rect.left - viewportRect.left) * pixelRatio,
          (rect.top - viewportRect.top) * pixelRatio,
        );
        const selection = appState.edit.session.kind === "normal" ? appState.edit.hints.surfaces : appState.edit.hints.light;
        if (
          !selectionBoundaryCache ||
          selectionBoundaryCache.selection !== selection ||
          selectionBoundaryCache.revision !== selectionBoundaryRevision ||
          selectionBoundaryCache.w !== appState.width ||
          selectionBoundaryCache.h !== appState.height
        ) {
          const boundary = new Path2D();
          for (let p = 0; p < appState.width * appState.height; p++) {
            if (!selection[p]) continue;
            const x = p % appState.width,
              y = (p / appState.width) | 0;
            if (y === 0 || !selection[p - appState.width]) {
              boundary.moveTo(x, y);
              boundary.lineTo(x + 1, y);
            }
            if (x === appState.width - 1 || !selection[p + 1]) {
              boundary.moveTo(x + 1, y);
              boundary.lineTo(x + 1, y + 1);
            }
            if (y === appState.height - 1 || !selection[p + appState.width]) {
              boundary.moveTo(x + 1, y + 1);
              boundary.lineTo(x, y + 1);
            }
            if (x === 0 || !selection[p - 1]) {
              boundary.moveTo(x, y + 1);
              boundary.lineTo(x, y);
            }
          }

          selectionBoundaryCache = {
            selection,
            revision: selectionBoundaryRevision,
            w: appState.width,
            h: appState.height,
            path: boundary,
          };
        }
        const boundary = selectionBoundaryCache.path;
        ctx.lineWidth = 1 / scale;
        ctx.setLineDash([4 / scale, 4 / scale]);
        const phase = (Date.now() / 100) % 8;
        ctx.lineDashOffset = -phase / scale;
        ctx.strokeStyle = appState.edit.hints.selectionColor || "#65baff";
        ctx.stroke(boundary);
        ctx.lineDashOffset = (4 - phase) / scale;
        ctx.strokeStyle = "#101318";
        ctx.stroke(boundary);

        ctx.restore();
      }
      setInterval(() => {
        if (editingHints()) requestOverlayDraw();
      }, 100);
      $("hint-color").addEventListener("input", () => {
        sharedHintColor = $("hint-color").value;
        appState.edit.hints.selectionColor = sharedHintColor;
        try {
          localStorage.setItem("azimuth-hint-color", sharedHintColor);
        } catch {}
        requestOverlayDraw();
      });
      document.querySelectorAll("[data-direction]").forEach((button) =>
        button.addEventListener("click", () => {
          ensureHints();
          if (!appState.edit.hints.surfaces.some((v) => v)) return;
          saveHintUndo();
          const group = appState.edit.hints.groups[0];
          group.direction = button.dataset.direction;
          if (group.direction === "auto") {
            group.average = averageSelectionDirection();
            group.tilt = (Math.acos(Math.max(-1, Math.min(1, group.average[2]))) * 180) / Math.PI;
          }
          updateHintControls(false);
          previewGeneration();
        }),
      );
      for (const id of ["hint-direction", "hint-tilt"])
        $(id).addEventListener("input", () => {
          ensureHints();
          saveHintUndo();
          const group = appState.edit.hints.groups[0];
          if (group) {
            if (id === "hint-tilt" && group.direction === "none") {
              group.direction = "existing";
              group.baseTilt = selectionOriginalTilt();
            } else if (id === "hint-direction") group.direction = $("hint-direction").value;
            group.tilt = Number($("hint-tilt").value);
          }
          $("hint-tilt-value").textContent = $("hint-tilt").value + "Â°";
          updateHintControls(false);
          previewGeneration();
        });
      $("hint-relative").addEventListener("change", () => {
        ensureHints();
        saveHintUndo();
        const relative = $("hint-relative").value === "relative";
        let brightness = 0;
        if (!relative) {
          const data = modifiedTexture(appState.edit.session).data;
          let sum = 0,
            count = 0;
          for (let p = 0; p < appState.width * appState.height; p++)
            if (appState.edit.hints.light[p]) {
              sum += 0.2126 * data[p * 4] + 0.7152 * data[p * 4 + 1] + 0.0722 * data[p * 4 + 2];
              count++;
            }
          brightness = count ? Number(((sum / count / 255) * 100).toFixed(4)) : 100;
        }
        appState.edit.hints.relativeBrightness = relative;
        appState.edit.hints.brightness = brightness;
        updateHintControls(false);
        previewGeneration();
      });
      $("hint-brightness").addEventListener("input", () => {
        saveHintUndo();
        appState.edit.hints.brightness = Number($("hint-brightness").value);
        $("hint-brightness-value").textContent = appState.edit.hints.brightness + "%";
        updateHintControls(false);
        previewGeneration();
      });
      onShortcut((e) => {
        if (
          !editingHints() ||
          e.defaultPrevented ||
          !(e.ctrlKey || e.metaKey) ||
          e.altKey ||
          e.key.toLowerCase() !== "z"
        )
          return;
        if (
          shortcutContextBlocked(e.target)
        )
          return;
        e.preventDefault();
        const button = $(e.shiftKey ? "hint-redo" : "hint-undo");
        if (!button.disabled) {
          button.click();
          button.animate(
            [
              { backgroundColor: "#355574", color: "#fff", borderColor: "#c8d7e8" },
              { backgroundColor: "#272d36", color: "#a8b7c8", borderColor: "#596373" },
            ],
            { duration: 350, easing: "ease-out" },
          );
        }
      });
      $("hint-undo").addEventListener("click", undoHintEdit);
      $("hint-redo").addEventListener("click", redoHintEdit);
      let selectionHoleCache = null;
      function findSelectionHoles() {
        if (!editingHints()) return [];
        const selection = appState.edit.session.kind === "normal" ? appState.edit.hints.surfaces : appState.edit.hints.light,
          source = selectionSourceTexture(),
          albedo = appState.textures.albedo,
          bg = $("bg-color").value,
          hide = $("hide-bg").checked;
        if (
          selectionHoleCache &&
          selectionHoleCache.selection === selection &&
          selectionHoleCache.revision === selectionBoundaryRevision &&
          selectionHoleCache.source === source &&
          selectionHoleCache.albedo === albedo &&
          selectionHoleCache.bg === bg &&
          selectionHoleCache.hide === hide
        )
          return selectionHoleCache.pixels;
        const pixels = computeSelectionHoles();
        selectionHoleCache = {
          selection,
          revision: selectionBoundaryRevision,
          source,
          albedo,
          bg,
          hide,
          pixels,
        };
        return pixels;
      }
      function computeSelectionHoles() {
        if (!editingHints()) return [];
        const selection = appState.edit.session.kind === "normal" ? appState.edit.hints.surfaces : appState.edit.hints.light,
          a = appState.textures.albedo,
          N = appState.width * appState.height,
          seen = new Uint8Array(N),
          added = [],
          bg = rgb($("bg-color").value),
          hide = $("hide-bg").checked;
        const clusters = cachedColorClusters(),
          selectedClusters = new Set();
        for (let p = 0; p < N; p++)
          if (selection[p] && clusters.labels[p] >= 0) {
            selectedClusters.add(clusters.labels[p]);
            if (selectedClusters.size > 1) break;
          }
        if (selectedClusters.size < 2) return [];
        const valid = (p) =>
          a.data[p * 4 + 3] > 0 &&
          !(
            hide &&
            a.data[p * 4] === bg[0] &&
            a.data[p * 4 + 1] === bg[1] &&
            a.data[p * 4 + 2] === bg[2]
          );
        for (let start = 0; start < N; start++) {
          if (seen[start] || selection[start] || !valid(start)) continue;
          const pixels = [start];
          seen[start] = 1;
          let enclosed = true;
          for (let i = 0; i < pixels.length; i++) {
            const p = pixels[i],
              x = p % appState.width,
              y = (p / appState.width) | 0;
            if (!x || x === appState.width - 1 || !y || y === appState.height - 1) enclosed = false;
            const neighbors = [];
            if (x) neighbors.push(p - 1);
            if (x < appState.width - 1) neighbors.push(p + 1);
            if (y) neighbors.push(p - appState.width);
            if (y < appState.height - 1) neighbors.push(p + appState.width);
            for (const q of neighbors) {
              if (!valid(q)) {
                enclosed = false;
                continue;
              }
              if (!selection[q] && !seen[q]) {
                seen[q] = 1;
                pixels.push(q);
              }
            }
          }
          if (enclosed && pixels.length <= 4) added.push(...pixels);
        }
        return added;
      }
      function fillSelectionHoles() {
        const added = findSelectionHoles();
        if (!added.length) return;
        const selection = appState.edit.session.kind === "normal" ? appState.edit.hints.surfaces : appState.edit.hints.light;
        saveHintUndo();
        for (const p of added) {
          selection[p] = 1;
          if (appState.edit.hints.mergedOutline) appState.edit.hints.mergedOutline[p] = 0;
        }
        updateHintControls();
        previewGeneration();
        requestDraw();
      }
      $("hint-fill-holes").addEventListener("click", fillSelectionHoles);
      function mergeSelectedOutlines() {
        if (!editingHints()) return;
        const a = appState.textures.albedo,
          selection = appState.edit.session.kind === "normal" ? appState.edit.hints.surfaces : appState.edit.hints.light,
          bg = rgb($("bg-color").value),
          added = [],
          seen = new Uint8Array(appState.width * appState.height),
          merged = appState.edit.hints.mergedOutline || new Uint8Array(appState.width * appState.height);
        const valid = (p) =>
          p >= 0 &&
          p < appState.width * appState.height &&
          a.data[p * 4 + 3] > 0 &&
          !(
            $("hide-bg").checked &&
            a.data[p * 4] === bg[0] &&
            a.data[p * 4 + 1] === bg[1] &&
            a.data[p * 4 + 2] === bg[2]
          );
        const same = (p, q) =>
          valid(q) &&
          a.data[p * 4] === a.data[q * 4] &&
          a.data[p * 4 + 1] === a.data[q * 4 + 1] &&
          a.data[p * 4 + 2] === a.data[q * 4 + 2];
        const brightness = (p) =>
          0.2126 * a.data[p * 4] + 0.7152 * a.data[p * 4 + 1] + 0.0722 * a.data[p * 4 + 2];
        const neighbors = (p) => {
          const x = p % appState.width,
            y = (p / appState.width) | 0,
            n = [];
          if (x) n.push(p - 1);
          if (x < appState.width - 1) n.push(p + 1);
          if (y) n.push(p - appState.width);
          if (y < appState.height - 1) n.push(p + appState.width);
          return n;
        };
        for (let start = 0; start < appState.width * appState.height; start++) {
          if (seen[start] || !valid(start)) continue;
          const cluster = [start];
          seen[start] = 1;
          let thick = false;
          for (let i = 0; i < cluster.length; i++) {
            const p = cluster[i],
              x = p % appState.width,
              y = (p / appState.width) | 0;
            for (const q of neighbors(p))
              if (!seen[q] && same(start, q)) {
                seen[q] = 1;
                cluster.push(q);
              }
            if (
              x < appState.width - 1 &&
              y < appState.height - 1 &&
              same(start, p + 1) &&
              same(start, p + appState.width) &&
              same(start, p + appState.width + 1)
            )
              thick = true;
          }
          if (thick) continue;
          for (const p of cluster)
            if (
              !selection[p] &&
              neighbors(p).some(
                (q) => selection[q] && !merged[q] && brightness(p) + 6 < brightness(q) * 0.8,
              )
            )
              added.push(p);
        }
        if (!added.length) return;
        saveHintUndo();
        appState.edit.hints.mergedOutline = merged;
        for (const p of added) {
          selection[p] = 1;
          merged[p] = 1;
        }
        updateHintControls();
        previewGeneration();
        requestDraw();
      }
      $("hint-merge-outlines").addEventListener("click", mergeSelectedOutlines);
      function clearModifierSelection() {
        if (!editingHints()) return;
        const selection = appState.edit.session.kind === "normal" ? appState.edit.hints.surfaces : appState.edit.hints.light;
        if (!selection.some((v) => v)) return;
        saveHintUndo();
        commitSelectionEdit();
        appState.edit.hints.mergedOutline = null;
        if (appState.edit.session.kind === "normal") {
          appState.edit.hints.surfaces.fill(0);
          appState.edit.hints.groups = [{ id: 1, direction: "none", tilt: 45 }];
        } else appState.edit.hints.light.fill(0);
        updateHintControls();
        previewGeneration();
        requestDraw();
      }
      $("hint-clear").addEventListener("click", clearModifierSelection);
      onShortcut((e) => {
        if (
          !editingHints() ||
          e.defaultPrevented ||
          !e.ctrlKey ||
          e.shiftKey ||
          e.altKey ||
          e.metaKey ||
          shortcutContextBlocked(e.target)
        )
          return;
        const id = { d: "hint-clear", f: "hint-fill-holes", m: "hint-merge-outlines" }[
          e.key.toLowerCase()
        ];
        if (!id) return;
        e.preventDefault();
        const button = $(id);
        if (!button.disabled) button.click();
      });

      let selectionTool = "wand",
        selectionGesture = null;
      try {
        const saved = localStorage.getItem("azimuth-selection-tool");
        if (["wand", "pencil", "marquee"].includes(saved)) selectionTool = saved;
      } catch {}
      function updateSelectionTools() {
        document.querySelectorAll("[data-selection-tool]").forEach((button) => {
          const active = button.dataset.selectionTool === selectionTool;
          button.classList.toggle("selected", active);
          button.setAttribute("aria-pressed", String(active));
        });
        $("hint-selection-source").disabled = selectionTool !== "wand";
        $("hint-contiguous").disabled = selectionTool !== "wand";
        $("hint-contiguous")
          .closest("label")
          .classList.toggle("contiguous-disabled", selectionTool !== "wand");
        const lines =
          selectionTool === "wand"
            ? [
                "Click - Select/deselect pixel cluster",
                "Drag - Select multiple pixel clusters",
                "Shift+Click or Drag - Add to selection",
                "Alt+Click or Drag - Remove from selection",
              ]
            : selectionTool === "pencil"
              ? [
                  "Click or Drag - Draw pixel selection",
                  "Shift+Drag - Add to selection",
                  "Alt+Drag - Remove from selection",
                ]
              : [
                  "Drag - Select a rectangle",
                  "Shift+Drag - Add to selection",
                  "Alt+Drag - Remove from selection",
                ];
        const help = $("hint-help");
        help.replaceChildren();
        for (const text of lines) {
          const li = document.createElement("li");
          renderShortcutText(li, text);
          help.appendChild(li);
        }
      }
      onShortcut((e) => {
        if (
          !editingHints() ||
          e.defaultPrevented ||
          e.ctrlKey ||
          e.metaKey ||
          e.altKey ||
          shortcutContextBlocked(e.target)
        )
          return;
        const tool = { w: "wand", b: "pencil", m: "marquee" }[e.key.toLowerCase()];
        if (tool) {
          e.preventDefault();
          document.querySelector('[data-selection-tool="' + tool + '"]').click();
        }
      });
      document.querySelectorAll("[data-selection-tool]").forEach((button) =>
        button.addEventListener("click", () => {
          selectionTool = button.dataset.selectionTool;
          try {
            localStorage.setItem("azimuth-selection-tool", selectionTool);
          } catch {}
          updateSelectionTools();
          updateHandCursor();
        }),
      );
      updateSelectionTools();
      function selectionPoint(e) {
        const rect = canvas.getBoundingClientRect();
        return {
          x: Math.floor(((e.clientX - rect.left) * appState.width) / rect.width),
          y: Math.floor(((e.clientY - rect.top) * appState.height) / rect.height),
        };
      }
      function selectablePixel(x, y) {
        if (x < 0 || x >= appState.width || y < 0 || y >= appState.height) return false;
        const data = appState.textures.albedo.data,
          p = (y * appState.width + x) * 4,
          bg = rgb($("bg-color").value);
        return (
          data[p + 3] > 0 &&
          !(
            $("hide-bg").checked &&
            data[p] === bg[0] &&
            data[p + 1] === bg[1] &&
            data[p + 2] === bg[2]
          )
        );
      }
      function applySelectionPixel(x, y, subtract) {
        if (!selectablePixel(x, y)) return;
        const p = y * appState.width + x,
          selection = appState.edit.session.kind === "normal" ? appState.edit.hints.surfaces : appState.edit.hints.light;
        selection[p] = subtract ? 0 : 1;
        if (appState.edit.hints.mergedOutline) appState.edit.hints.mergedOutline[p] = 0;
      }
      function selectionLine(from, to, subtract) {
        let x = from.x,
          y = from.y;
        const dx = Math.abs(to.x - x),
          sx = x < to.x ? 1 : -1,
          dy = -Math.abs(to.y - y),
          sy = y < to.y ? 1 : -1;
        let err = dx + dy;
        for (;;) {
          applySelectionPixel(x, y, subtract);
          if (x === to.x && y === to.y) break;
          const e = 2 * err;
          if (e >= dy) {
            err += dy;
            x += sx;
          }
          if (e <= dx) {
            err += dx;
            y += sy;
          }
        }
      }
      function refreshDrawnSelection() {
        if (appState.edit.session.kind === "normal" && appState.edit.hints.groups[0].direction === "none") {
          const tilt = selectionOriginalTilt();
          appState.edit.hints.groups[0].tilt = tilt;
          appState.edit.hints.groups[0].baseTilt = tilt;
        }
        updateHintControls();
        previewGeneration();
        requestDraw();
      }
      const marqueePreview = document.createElement("div");
      marqueePreview.className = "selection-marquee-preview";
      marqueePreview.hidden = true;
      viewport.parentElement.appendChild(marqueePreview);
      function updateMarqueePreview() {
        const g = selectionGesture,
          rect = canvas.getBoundingClientRect(),
          shell = viewport.parentElement.getBoundingClientRect(),
          left = Math.max(0, Math.min(g.start.x, g.last.x)),
          top = Math.max(0, Math.min(g.start.y, g.last.y)),
          right = Math.min(appState.width - 1, Math.max(g.start.x, g.last.x)),
          bottom = Math.min(appState.height - 1, Math.max(g.start.y, g.last.y));
        marqueePreview.hidden = right < left || bottom < top;
        marqueePreview.style.left = rect.left - shell.left + (left * rect.width) / appState.width + "px";
        marqueePreview.style.top = rect.top - shell.top + (top * rect.height) / appState.height + "px";
        marqueePreview.style.width = ((right - left + 1) * rect.width) / appState.width + "px";
        marqueePreview.style.height = ((bottom - top + 1) * rect.height) / appState.height + "px";
      }
      function wandStrokePixel(g, x, y) {
        if (x < 0 || x >= appState.width || y < 0 || y >= appState.height) return false;
        const p = y * appState.width + x,
          id = g.cache.labels[p];
        if (id < 0) return false;
        const data = g.cache.source.data,
          key = g.contiguous
            ? id
            : (data[p * 4] << 16) | (data[p * 4 + 1] << 8) | data[p * 4 + 2];
        if (g.visited.has(key)) return false;
        g.visited.add(key);
        const pixels = g.contiguous ? g.cache.clusters[id] : g.cache.colors.get(key),
          selection = appState.edit.session.kind === "normal" ? appState.edit.hints.surfaces : appState.edit.hints.light;
        if (!g.undoSaved) {
          saveHintUndo();
          g.undoSaved = true;
        }
        let changed = false;
        for (const pixel of pixels) {
          const value = g.subtract ? 0 : 1;
          if (selection[pixel] !== value) {
            selection[pixel] = value;
            changed = true;
          }
          if (appState.edit.hints.mergedOutline) appState.edit.hints.mergedOutline[pixel] = 0;
        }
        return changed;
      }
      function wandStrokeLine(g, from, to) {
        let x = Math.max(-1, Math.min(appState.width, from.x)),
          y = Math.max(-1, Math.min(appState.height, from.y));
        const tx = Math.max(-1, Math.min(appState.width, to.x)),
          ty = Math.max(-1, Math.min(appState.height, to.y)),
          dx = Math.abs(tx - x),
          sx = x < tx ? 1 : -1,
          dy = -Math.abs(ty - y),
          sy = y < ty ? 1 : -1;
        let err = dx + dy,
          changed = false;
        for (;;) {
          changed = wandStrokePixel(g, x, y) || changed;
          if (x === tx && y === ty) break;
          const e = 2 * err;
          if (e >= dy) {
            err += dy;
            x += sx;
          }
          if (e <= dx) {
            err += dx;
            y += sy;
          }
        }
        return changed;
      }
      viewport.addEventListener(
        "pointerdown",
        (e) => {
          if (
            !selectingHints() ||
            selectionTool !== "wand" ||
            isSpaceHeld() ||
            e.ctrlKey ||
            e.button !== 0 ||
            e.target !== canvas
          )
            return;
          const pixels = hintPixels(e);
          if (!pixels.length) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          const selection = appState.edit.session.kind === "normal" ? appState.edit.hints.surfaces : appState.edit.hints.light,
            undoSaved = !e.altKey || pixels.some((p) => selection[p]);
          const point = selectionPoint(e),
            cache = cachedColorClusters();
          markHints(e, true);
          selectionGesture = {
            id: e.pointerId,
            tool: "wand",
            subtract: e.altKey,
            start: point,
            last: point,
            clientX: e.clientX,
            clientY: e.clientY,
            cache,
            contiguous: $("hint-contiguous").checked,
            visited: new Set(),
            dragged: false,
            undoSaved,
          };
          hintCursor = { x: e.clientX, y: e.clientY };
          viewport.setPointerCapture(e.pointerId);
        },
        true,
      );
      viewport.addEventListener(
        "pointermove",
        (e) => {
          const g = selectionGesture;
          if (!g || g.tool !== "wand" || g.id !== e.pointerId) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          const point = selectionPoint(e);
          let changed = false;
          if (!g.dragged && Math.hypot(e.clientX - g.clientX, e.clientY - g.clientY) >= 3) {
            g.dragged = true;
            changed = wandStrokePixel(g, g.start.x, g.start.y);
          }
          if (g.dragged) {
            changed = wandStrokeLine(g, g.last, point) || changed;
            g.last = point;
            if (changed) refreshDrawnSelection();
          }
          hintCursor = { x: e.clientX, y: e.clientY };
          if ($("follow-mouse").checked) position(e);
          else requestOverlayDraw();
        },
        true,
      );

      viewport.addEventListener(
        "pointerdown",
        (e) => {
          if (
            !selectingHints() ||
            selectionTool === "wand" ||
            isSpaceHeld() ||
            e.ctrlKey ||
            e.button !== 0
          )
            return;
          e.preventDefault();
          e.stopImmediatePropagation();
          saveHintUndo();
          const subtract = e.altKey,
            add = e.shiftKey && !subtract;
          if (!add) commitSelectionEdit();
          const selection = appState.edit.session.kind === "normal" ? appState.edit.hints.surfaces : appState.edit.hints.light;
          if (!add && !subtract) {
            selection.fill(0);
            appState.edit.hints.mergedOutline = null;
          }
          const point = selectionPoint(e);
          selectionGesture = {
            id: e.pointerId,
            tool: selectionTool,
            subtract,
            start: point,
            last: point,
          };
          viewport.setPointerCapture(e.pointerId);
          if (selectionTool === "pencil") {
            applySelectionPixel(point.x, point.y, subtract);
            refreshDrawnSelection();
          } else updateMarqueePreview();
        },
        true,
      );
      viewport.addEventListener(
        "pointermove",
        (e) => {
          const g = selectionGesture;
          if (!g || g.id !== e.pointerId) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          const point = selectionPoint(e);
          if (g.tool === "pencil") {
            selectionLine(g.last, point, g.subtract);
            g.last = point;
            refreshDrawnSelection();
          } else {
            g.last = point;
            updateMarqueePreview();
          }
          if ($("follow-mouse").checked) position(e);
        },
        true,
      );
      function endSelectionGesture(e) {
        const g = selectionGesture;
        if (!g || g.id !== e.pointerId) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (g.tool === "marquee" && e.type !== "pointercancel") {
          g.last = selectionPoint(e);
          const left = Math.max(0, Math.min(g.start.x, g.last.x)),
            right = Math.min(appState.width - 1, Math.max(g.start.x, g.last.x)),
            top = Math.max(0, Math.min(g.start.y, g.last.y)),
            bottom = Math.min(appState.height - 1, Math.max(g.start.y, g.last.y));
          for (let y = top; y <= bottom; y++)
            for (let x = left; x <= right; x++) applySelectionPixel(x, y, g.subtract);
        }
        selectionGesture = null;
        marqueePreview.hidden = true;
        if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId);
        refreshDrawnSelection();
      }
      for (const type of ["pointerup", "pointercancel"])
        viewport.addEventListener(type, endSelectionGesture, true);

      let selectionShiftHeld = false,
        selectionAltHeld = false;
      const selectionCursorSet = {};
      for (const tool of ["wand", "pencil", "marquee"])
        for (const mode of ["normal", "add", "subtract"]) {
          const icon =
              tool === "wand"
                ? '<g transform="translate(.5 1.5) scale(.9)"><path d="m5 8 12 12 3-3L8 5zM7 2v4M5 4h4M11 9l-2 2"/></g>'
                : tool === "pencil"
                  ? '<g transform="translate(1 2) scale(.75)"><path d="m4 16-1 5 5-1L20 8l-5-5zM13 5l5 5M4 16l4 4"/></g>'
                  : '<path d="M10 4v5M10 15v5M2 12h5M13 12h5"/>',
            badge =
              mode === "add"
                ? '<path d="M23 4v6M20 7h6"/>'
                : mode === "subtract"
                  ? '<path d="M20 7h6"/>'
                  : "";
          const adjustedBadge =
            tool === "marquee" ? '<g transform="translate(0 -2)">' + badge + "</g>" : badge;
          const svg =
              '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><g fill="none" stroke="#111820" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
              icon +
              adjustedBadge +
              '</g><g fill="none" stroke="#f2f5f8" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' +
              icon +
              adjustedBadge +
              "</g></svg>",
            hotspot = tool === "pencil" ? "3 18" : tool === "wand" ? "6 6" : "10 12";
          selectionCursorSet[tool + "-" + mode] =
            'url("data:image/svg+xml,' +
            encodeURIComponent(svg) +
            '") ' +
            hotspot +
            ", crosshair";
        }

      window.addEventListener("keydown", (e) => {
        if (e.key === "Shift") selectionShiftHeld = true;
        if (e.key === "Alt") {
          selectionAltHeld = true;
          if (selectingHints()) e.preventDefault();
        }
        updateHandCursor();
      });
      window.addEventListener("keyup", (e) => {
        if (e.key === "Shift") selectionShiftHeld = false;
        if (e.key === "Alt") selectionAltHeld = false;
        updateHandCursor();
      });
      window.addEventListener("blur", () => {
        selectionShiftHeld = false;
        selectionAltHeld = false;
        updateHandCursor();
      });
      function currentSelectionCursor() {
        return selectionCursorSet[
          selectionTool +
            "-" +
            (selectionAltHeld ? "subtract" : selectionShiftHeld ? "add" : "normal")
        ];
      }
      function freshHints() {
        return processor.createHints(appState.width, appState.height, sharedHintColor);
      }

      function setSelectionCursor(cursor) {
        hintCursor = cursor;
      }
      function cancelSelectionGesture() {
        selectionGesture = null;
        marqueePreview.hidden = true;
        hintCursor = null;
      }
      function getSelectionColor() {
        return sharedHintColor;
      }
      function getSelectionRevision() {
        return selectionBoundaryRevision;
      }
      return Object.freeze({
        cancelSelectionGesture,
        clearModifierSelection,
        currentSelectionCursor,
        drawHintOverlay,
        editingHints,
        ensureHints,
        freshHints,
        getSelectionColor,
        getSelectionRevision,
        markHints,
        saveHintUndo,
        selectingHints,
        setSelectionCursor,
        updateHintControls,
      });
    }

    function createViewportInteraction({
      appState,
      uiControls,
      clearModifierSelection,
      currentSelectionCursor,
      editingHints,
      markHints,
      requestDraw,
      requestOverlayDraw,
      selectingHints,
      setSelectionCursor,
      setSliderValue,
      sliderNumber,
    }) {
      const {
        element: $,
        setRangeValue,
        shortcutContextBlocked,
        onShortcut,
        renderShortcutText,
      } = uiControls;
      const canvas = $("canvas");
      let zoom = 100,
        zoomInitialized = false;
      const viewport = $("canvas-viewport");
      function canPan() {
        return (
          viewport.scrollWidth > viewport.clientWidth ||
          viewport.scrollHeight > viewport.clientHeight
        );
      }
      function updatePanHint() {
        const hint = document.querySelector(".pan-hint"),
          parts = [];
        if (canPan()) parts.push("Hold Space to Pan");
        if (
          appState.edit.session &&
          !$(appState.edit.session.mode === "modify" ? "modifier-show-texture" : "generator-show-texture")
            .checked
        )
          parts.push(
            $("follow-mouse").checked
              ? "Ctrl+Click to Lock Light"
              : "Ctrl+Click to Set Light Position",
          );
        const text = parts.length ? parts[parts.length - 1] : "";
        if (hint.textContent !== text) renderShortcutText(hint, text);
        hint.hidden = !parts.length;
      }
      new ResizeObserver(updatePanHint).observe(viewport);
      function positionToolPopup(popup) {
        if (!popup.dataset.dragged) {
          const rect = viewport.getBoundingClientRect();
          if (popup.id === "modifier" || popup.id === "generator") {
            popup.style.maxHeight = Math.max(80, window.innerHeight - 64) + "px";
            const height = popup.getBoundingClientRect().height;
            popup.style.top =
              Math.max(
                12,
                Math.min(
                  Math.max(12, window.innerHeight - height - 12),
                  rect.top + rect.height / 2 - height / 2,
                ),
              ) + "px";
          } else
            popup.style.top =
              Math.max(12, Math.min(window.innerHeight - 48, rect.top + 12)) + "px";
        }
        popup.style.maxHeight =
          Math.max(80, window.innerHeight - parseFloat(popup.style.top) - 24) + "px";
      }
      for (const id of ["generator", "modifier"]) {
        const popup = $(id),
          heading = popup.querySelector(".generator-heading");
        let drag = null;
        heading.addEventListener("pointerdown", (e) => {
          if (e.button !== 0 || e.target.closest("button,input,select")) return;
          const rect = popup.getBoundingClientRect();
          drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
          e.preventDefault();
          heading.setPointerCapture(e.pointerId);
          heading.classList.add("dragging");
        });
        heading.addEventListener("pointermove", (e) => {
          if (!drag || e.pointerId !== drag.id) return;
          const left = Math.max(
            8,
            Math.min(
              Math.max(8, window.innerWidth - popup.offsetWidth - 8),
              drag.left + e.clientX - drag.x,
            ),
          );
          const top = Math.max(
            8,
            Math.min(window.innerHeight - 48, drag.top + e.clientY - drag.y),
          );
          popup.style.left = left + "px";
          popup.style.right = "auto";
          popup.style.top = top + "px";
          popup.dataset.dragged = "true";
          positionToolPopup(popup);
        });
        function endDrag(e) {
          if (!drag || e.pointerId !== drag.id) return;
          drag = null;
          heading.classList.remove("dragging");
          if (heading.hasPointerCapture(e.pointerId)) heading.releasePointerCapture(e.pointerId);
        }
        for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
          heading.addEventListener(type, endDrag);
      }

      function fitScale() {
        return Math.min((viewport.clientWidth - 2) / appState.width, (viewport.clientHeight - 2) / appState.height) * 100;
      }
      function sizeViewport() {
        viewport.style.overflow = "hidden";
        const top = viewport.getBoundingClientRect().top + window.scrollY,
          footer = document.querySelector(".zoom-controls").getBoundingClientRect().height,
          bottom = parseFloat(getComputedStyle(document.body).paddingBottom) || 0,
          available = window.innerHeight - top - footer - bottom - 3;
        viewport.style.height =
          Math.max(
            Math.min(114, Math.max(1, available)),
            Math.min(available, Math.max(190, (appState.height * viewport.clientWidth) / appState.width)),
          ) + "px";
      }
      function zoomCanvas(value, anchor = null) {
        const before = canvas.getBoundingClientRect();
        const viewRect = viewport.getBoundingClientRect();
        const point = anchor || { clientX: viewRect.left + viewport.clientWidth / 2, clientY: viewRect.top + viewport.clientHeight / 2 };
        const imageX = (point.clientX - before.left) / before.width;
        const imageY = (point.clientY - before.top) / before.height;
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return;
        viewport.style.overflow = "hidden";
        const minimum = fitScale();
        zoom = n;
        const width = (appState.width * zoom) / 100,
          height = (appState.height * zoom) / 100,
          content = $("canvas-content");
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        content.style.width = Math.max(viewport.clientWidth, width) + "px";
        content.style.height = Math.max(viewport.clientHeight, height) + "px";
        const fitted = zoom <= minimum + 0.001;
        viewport.style.overflow = fitted ? "hidden" : "auto";
        updatePanHint();
        $("zoom-slider").min = String(Math.min(zoom, minimum * 0.5));
        $("zoom-slider").max = String(Math.max(1600, minimum, zoom));
        setRangeValue("zoom-slider", String(zoom));
        $("zoom-value").value = String(Math.trunc(zoom));
        const after = canvas.getBoundingClientRect();
        viewport.scrollLeft += after.left + imageX * after.width - point.clientX;
        viewport.scrollTop += after.top + imageY * after.height - point.clientY;
        requestDraw();
      }
      function fitCanvas() {
        sizeViewport();
        zoomCanvas(fitScale());
        zoomInitialized = true;
      }
      $("zoom-slider").addEventListener("input", (e) => zoomCanvas(e.target.value));
      $("zoom-value").addEventListener("change", (e) => zoomCanvas(e.target.value));
      $("zoom-value").addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          zoomCanvas(
            Number(e.target.value) + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1),
          );
        }
        if (e.key === "Enter") {
          zoomCanvas(e.target.value);
          e.target.blur();
        }
      });
      $("zoom-plus").addEventListener("click", () => zoomCanvas(zoom * 1.25));
      $("zoom-minus").addEventListener("click", () => zoomCanvas(zoom / 1.25));
      $("zoom-fit").addEventListener("click", fitCanvas);
      viewport.addEventListener("scroll", requestOverlayDraw);
      viewport.addEventListener(
        "wheel",
        (e) => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          const delta =
            e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.clientHeight : 1);
          zoomCanvas(zoom * Math.exp(-delta * 0.001), e);
        },
        { passive: false },
      );
      window.addEventListener("resize", () => {
        const wasFit = Math.abs(zoom - fitScale()) < 1;
        sizeViewport();
        if (wasFit) fitCanvas();
        else zoomCanvas(zoom);
      });


      let dragging = false;
      let spaceHeld = false,
        canvasHover = false,
        panGesture = null;
      function updateHandCursor() {
        const cursor = panGesture
          ? "grabbing"
          : spaceHeld && canvasHover
            ? "grab"
            : selectingHints()
              ? currentSelectionCursor()
              : "crosshair";
        canvas.style.cursor = cursor;
        viewport.style.cursor = panGesture
          ? "grabbing"
          : spaceHeld
          ? "grab"
          : selectingHints()
            ? currentSelectionCursor()
            : "default";
      }
      viewport.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
      viewport.addEventListener("lostpointercapture", () => { if (panGesture) stopPan(); });
      function stopPan() {
        lightAdjustment = null;
        if (panGesture) {
          const id = panGesture.id;
          panGesture = null;
          if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
        }
        dragging = false;
        updateHandCursor();
        requestDraw();
      }
      viewport.addEventListener("pointerenter", () => {
        canvasHover = true;
        updateHandCursor();
      });
      viewport.addEventListener("pointerleave", () => {
        canvasHover = false;
        if (!spaceHeld && !panGesture && !lightAdjustment) {
          dragging = false;
          if ($("follow-mouse").checked) restoreFollowOrigin();
        }
        updateHandCursor();
      });
      window.addEventListener("keydown", (e) => {
        if (
          e.code !== "Space" ||
          e.defaultPrevented ||
          shortcutContextBlocked(e.target)
        )
          return;
        spaceHeld = true;
        if (canvasHover) e.preventDefault();
        updateHandCursor();
        requestDraw();
      });
      window.addEventListener("keyup", (e) => {
        if (e.code === "Space") {
          spaceHeld = false;
          if (panGesture?.button !== 1) stopPan();
          else updateHandCursor();
        }
      });
      window.addEventListener("blur", () => {
        spaceHeld = false;
        canvasHover = false;
        stopPan();
      });
      viewport.addEventListener(
        "pointerdown",
        (e) => {
          if (!(spaceHeld && e.button === 0) && e.button !== 1) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          dragging = false;
          setSelectionCursor(null);
          panGesture = {
            id: e.pointerId,
            button: e.button,
            x: e.clientX,
            y: e.clientY,
            left: viewport.scrollLeft,
            top: viewport.scrollTop,
          };
          viewport.setPointerCapture(e.pointerId);
          updateHandCursor();
          requestDraw();
        },
        true,
      );
      viewport.addEventListener(
        "pointermove",
        (e) => {
          if (!spaceHeld && !panGesture) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          if (panGesture) {
            viewport.scrollLeft = panGesture.left - (e.clientX - panGesture.x);
            viewport.scrollTop = panGesture.top - (e.clientY - panGesture.y);
          }
          updateHandCursor();
          requestDraw();
        },
        true,
      );
      for (const type of ["pointerup", "pointercancel"])
        viewport.addEventListener(
          type,
          (e) => {
            if (!panGesture) return;
            e.stopImmediatePropagation();
            stopPan();
          },
          true,
        );

      let lightAdjustment = null;
      function beginLightAdjustment(e) {
        if (appState.edit.session || $("view").value !== "lit" || !(e.shiftKey || e.ctrlKey || e.altKey))
          return false;
        const id = e.altKey ? "height" : e.shiftKey ? "power" : "falloff",
          slider = $(id);
        lightAdjustment = {
          pointerId: e.pointerId,
          id,
          start: sliderNumber(id),
          startY: e.clientY,
          min: Number(slider.min),
          max: Number(slider.max),
          step: Number(slider.step) || 1,
        };
        dragging = false;
        e.preventDefault();
        viewport.setPointerCapture(e.pointerId);
        return true;
      }
      function adjustLight(e) {
        const g = lightAdjustment;
        if (!g || g.pointerId !== e.pointerId) return;
        const delta = ((g.startY - e.clientY) * (g.max - g.min)) / 160,
          value = Math.max(g.min, Math.min(g.max, g.start + delta)),
          snapped = g.min + Math.round((value - g.min) / g.step) * g.step;
        setSliderValue(g.id, Number(Math.max(g.min, Math.min(g.max, snapped)).toFixed(6)));
        e.preventDefault();
      }
      function position(e) {
        const r = canvas.getBoundingClientRect();
        appState.light.x = ((e.clientX - r.left) * appState.width) / r.width;
        appState.light.y = ((e.clientY - r.top) * appState.height) / r.height;
        requestDraw();
      }
      function restoreFollowOrigin() {
        appState.light.x = appState.width / 2;
        appState.light.y = appState.height / 2;
        requestDraw();
      }
      $("follow-mouse").addEventListener("change", () => {
        requestDraw();
      });
      onShortcut((e) => {
        if (
          e.defaultPrevented ||
          e.repeat ||
          e.ctrlKey ||
          e.metaKey ||
          e.altKey ||
          shortcutContextBlocked(e.target)
        )
          return;
        const key = e.key.toLowerCase(),
          id =
            key === "f"
              ? "follow-mouse"
              : key === "c" && editingHints()
                ? "hint-contiguous"
                : null;
        if (!id) return;
        const checkbox = $(id);
        if (checkbox.disabled) return;
        e.preventDefault();
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      });
      canvas.addEventListener("pointerleave", () => {
        if (spaceHeld || panGesture) return;
        setSelectionCursor(null);
        requestDraw();
      });
      viewport.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (beginLightAdjustment(e)) return;
        if (appState.edit.session && e.ctrlKey) {
          e.preventDefault();
          dragging = false;
          setSelectionCursor(null);
          position(e);
          $("follow-mouse").checked = false;
          requestDraw();
          return;
        }
        if (selectingHints()) {
          if (e.target === canvas) {
            setSelectionCursor({ x: e.clientX, y: e.clientY });
            canvas.setPointerCapture(e.pointerId);
            markHints(e, true);
          } else if (!e.altKey) clearModifierSelection();
          return;
        }
        if (appState.edit.session) return;
        dragging = true;
        viewport.setPointerCapture(e.pointerId);
        position(e);
      });
      viewport.addEventListener("pointermove", (e) => {
        if (lightAdjustment) {
          adjustLight(e);
          return;
        }
        const bounds = viewport.getBoundingClientRect();
        if (
          e.clientX < bounds.left ||
          e.clientX >= bounds.right ||
          e.clientY < bounds.top ||
          e.clientY >= bounds.bottom
        ) {
          dragging = false;
          setSelectionCursor(null);
          if ($("follow-mouse").checked) restoreFollowOrigin();
          return;
        }
        if (selectingHints()) {
          setSelectionCursor(e.target === canvas ? { x: e.clientX, y: e.clientY } : null);
          if ($("follow-mouse").checked) position(e);
          else requestOverlayDraw();
          return;
        }
        if (appState.edit.session) {
          if ($("follow-mouse").checked) position(e);
          return;
        }
        if ($("follow-mouse").checked) {
          position(e);
        } else if (dragging) position(e);
      });
      for (const type of ["pointerup", "pointercancel"])
        viewport.addEventListener(type, (e) => {
          lightAdjustment = null;
          dragging = false;
          if (viewport.hasPointerCapture(e.pointerId))
            viewport.releasePointerCapture(e.pointerId);
        });


      function isZoomInitialized() {
        return zoomInitialized;
      }
      function isSpaceHeld() {
        return spaceHeld;
      }
      return Object.freeze({
        fitCanvas,
        isSpaceHeld,
        isZoomInitialized,
        position,
        positionToolPopup,
        updateHandCursor,
        updatePanHint,
      });
    }

    function createLightingControls({
      appState,
      uiControls,
      backgroundSample,
      cancelTextureToggleHold,
      popupTextureCheckbox,
      requestDraw,
    }) {
      const { element: $, setRangeValue, shortcutContextBlocked, onShortcut } = uiControls;
      const sliderNumber = (id) => appState.lighting.overrides[id] ?? Number($(id).value);
      const sliderSpecs = [
        ["height", "height-value"],
        ["falloff", "falloff-value"],
        ["power", "power-value"],
        ["ambient", "ambient-value"],
        ["mask-strength", "mask-value"],
      ];

      function setSliderValue(id, value) {
        const n = Number(value);
        if (!Number.isFinite(n) || String(value).trim() === "") return false;
        if (n < 0 || (id === "mask-strength" && n > 100)) return false;
        appState.lighting.overrides[id] = n;
        setRangeValue(id, String(n));
        requestDraw();
        return true;
      }
      function editSlider(id, label) {
        const output = $(label);
        if (output.querySelector("input")) return;
        const input = document.createElement("input");
        input.type = "number";
        input.className = "number-editor";
        input.step = id === "power" ? "0.1" : "1";
        input.min = "0";
        if (id === "mask-strength") input.max = "100";
        input.value = String(sliderNumber(id));
        input.setAttribute("aria-label", "Set " + id);
        output.textContent = "";
        output.appendChild(input);
        let closed = false;
        function finish(commit) {
          if (closed) return;
          if (commit && !setSliderValue(id, input.value)) {
            input.setCustomValidity(
              id === "mask-strength"
                ? "Enter a value from 0 to 100."
                : "Enter a valid nonnegative number.",
            );
            input.reportValidity();
            input.focus();
            return;
          }
          closed = true;
          input.remove();
          requestDraw();
        }
        input.addEventListener("click", (e) => e.stopPropagation());
        input.addEventListener("dblclick", (e) => e.stopPropagation());
        input.addEventListener("input", () => input.setCustomValidity(""));
        input.addEventListener("keydown", (e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const step = (id === "power" ? 0.1 : 1) * (e.shiftKey ? 10 : 1),
              min = Number(input.min),
              max = id === "mask-strength" ? 100 : Infinity;
            input.value = String(
              Math.max(
                min,
                Math.min(
                  max,
                  Number((Number(input.value) + (e.key === "ArrowUp" ? step : -step)).toFixed(6)),
                ),
              ),
            );
            input.setCustomValidity("");
          }
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
          }
        });
        input.addEventListener("blur", () => finish(true));
        input.focus();
        input.select();
      }
      for (const [id, label] of sliderSpecs) {
        $(id).addEventListener("input", () => {
          delete appState.lighting.overrides[id];
        });
        $(id).addEventListener("dblclick", (e) => {
          e.preventDefault();
          editSlider(id, label);
        });
        $(label).addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          editSlider(id, label);
        });
      }
      document.querySelectorAll(".reset").forEach((button) => {
        button.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const id = button.dataset.slider;
          delete appState.lighting.overrides[id];
          setRangeValue(id, $(id).defaultValue);
          if (id === "falloff") appState.lighting.overrides[id] = Number($(id).defaultValue);
          requestDraw();
        });
      });
      for (const id of [
        "view",
        "light-color",
        "height",
        "falloff",
        "power",
        "ambient",
        "mask-strength",
        "hide-bg",
        "bg-color",
        "show-marker",
      ])
        $(id).addEventListener("input", requestDraw);
      onShortcut((e) => {
        if (
          e.defaultPrevented ||
          e.repeat ||
          e.ctrlKey ||
          e.metaKey ||
          e.altKey ||
          e.shiftKey ||
          shortcutContextBlocked(e.target)
        )
          return;
        const shortcut = {
          Digit1: ["view", "lit"],
          Digit2: ["view", "albedo"],
          Digit3: ["view", "normal"],
          Digit4: ["view", "mask"],
          Digit7: ["show-marker", "simple"],
          Digit8: ["show-marker", "advanced"],
          Digit9: ["show-marker", "off"],
          Numpad1: ["view", "lit"],
          Numpad2: ["view", "albedo"],
          Numpad3: ["view", "normal"],
          Numpad4: ["view", "mask"],
          Numpad7: ["show-marker", "simple"],
          Numpad8: ["show-marker", "advanced"],
          Numpad9: ["show-marker", "off"],
        }[e.code];
        if (!shortcut || !/^\d$/.test(e.key)) return;
        const control = $(shortcut[0]);
        if (control.disabled) return;
        e.preventDefault();
        control.value = shortcut[1];
        if (appState.edit.session && shortcut[0] === "view") {
          cancelTextureToggleHold();
          popupTextureCheckbox().checked = false;
        }
        if (appState.edit.session && shortcut[0] === "show-marker" && appState.edit.session.mainLightSettings) {
          appState.edit.session.mainLightSettings.cursor = shortcut[1];
        }
        control.dispatchEvent(new Event("input", { bubbles: true }));
      });
      $("detect-bg").addEventListener("click", () => {
        backgroundSample();
        requestDraw();
      });
      return Object.freeze({ setSliderValue, sliderNumber });
    }

    function createEditorController({ appState, processor, fileAccess, uiControls }) {
      const { element: $ } = uiControls;
      let textureDocument, canvasPresenter, generationSessions, selectionEditor, viewportInteraction, lightingControls;
      textureDocument = createTextureDocument({
        appState,
        uiControls,
        processor,
        fileAccess,
        fitCanvas: (...args) => viewportInteraction.fitCanvas(...args),
        isZoomInitialized: (...args) => viewportInteraction.isZoomInitialized(...args),
        renderPixels: (...args) => canvasPresenter.renderPixels(...args),
        requestDraw: (...args) => canvasPresenter.requestDraw(...args),
        updateTextureButtons: (...args) => canvasPresenter.updateTextureButtons(...args),
      });
      canvasPresenter = createCanvasPresenter({
        appState,
        uiControls,
        processor,
        fileAccess,
        compatibleTexture: (...args) => textureDocument.compatibleTexture(...args),
        drawHintOverlay: (...args) => selectionEditor.drawHintOverlay(...args),
        editingHints: (...args) => selectionEditor.editingHints(...args),
        getSelectionRevision: (...args) => selectionEditor.getSelectionRevision(...args),
        previewGeneration: (...args) => generationSessions.previewGeneration(...args),
        saveHintUndo: (...args) => selectionEditor.saveHintUndo(...args),
        sliderNumber: (...args) => lightingControls.sliderNumber(...args),
        updateHandCursor: (...args) => viewportInteraction.updateHandCursor(...args),
        updateHintControls: (...args) => selectionEditor.updateHintControls(...args),
        updatePanHint: (...args) => viewportInteraction.updatePanHint(...args),
      });
      generationSessions = createGenerationSessions({
        appState,
        uiControls,
        processor,
        fileAccess,
        cancelSelectionGesture: (...args) => selectionEditor.cancelSelectionGesture(...args),
        ensureHints: (...args) => selectionEditor.ensureHints(...args),
        freshHints: (...args) => selectionEditor.freshHints(...args),
        getSelectionColor: (...args) => selectionEditor.getSelectionColor(...args),
        positionToolPopup: (...args) => viewportInteraction.positionToolPopup(...args),
        rebuild: (...args) => textureDocument.rebuild(...args),
        requestDraw: (...args) => canvasPresenter.requestDraw(...args),
        saveHintUndo: (...args) => selectionEditor.saveHintUndo(...args),
        updateHintControls: (...args) => selectionEditor.updateHintControls(...args),
        updatePanHint: (...args) => viewportInteraction.updatePanHint(...args),
        updateTextureButtons: (...args) => canvasPresenter.updateTextureButtons(...args),
        watchStatus: (...args) => textureDocument.watchStatus(...args),
      });
      selectionEditor = createSelectionEditor({
        appState,
        uiControls,
        processor,
        isSpaceHeld: (...args) => viewportInteraction.isSpaceHeld(...args),
        modifiedTexture: (...args) => generationSessions.modifiedTexture(...args),
        position: (...args) => viewportInteraction.position(...args),
        previewGeneration: (...args) => generationSessions.previewGeneration(...args),
        requestDraw: (...args) => canvasPresenter.requestDraw(...args),
        requestOverlayDraw: (...args) => canvasPresenter.requestOverlayDraw(...args),
        updateHandCursor: (...args) => viewportInteraction.updateHandCursor(...args),
      });
      viewportInteraction = createViewportInteraction({
        appState,
        uiControls,
        clearModifierSelection: (...args) => selectionEditor.clearModifierSelection(...args),
        currentSelectionCursor: (...args) => selectionEditor.currentSelectionCursor(...args),
        editingHints: (...args) => selectionEditor.editingHints(...args),
        markHints: (...args) => selectionEditor.markHints(...args),
        requestDraw: (...args) => canvasPresenter.requestDraw(...args),
        requestOverlayDraw: (...args) => canvasPresenter.requestOverlayDraw(...args),
        selectingHints: (...args) => selectionEditor.selectingHints(...args),
        setSelectionCursor: (...args) => selectionEditor.setSelectionCursor(...args),
        setSliderValue: (...args) => lightingControls.setSliderValue(...args),
        sliderNumber: (...args) => lightingControls.sliderNumber(...args),
      });
      lightingControls = createLightingControls({
        appState,
        uiControls,
        backgroundSample: (...args) => textureDocument.backgroundSample(...args),
        cancelTextureToggleHold: (...args) => generationSessions.cancelTextureToggleHold(...args),
        popupTextureCheckbox: (...args) => generationSessions.popupTextureCheckbox(...args),
        requestDraw: (...args) => canvasPresenter.requestDraw(...args),
      });
      $("tool-info-open").addEventListener("click", () => $("tool-info-dialog").showModal());
      $("tool-info-close").addEventListener("click", () => $("tool-info-dialog").close());
      const infoDialog = $("tool-info-dialog");
      infoDialog.addEventListener("cancel", (e) => { e.preventDefault(); infoDialog.close(); });
      let infoBackdropDown = false;
      function outsideInfo(e) {
        const r = infoDialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      }
      infoDialog.addEventListener("pointerdown", (e) => { infoBackdropDown = e.target === infoDialog && outsideInfo(e); });
      infoDialog.addEventListener("click", (e) => { if (infoBackdropDown && outsideInfo(e)) infoDialog.close(); infoBackdropDown = false; });

      createColorPickerController({ uiControls, processor });

      createTooltipController({ uiControls, getEditSession: () => appState.edit.session });

      requestAnimationFrame(viewportInteraction.fitCanvas);
      return Object.freeze({ loadTexture: textureDocument.load });
    }

    const appState = createApplicationState();
    const processor = createImageProcessor();
    const fileAccess = createFileAccess();
    const uiControls = createUIControls();
    const editor = createEditorController({ appState, processor, fileAccess, uiControls });
    // Start with bundled example art already loaded (skeleton demo, same as mother site).
    Promise.all([editor.loadTexture("albedo", "./examples/skeleton_albedo.png", "skeleton_albedo.png"),editor.loadTexture("normal", "./examples/skeleton_normal.png", "skeleton_normal.png", false),editor.loadTexture("mask", "./examples/skeleton_mask.png", "skeleton_mask.png", false)]).catch(() => {});
      })();
