#!/usr/bin/env node
// Check that visible text and marked boxes stay inside the safe areas of a build.
//
// Loads <build-dir>/index.html in headless Chromium (served over 127.0.0.1, not
// file://), waits for window.__timelines.main, seeks the paused timeline every
// --step seconds and measures every visible element with its own text (real text
// runs via Range.getClientRects) plus every [data-bounds-box] element. Reports,
// per scene and element: leaving the content area, captions outside their band,
// HUD outside its band, content inside a keep-out circle (webcam PiP), text below
// the minimum font size, and text still animating in the last 0.15 s.
//
// Usage:
//   node check-bounds.mjs <build-dir> [--ratio 16x9|1x1|9x16] [--step 0.05]
//        [--from S --to S] [--safe safe.json] [--json] [--browser PATH]
// Exit: 0 clean, 1 violations or error, 3 playwright not installed.
// Skip an element with data-bounds-ignore or data-layout-allow-overflow.
// Zones: captions = inside .cap or #captions; HUD = #hud, #hud-title,
// [data-bounds=hud]; everything else is content.
// --safe JSON overrides or extends the ratio defaults:
//   {"content":{"x":[72,1008],"y":[250,1250]}, "captions":{...}, "hud":{...},
//    "keepout":[{"cx":196,"cy":1380,"r":120}], "minFont":24}
// Dependency: playwright (resolved from the cwd, then the build dir, then global).

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const USAGE = `usage: node check-bounds.mjs <build-dir> [--ratio 16x9|1x1|9x16] [--step 0.05] [--from S --to S] [--safe safe.json] [--json] [--browser PATH]`;

const DEFAULTS = {
  "9x16": {
    content: { x: [72, 1008], y: [250, 1250] },
    captions: { x: [340, 980], y: [null, 1490] },
    hud: { x: [null, null], y: [120, 240] },
    keepout: [{ cx: 196, cy: 1380, r: 120 }],
    minFont: 24,
  },
  "16x9": { content: { x: [96, 1824], y: [60, 1020] }, keepout: [], minFont: 20 },
  "1x1": { content: { x: [72, 1008], y: [72, 1008] }, keepout: [], minFont: 24 },
};
const RATIO_SIZE = { "16x9": [1920, 1080], "1x1": [1080, 1080], "9x16": [1080, 1920] };
const END_WINDOW = 0.15;
const FONT_MIN_SPAN = 0.2; // a smaller-than-minimum font must persist this long (entrances scale up)
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4", ".webm": "video/webm", ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg", ".wav": "audio/wav",
};

class CliError extends Error {}

function parseArgs(argv) {
  const a = { step: 0.05, json: false };
  const num = (k, v) => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n)) throw new CliError(`${k} needs a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "-h" || k === "--help") a.help = true;
    else if (k === "--json") a.json = true;
    else if (k === "--ratio") { a.ratio = v; i++; }
    else if (k === "--step") { a.step = num(k, v); i++; }
    else if (k === "--from") { a.from = num(k, v); i++; }
    else if (k === "--to") { a.to = num(k, v); i++; }
    else if (k === "--safe") { a.safe = v; i++; }
    else if (k === "--browser") { a.browser = v; i++; }
    else if (k.startsWith("-")) throw new CliError(`unknown option ${k}`);
    else if (!a.dir) a.dir = k;
    else throw new CliError(`unexpected argument ${k}`);
  }
  if (a.help) return a;
  if (!a.dir) throw new CliError(USAGE);
  if (a.ratio !== undefined && !RATIO_SIZE[a.ratio]) throw new CliError(`--ratio must be 16x9, 1x1 or 9x16`);
  if (!(a.step > 0)) throw new CliError("--step must be > 0");
  for (const k of ["safe", "browser"]) if (k in a && !a[k]) throw new CliError(`--${k} needs a value`);
  return a;
}

function resolvePlaywright(buildDir) {
  const bases = [process.cwd(), buildDir];
  try {
    // npm is npm.cmd on Windows, which Node runs only through a shell
    const win = process.platform === "win32";
    bases.push(execFileSync(win ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: win }).trim());
  } catch { /* npm missing: cwd/build dir/NODE_PATH lookups still apply */ }
  for (const base of bases) {
    try {
      const req = createRequire(path.join(path.resolve(base), "noop.js"));
      return req(req.resolve("playwright"));
    } catch { /* try the next base */ }
  }
  return null;
}

function readRoot(html) {
  const tag = html.match(/<html\b[^>]*>/i)?.[0] ?? "";
  const ratio = tag.match(/\bdata-ratio="([^"]+)"/)?.[1];
  const w = Number(html.match(/\bdata-width="(\d+)"/)?.[1]);
  const h = Number(html.match(/\bdata-height="(\d+)"/)?.[1]);
  return { ratio, w, h };
}

function loadSafe(ratio, file, w, h) {
  const base = structuredClone(DEFAULTS[ratio]);
  base.captions ??= structuredClone(base.content);
  base.hud ??= structuredClone(base.content);
  if (file) {
    let o;
    try {
      o = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new CliError(`--safe ${file}: ${e.code === "ENOENT" ? "file not found" : e.message}`);
    }
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new CliError(`--safe ${file}: expected a JSON object`);
    for (const zone of ["content", "captions", "hud"]) {
      if (o[zone] === undefined) continue;
      for (const ax of ["x", "y"]) {
        const r = o[zone][ax];
        if (r === undefined) continue;
        const ok = Array.isArray(r) && r.length === 2 && r.every((n) => n === null || Number.isFinite(n));
        if (!ok) throw new CliError(`--safe ${file}: ${zone}.${ax} must be [min, max] (numbers or null)`);
        base[zone][ax] = r;
      }
    }
    if (o.keepout !== undefined) {
      const ok = Array.isArray(o.keepout) && o.keepout.every((k) => k && ["cx", "cy", "r"].every((f) => Number.isFinite(k[f])));
      if (!ok) throw new CliError(`--safe ${file}: keepout must be [{cx, cy, r}, ...]`);
      base.keepout = o.keepout;
    }
    if (o.minFont !== undefined) {
      if (!Number.isFinite(o.minFont)) throw new CliError(`--safe ${file}: minFont must be a number`);
      base.minFont = o.minFont;
    }
  }
  for (const zone of ["content", "captions", "hud"]) {
    const z = base[zone];
    z.x = [z.x[0] ?? 0, z.x[1] ?? w];
    z.y = [z.y[0] ?? 0, z.y[1] ?? h];
  }
  return base;
}

function serve(root) {
  const rootAbs = path.resolve(root);
  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(rootAbs, "." + rel);
    if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "content-length": st.size });
      fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ------------------------------------------------------------ in-page code
// Serialized into the page by Playwright: must be self-contained.
function measure({ times, safe, mode }) {
  const tl = window.__timelines.main;
  const root = document.querySelector('[data-composition-id="main"]') || document.getElementById("root") || document.documentElement;
  const SKIP = "[data-bounds-ignore],[data-layout-allow-overflow]";
  const HUD = "#hud,#hud-title,[data-bounds=hud]";

  const pathOf = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && e !== document.documentElement && parts.length < 4; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) {
        parts.unshift(`${s}#${e.id}`);
        break;
      }
      const cls = [...e.classList].slice(0, 2);
      if (cls.length) s += "." + cls.join(".");
      const sib = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
      if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(e) + 1})`;
      parts.unshift(s);
    }
    return parts.join(" > ");
  };

  // Units: a caption counts as one unit (.cap), other text by its parent element.
  const units = new Map();
  const unitFor = (el) => el.closest(".cap") || el;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || !n.textContent.trim() || el.closest("script,style,noscript,title") || el.closest(SKIP)) continue;
    const u = unitFor(el);
    if (!units.has(u)) units.set(u, { texts: [], box: false });
    units.get(u).texts.push(n);
  }
  for (const el of root.querySelectorAll("[data-bounds-box]")) {
    if (el.closest(SKIP)) continue;
    if (!units.has(el)) units.set(el, { texts: [], box: true });
    else units.get(el).box = true;
  }
  const meta = new Map();
  for (const [el] of units) {
    const zone = el.closest(".cap,#captions") ? "captions" : el.closest(HUD) ? "hud" : "content";
    const scene = el.closest("section.scene")?.id || el.closest(".scene")?.id || "-";
    const label = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    meta.set(el, { zone, scene, path: pathOf(el), label });
  }

  const range = document.createRange();
  const out = [];
  for (const t of times) {
    tl.seek(t, false);
    const rr = root.getBoundingClientRect();
    const sx = rr.width / (root.offsetWidth || rr.width || 1);
    const sy = rr.height / (root.offsetHeight || rr.height || 1);
    const W = rr.width / sx;
    const H = rr.height / sy;
    const opMemo = new Map();
    const opacity = (el) => {
      if (!el || el === document.documentElement) return 1;
      if (opMemo.has(el)) return opMemo.get(el);
      const cs = getComputedStyle(el);
      const v = cs.display === "none" ? 0 : Number(cs.opacity) * opacity(el.parentElement);
      opMemo.set(el, v);
      return v;
    };
    const sample = [];
    for (const [el, u] of units) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.visibility === "collapse") continue;
      const op = opacity(el);
      if (op <= 0.01) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      let font = Infinity;
      const add = (r) => {
        if (r.width <= 0 && r.height <= 0) return;
        x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
      };
      if (u.box) add(el.getBoundingClientRect());
      for (const n of u.texts) {
        const p = n.parentElement;
        const pcs = getComputedStyle(p);
        if (pcs.visibility === "hidden" || opacity(p) <= 0.01) continue;
        range.selectNodeContents(n);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
        rects.forEach(add);
        if (rects.length) {
          const pr = p.getBoundingClientRect();
          const scale = p.offsetHeight > 0 ? pr.height / p.offsetHeight : 1;
          font = Math.min(font, parseFloat(pcs.fontSize) * (scale || 1));
        }
      }
      if (!Number.isFinite(x0)) continue;
      // root-relative frame coordinates
      const b = [(x0 - rr.left) / sx, (y0 - rr.top) / sy, (x1 - rr.left) / sx, (y1 - rr.top) / sy];
      if (b[2] <= 0 || b[3] <= 0 || b[0] >= W || b[1] >= H) continue; // off-screen
      if (mode === "end") {
        sample.push({ el: meta.get(el), op, b });
        continue;
      }
      const m = meta.get(el);
      const z = safe[m.zone];
      const over = { left: z.x[0] - b[0], right: b[2] - z.x[1], top: z.y[0] - b[1], bottom: b[3] - z.y[1] };
      const edges = Object.entries(over).filter(([, v]) => v > 0.5);
      if (edges.length) {
        const worst = Math.max(...edges.map(([, v]) => v));
        sample.push({ ...m, kind: m.zone, over: worst, edges: edges.map(([k]) => k) });
      }
      if (m.zone === "content") {
        for (const k of safe.keepout) {
          const nx = Math.max(b[0], Math.min(k.cx, b[2]));
          const ny = Math.max(b[1], Math.min(k.cy, b[3]));
          const d = Math.hypot(nx - k.cx, ny - k.cy);
          if (d < k.r - 0.5) sample.push({ ...m, kind: "keepout", over: k.r - d, edges: [`(${k.cx},${k.cy})`] });
        }
        if (u.texts.length && op >= 0.95 && font < safe.minFont - 0.25) {
          sample.push({ ...m, kind: "font", over: safe.minFont - font, edges: [`${Math.round(font * 10) / 10}px`] });
        }
      }
    }
    out.push({ t, items: sample });
  }
  return out;
}

// ------------------------------------------------------------ main

function fmtT(t) {
  return t.toFixed(2);
}

async function run(args) {
  const dir = path.resolve(args.dir);
  const indexFile = path.join(dir, "index.html");
  if (!fs.existsSync(indexFile)) throw new CliError(`${args.dir}: no index.html`);
  const html = fs.readFileSync(indexFile, "utf8");
  const root = readRoot(html);
  const ratio = args.ratio ?? root.ratio ?? Object.keys(RATIO_SIZE).find((r) => RATIO_SIZE[r][0] === root.w && RATIO_SIZE[r][1] === root.h);
  if (!RATIO_SIZE[ratio]) throw new CliError(`cannot tell the ratio of ${args.dir}; pass --ratio`);
  const [w, h] = root.w && root.h ? [root.w, root.h] : RATIO_SIZE[ratio];
  const safe = loadSafe(ratio, args.safe, w, h);

  const pw = resolvePlaywright(dir);
  if (!pw) {
    console.error("check-bounds needs playwright: npm i -D playwright && npx playwright install chromium");
    return 3;
  }

  let server;
  let browser;
  const cleanup = async () => {
    await browser?.close().catch(() => {});
    await new Promise((r) => (server ? server.close(() => r()) : r()));
  };
  const onSignal = () => cleanup().finally(() => process.exit(130));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    server = await serve(dir);
    const executablePath = args.browser || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
    try {
      browser = await pw.chromium.launch({ headless: true, executablePath });
    } catch (e) {
      throw new CliError(`cannot launch Chromium (${String(e.message).split("\n")[0]}); run npx playwright install chromium or pass --browser PATH`);
    }
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    const { port } = server.address();
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load", timeout: 30000 });
    try {
      await page.waitForFunction(() => !!(window.__timelines && window.__timelines.main), null, { timeout: 15000 });
    } catch {
      const why = pageErrors.length ? `; page error: ${pageErrors[0]}` : "";
      throw new CliError(`window.__timelines.main was not registered within 15 s${why}`);
    }
    await page.evaluate(() => document.fonts && document.fonts.ready);
    const duration = await page.evaluate(() => {
      const tl = window.__timelines.main;
      const d = typeof tl.duration === "function" ? tl.duration() : tl.duration;
      const attr = Number(document.querySelector("[data-composition-id]")?.getAttribute("data-duration"));
      return Number.isFinite(d) && d > 0 ? d : attr;
    });
    if (!(duration > 0)) throw new CliError("timeline duration is 0 or unknown");
    const from = Math.max(0, args.from ?? 0);
    const to = Math.min(duration, args.to ?? duration);
    if (!(to >= from)) throw new CliError(`--from ${from} is after --to ${to}`);

    const times = [];
    for (let i = 0; ; i++) {
      const t = Math.round((from + i * args.step) * 1000) / 1000;
      if (t > to + 1e-9) break;
      times.push(t);
    }
    if (times[times.length - 1] < to - 1e-6) times.push(to);

    // sweep in chunks so one evaluate never runs for long
    const agg = new Map();
    for (let i = 0; i < times.length; i += 200) {
      const res = await page.evaluate(measure, { times: times.slice(i, i + 200), safe, mode: "sweep" });
      for (const { t, items } of res) {
        for (const it of items) {
          const key = `${it.scene}\u0000${it.path}\u0000${it.kind}`;
          const a = agg.get(key) ?? { scene: it.scene, element: it.path, text: it.label, kind: it.kind, first: t, last: t, worst: 0, edges: new Set(), samples: 0, run: 0, lastT: null, maxRun: 0 };
          a.last = t;
          a.samples++;
          a.run = a.lastT !== null && t - a.lastT <= args.step * 1.5 + 1e-9 ? a.run + (t - a.lastT) : 0;
          a.maxRun = Math.max(a.maxRun, a.run);
          a.lastT = t;
          a.worst = Math.max(a.worst, it.over);
          it.edges.forEach((e) => a.edges.add(e));
          agg.set(key, a);
        }
      }
    }

    // text still animating as the build ends
    if (to >= duration - END_WINDOW - 1e-9) {
      const endTimes = [0, 1, 2, 3].map((k) => Math.max(0, duration - END_WINDOW + k * (END_WINDOW / 3)));
      const res = await page.evaluate(measure, { times: endTimes, safe, mode: "end" });
      const series = new Map();
      res.forEach(({ items }, k) => {
        for (const it of items) {
          const key = `${it.el.scene}\u0000${it.el.path}`;
          if (!series.has(key)) series.set(key, { el: it.el, pts: [] });
          series.get(key).pts.push({ k, op: it.op, b: it.b });
        }
      });
      for (const { el, pts } of series.values()) {
        const fading = pts.some((p) => p.op > 0.05 && p.op < 0.95);
        let moving = false;
        for (let i = 1; i < pts.length; i++) {
          const d = Math.max(...pts[i].b.map((v, j) => Math.abs(v - pts[i - 1].b[j])));
          if (d > 0.5) moving = true;
        }
        if (fading || moving) {
          agg.set(`${el.scene}\u0000${el.path}\u0000ends-unfinished`, {
            scene: el.scene, element: el.path, text: el.label, kind: "ends-unfinished",
            first: endTimes[0], last: endTimes[endTimes.length - 1], worst: 0,
            edges: new Set([fading && moving ? "fading+moving" : fading ? "fading" : "moving"]), samples: pts.length, maxRun: Infinity,
          });
        }
      }
    }

    const violations = [...agg.values()]
      .filter((a) => a.kind !== "font" || a.maxRun >= FONT_MIN_SPAN - 1e-9)
      .map((a) => ({
        scene: a.scene, element: a.element, text: a.text, kind: a.kind,
        from: Math.round(a.first * 1000) / 1000, to: Math.round(a.last * 1000) / 1000,
        worstPx: Math.round(a.worst), detail: [...a.edges].join(","), samples: a.samples,
      }))
      .sort((x, y) => x.from - y.from || x.scene.localeCompare(y.scene));

    const report = { build: args.dir, ratio, width: w, height: h, duration, from, to, step: args.step, safe, violations, pageErrors, ok: violations.length === 0 };
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`check-bounds ${args.dir} (${ratio} ${w}x${h}, t ${fmtT(from)}-${fmtT(to)}s step ${args.step})`);
      const what = { content: "outside content area", captions: "outside caption band", hud: "outside HUD band", keepout: "inside keep-out zone", font: "font below minimum", "ends-unfinished": "still animating at the end" };
      for (const v of violations) {
        const px = v.kind === "ends-unfinished" ? "" : v.kind === "font" ? ` (${v.detail}, min ${safe.minFont}px)` : ` (${v.detail} +${v.worstPx}px)`;
        console.log(`  ${v.scene}  ${v.element}${v.text ? ` "${v.text}"` : ""}  ${what[v.kind]}${px}${v.kind === "ends-unfinished" ? ` (${v.detail})` : ""}  t ${fmtT(v.from)}-${fmtT(v.to)}s`);
      }
      for (const e of pageErrors.slice(0, 3)) console.log(`  page error: ${e}`);
      const scenes = new Set(violations.map((v) => v.scene)).size;
      console.log(`check-bounds: ${report.ok ? "OK" : `FAIL (${violations.length} violations in ${scenes} scenes)`}`);
    }
    return report.ok ? 0 : 1;
  } finally {
    await cleanup();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  }
  if (args.help) {
    const lines = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
    const head = lines.slice(0, lines.findIndex((l) => !l.startsWith("//")));
    console.log(head.map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return 0;
  }
  try {
    return await run(args);
  } catch (e) {
    console.error(`error: ${e instanceof CliError ? e.message : e.stack || e.message}`);
    return 1;
  }
}

process.exitCode = await main();
