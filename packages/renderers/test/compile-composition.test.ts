import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lintProject } from "@hyperframes/lint";
import { StudixError } from "@studix/shared";
import {
  buildSequentialTimeline,
  type LayoutSpec,
  RENDER_PRESETS,
  renderDimensions,
  type Shot,
  type VideoIR,
  validateVideoIR,
} from "@studix/video-ir";
import { afterAll, describe, expect, it } from "vitest";
import { assignLanes } from "../src/hyperframes/scene-composition.ts";
import { buildComposition, GSAP_ASSET, hyperframesSupport, writeComposition } from "../src/index.ts";
import { loadIrFixture, tempDir, writePng } from "./render-test-helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

const brandIntro = loadIrFixture("brand-intro-9x16");
const previewSize = renderDimensions(brandIntro.format, RENDER_PRESETS.preview);

describe("buildComposition (brand-intro 9:16)", () => {
  const build = buildComposition(brandIntro, previewSize);
  const scene = (id: string) => build.files.get(`compositions/${id}.html`)!;

  it("emits an index plus one composition per scene at the render size", () => {
    expect([...build.files.keys()].sort()).toEqual([
      "compositions/cta.html",
      "compositions/feature.html",
      "compositions/hook.html",
      "compositions/intro.html",
      "index.html",
    ]);
    expect(previewSize).toEqual({ width: 540, height: 960 });
    const index = build.files.get("index.html")!;
    expect(index).toContain('<html lang="vi">');
    expect(index).toContain('data-composition-id="main" data-start="0" data-duration="15" data-width="540"');
    expect(index).toContain('data-composition-src="compositions/feature.html" data-start="7"');
    expect(index).toContain("<title>Giới thiệu thương hiệu Sương Mai Coffee</title>");
  });

  it("keeps Vietnamese text intact and bundles Vietnamese-capable fonts offline", () => {
    expect(scene("hook")).toContain(">Mỗi sáng một tách mộc<");
    expect(scene("feature")).toContain(">100% Arabica trồng ở độ cao 1.500m<");
    expect(scene("hook")).toContain('font-family: "Be Vietnam Pro";');
    expect(scene("hook")).toContain("unicode-range: U+0102-0103,U+0110-0111");
    expect(scene("hook")).not.toMatch(/https?:\/\//);
    const copies = [...build.copies.keys()];
    expect(copies).toContain(GSAP_ASSET);
    expect(copies).toContain("assets/fonts/be-vietnam-pro-vietnamese-800-normal.woff2");
    expect(copies).toContain("assets/fonts/inter-vietnamese-500-normal.woff2");
    expect(build.warnings).toEqual([]);
  });

  it("writes seek-safe GSAP timelines for shots, transitions and captions", () => {
    const feature = scene("feature");
    // feature-1: fade exit in the last 300ms of its 2200ms window.
    expect(feature).toContain(
      'tl.fromTo("#s-feature__shot-feature-1", {"opacity":1}, {"opacity":0,"duration":0.3,"ease":"power2.in","immediateRender":false}, 1.9);',
    );
    // feature-2 enters at 2.3s with slide-up from 6% of the short edge (540 * 0.06 = 32px).
    expect(feature).toContain(
      'tl.fromTo("#s-feature__shot-feature-2", {"opacity":0,"y":32}, {"opacity":1,"y":0,"duration":0.3,"ease":"power3.out"}, 2.3);',
    );
    // hook -> intro fade: outgoing half at the end of hook, incoming half at the start of intro.
    expect(scene("hook")).toContain(
      'tl.fromTo("#s-hook__stage", {"opacity":1}, {"opacity":0,"duration":0.15,"ease":"power2.in"}, 2.85);',
    );
    expect(scene("intro")).toContain(
      'tl.fromTo("#s-intro__stage", {"opacity":0}, {"opacity":1,"duration":0.15,"ease":"power2.out"}, 0);',
    );
    // Caption 3000-7000ms lands in the intro scene as 0-4000ms; it runs to the scene end, so no hide.
    expect(scene("intro")).toContain(
      '<div id="s-intro__cue-0" class="cue">Sương Mai Coffee, rang mộc từ Cầu Đất</div>',
    );
    expect(scene("intro")).toContain('tl.set("#s-intro__cue-0", {"opacity":1}, 0);');
    expect(scene("intro")).not.toContain('tl.set("#s-intro__cue-0", {"opacity":0}');
    expect(scene("cta")).toContain('window.__timelines["cta"] = tl;');
  });

  it("takes transitions and motif poses from the timeline, whatever order the scenes array is in", () => {
    const ir = structuredClone(brandIntro);
    ir.scenes.forEach((scene) => {
      scene.motif = { shape: "circle" };
    });
    const shuffled = { ...ir, scenes: [...ir.scenes].reverse() };
    expect([...buildComposition(shuffled, previewSize).files]).toEqual([
      ...buildComposition(ir, previewSize).files,
    ]);
  });

  it("is deterministic", () => {
    const again = buildComposition(brandIntro, previewSize);
    expect([...again.files.entries()]).toEqual([...build.files.entries()]);
    expect([...again.copies.entries()]).toEqual([...build.copies.entries()]);
  });

  it("matches the golden composition snapshot", () => {
    expect(build.files.get("index.html")).toMatchSnapshot();
    expect(scene("intro")).toMatchSnapshot();
  });

  it("passes the HyperFrames linter with no errors", async () => {
    const { dir, cleanup } = await tempDir("compile-lint");
    cleanups.push(cleanup);
    const files = await writeComposition(build, dir);
    expect(files).toContain("compositions/hook.html");
    const result = await lintProject(dir);
    const errors = result.results.flatMap((r) => r.result.findings.filter((f) => f.severity === "error"));
    expect(errors).toEqual([]);
  });
});

describe("buildComposition escaping and assets", () => {
  it("escapes user text so it can never inject markup or script", () => {
    const ir = structuredClone(brandIntro);
    const shot = ir.scenes[0]!.shots[0]!;
    if (shot.type !== "title") throw new Error("fixture changed");
    shot.text = '</script><img src=x onerror="alert(1)">';
    const hook = buildComposition(ir, previewSize).files.get("compositions/hook.html")!;
    expect(hook).not.toContain("<img src=x");
    expect(hook).toContain("&lt;/script&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("copies image assets into the project and requires a local file for referenced images", async () => {
    const promo = loadIrFixture("product-promo-16x9-assets");
    expect(() => buildComposition(promo, { width: 960, height: 540 })).toThrow(StudixError);
    const { dir, cleanup } = await tempDir("compile-assets");
    cleanups.push(cleanup);
    const build = buildComposition(promo, {
      width: 960,
      height: 540,
      assetFiles: { logo: await writePng(dir, "logo.png"), hero: await writePng(dir, "hero.webp") },
    });
    expect(build.copies.get("assets/media/logo.png")).toBe(join(dir, "logo.png"));
    expect(build.copies.get("assets/media/hero.webp")).toBe(join(dir, "hero.webp"));
    expect(build.files.get("compositions/hero-scene.html")).toContain(
      '<img class="bg" src="assets/media/hero.webp"',
    );
    expect(build.files.get("compositions/end-card.html")).toContain('src="assets/media/logo.png"');
  });

  it("emits muted, scene-local video clips for video shots and backgrounds that lint clean", async () => {
    const ir: VideoIR = structuredClone(loadIrFixture("product-promo-16x9-assets"));
    ir.assets.push({ ...ir.assets[0]!, id: "clip", kind: "video", mime: "video/mp4" });
    ir.scenes[1]!.background = { assetId: "clip" };
    ir.scenes[1]!.shots.push({
      id: "end-clip",
      type: "video",
      assetId: "clip",
      startMs: 500,
      durationMs: 1500,
      trimStartMs: 250,
      style: { region: "full" },
    });
    const { dir, cleanup } = await tempDir("compile-video");
    cleanups.push(cleanup);
    const clip = `${dir}/clip.mp4`;
    await writeFile(clip, "not decoded at compile time");
    const build = buildComposition(ir, {
      width: 960,
      height: 540,
      assetFiles: { logo: await writePng(dir, "logo.png"), hero: await writePng(dir, "hero.webp"), clip },
    });
    expect(build.copies.get("assets/media/clip.mp4")).toBe(clip);
    const endCard = build.files.get("compositions/end-card.html")!;
    expect(endCard).toContain(
      '<video id="s-end-card__bg-clip" class="bg" src="assets/media/clip.mp4" data-start="0" data-duration="3" data-media-start="0" data-hf-media-start-basis="local" data-track-index="0" muted playsinline preload="auto"></video>',
    );
    expect(endCard).toContain(
      '<video id="s-end-card__shot-end-clip-clip" src="assets/media/clip.mp4" data-start="0.5" data-duration="1.5" data-media-start="0.25" data-hf-media-start-basis="local"',
    );
    await writeComposition(build, `${dir}/project`);
    const result = await lintProject(`${dir}/project`);
    const findings = result.results.flatMap((r) => r.result.findings);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(findings.map((f) => f.code)).not.toContain("nested_media_start_basis_ambiguous");
  });

  it("substitutes Be Vietnam Pro for brand fonts that are not bundled", () => {
    const ir = structuredClone(brandIntro);
    ir.brand!.fonts = { heading: "Comic Neue", body: "Be Vietnam Pro" };
    const build = buildComposition(ir, previewSize);
    expect(build.warnings[0]).toMatch(/Comic Neue.*substituted "Be Vietnam Pro"/);
  });
});

describe("buildComposition layouts", () => {
  const layouts: LayoutSpec[] = [
    { kind: "prompt-box", text: "Một phim 60 giây giới thiệu <Studix>", action: "Tạo" },
    {
      kind: "code",
      title: "mcp.json",
      lines: ['{ "studix": {', '  "url": "https://x" // MCP', "}}"],
      highlight: [1],
    },
    { kind: "chips", hub: "Studix MCP", items: ["Claude", "ChatGPT", "Cursor", "Gemini"] },
    {
      kind: "checklist",
      items: [
        { label: "Job", state: "done" },
        { label: "Preview", state: "active" },
        { label: "Duyệt", state: "todo" },
      ],
    },
    { kind: "counter", from: 0, to: 1250, prefix: "+", suffix: "credit", label: "còn lại" },
    { kind: "cards-row", items: ["Hook", "Demo", "CTA"], highlight: 1 },
    { kind: "swatches", items: [{ color: "accent", label: "Cam" }, { color: "#112233" }] },
    { kind: "stat", value: "3×", label: "nhanh hơn" },
  ];
  const ir = structuredClone(brandIntro);
  ir.scenes = layouts.map((layout, i) => ({
    id: `l${i}`,
    role: "feature",
    durationMs: 3000,
    background: { color: "background" },
    shots: [{ id: `l${i}-layout`, type: "layout", startMs: 0, durationMs: 3000, layout }],
  }));
  ir.timeline = buildSequentialTimeline(ir.scenes);
  ir.format.durationMs = 3000 * layouts.length;
  delete ir.captions;
  ir.audio = [];
  const build = buildComposition(ir, previewSize);
  const scene = (i: number) => build.files.get(`compositions/l${i}.html`)!;

  it("draws every built-in layout from its typed content, escaped", () => {
    expect(validateVideoIR(ir).ok).toBe(true);
    const down = structuredClone(ir);
    down.scenes[4]!.shots[0] = {
      ...down.scenes[4]!.shots[0]!,
      layout: { kind: "counter", from: 900, to: 50 },
    } as Shot;
    expect(validateVideoIR(down).ok).toBe(false);
    expect(hyperframesSupport(ir, RENDER_PRESETS.preview).reasons).toEqual([]);
    expect(scene(0)).toContain("&lt;");
    expect(scene(0)).not.toContain("<Studix>");
    expect(scene(0)).toContain('<div class="lo-send">Tạo</div>');
    expect(scene(1)).toContain('<span class="lo-str">&quot;studix&quot;</span>');
    expect(scene(1)).toContain('<span class="lo-cmt">// MCP</span>');
    expect(scene(2)).toContain('<div class="lo-hub">Studix MCP</div>');
    // Four chips do not fit side by side on a portrait frame: they hang off a spine.
    expect(scene(2)).toContain("grid-auto-rows: 1fr;");
    expect(scene(3)).toContain("lo-step lo-s0 lo-done");
    expect(scene(4).match(/class="lo-strip/g)).toHaveLength(4);
    // Vietnamese groups thousands with a dot: 1.250.
    expect(scene(4)).toContain('<span class="lo-p0">.</span>');
    expect(scene(5)).toContain("lo-card lo-k1 lo-hot");
    expect(scene(6)).toContain("background: var(--c-accent);");
    expect(scene(6)).toContain("background: #112233;");
    expect(scene(7)).toContain('<div class="lo-value">3×</div>');
  });

  it("builds each layout in with seek-safe tweens after the shot enters", () => {
    // Typing: each run of letters is shown at an absolute time, the caret blinks after.
    expect(scene(0)).toMatch(/tl\.set\("#s-l0__shot-l0-layout \.lo-c0", \{"opacity":1\}, 0\.3\);/);
    expect(scene(0)).toContain('tl.set("#s-l0__shot-l0-layout .lo-caret"');
    expect(scene(1)).toContain('"clipPath":"inset(0% 100% 0% 0%)"');
    expect(scene(1)).toContain('"#s-l1__shot-l1-layout .lo-l1 .lo-hlbar", {"scaleX":0}');
    // The counter steps through whole numbers: replaying its sets in time order, every state shows a real
    // number (no leading zero, separators only where that number has them) that never counts down.
    const sets = [
      ...scene(4).matchAll(/tl\.set\("#s-l4__shot-l4-layout \.lo-(d|g|p|x)(\d+)", (\{[^}]*\}), ([\d.]+)\);/g),
    ];
    const times = [...new Set(sets.map((m) => Number(m[4])))].sort((a, b) => a - b);
    const digit: number[] = [];
    const shown: boolean[] = [];
    const sepShown: boolean[] = [];
    const prefixAt: boolean[] = [true];
    const states: string[] = [];
    for (const t of times) {
      for (const [, kind, idx, vars, at] of sets) {
        if (Number(at) !== t) continue;
        const v = JSON.parse(vars!);
        if (kind === "d") digit[Number(idx)] = -v.yPercent / 10;
        if (kind === "g") shown[Number(idx)] = v.opacity !== 0;
        if (kind === "p") sepShown[Number(idx)] = v.opacity !== 0;
        if (kind === "x") prefixAt[Number(idx)] = v.opacity !== 0;
      }
      states.push(
        [0, 1, 2, 3]
          .map((c) => (shown[c] !== false ? `${digit[c]}${c === 0 && sepShown[0] ? "." : ""}` : ""))
          .join(""),
      );
      // Exactly one prefix copy shows, right before the leftmost digit on screen.
      expect(prefixAt.flatMap((on, c) => (on ? [c] : []))).toEqual([shown.indexOf(true)]);
    }
    expect(times[0]).toBe(0);
    expect(states[0]).toBe("0");
    expect(states.at(-1)).toBe("1.250");
    expect(times.at(-1)).toBe(1.5);
    let last = -1;
    for (const state of states) {
      expect(state).toMatch(/^(0|[1-9]\d{0,2}|[1-9]\.\d{3})$/);
      const value = Number(state.replace(".", ""));
      expect(value).toBeGreaterThanOrEqual(last);
      last = value;
    }
    // A strip row is 10% of a strip of exactly ten digits, so the digit read above is the one on screen.
    expect(scene(4).match(/<span class="lo-strip lo-d0">((?:<span>\d<\/span>)+)<\/span>/)![1]).toBe(
      Array.from("0123456789", (d) => `<span>${d}</span>`).join(""),
    );
    // About one new number per 30 fps frame, so the count reads smooth.
    expect(states.length).toBeGreaterThan(30);
    for (let i = 0; i < 8; i++) {
      expect(scene(i)).not.toContain('"repeat"');
      expect(scene(i)).not.toContain("onUpdate");
    }
  });

  it("bundles the monospace family only when a code layout uses it", () => {
    expect([...build.copies.keys()]).toContain("assets/fonts/jetbrains-mono-vietnamese-500-normal.woff2");
    expect(scene(1)).toContain('font-family: "JetBrains Mono", monospace;');
    expect(build.warnings).toEqual([]);
    const plain = buildComposition(brandIntro, previewSize);
    expect([...plain.copies.keys()].some((k) => k.includes("jetbrains"))).toBe(false);
  });

  it("fills a landscape card and keeps the layout above burned captions", () => {
    const wide = structuredClone(ir);
    wide.captions = {
      language: "vi",
      mode: "burned",
      position: "bottom",
      cues: [{ startMs: 0, endMs: 3000, text: "Gõ một câu lệnh." }],
    };
    const landscape = buildComposition(wide, { width: 1920, height: 1080 });
    const first = landscape.files.get("compositions/l0.html")!;
    // Subtitles are 44 px at a 1080 px short edge, readable on a phone.
    expect(first).toMatch(/\.cue \{[^}]*font-size: 44px;/);
    // The middle region keeps clear of the caption band: edge 97 + a 79 px cue (one line and its padding) + gap 32 - safe 76.
    expect(first).toMatch(/\.region-middle \{[^}]*padding-bottom: 132px;/);
    expect(landscape.files.get("compositions/l1.html")).not.toContain("padding-bottom");
    // Landscape draws a layout larger than its short edge alone would: the prompt is 1.25x its portrait size (44 px body x 1.1 x 1.25, rounded once).
    const promptPx = (html: string) => Number(/\.lo-field \{[^}]*font-size: (\d+)px;/.exec(html)?.[1]);
    const tall = buildComposition(wide, { width: 1080, height: 1920 }).files.get("compositions/l0.html")!;
    expect(promptPx(first)).toBe(61);
    expect(promptPx(tall)).toBe(48);
    // A square frame is not landscape: no boost, and chip labels never drop below the 26 px floor.
    const square = buildComposition(wide, { width: 1080, height: 1080 });
    expect(promptPx(square.files.get("compositions/l0.html")!)).toBe(48);
    for (const html of [
      square.files.get("compositions/l2.html")!,
      landscape.files.get("compositions/l2.html")!,
    ]) {
      expect(Number(/\.lo-chip \{[^}]*font-size: (\d+)px;/.exec(html)?.[1])).toBeGreaterThanOrEqual(26);
    }
  });

  it("passes the HyperFrames linter with no errors", async () => {
    const { dir, cleanup } = await tempDir("compile-layouts");
    cleanups.push(cleanup);
    await writeComposition(build, dir);
    const result = await lintProject(dir);
    const errors = result.results.flatMap((r) => r.result.findings.filter((f) => f.severity === "error"));
    expect(errors).toEqual([]);
  });
});

describe("buildComposition camera, depth and match cuts", () => {
  const ir = structuredClone(brandIntro);
  const moves = ["push-in", "parallax", "pan-left"] as const;
  ir.scenes = moves.map((camera, i) => ({
    id: `c${i}`,
    role: "feature",
    durationMs: 3000,
    background: { color: "background" },
    shots: [{ id: `c${i}-text`, type: "text", startMs: 0, durationMs: 3000, text: `Card ${i}` }],
    camera,
    depth: { background: ["glow", "grid", "grain", "vignette"], foreground: ["corners", "bokeh"] },
    motif: { shape: "ring", color: "accent" },
    ...(i === 0 ? { transitionOut: { kind: "match-cut", durationMs: 0 } } : {}),
    ...(i === 1 ? { transitionOut: { kind: "iris", durationMs: 400 } } : {}),
  }));
  ir.timeline = buildSequentialTimeline(ir.scenes);
  ir.format.durationMs = 9000;
  delete ir.captions;
  ir.audio = [];
  const build = buildComposition(ir, previewSize);
  const scene = (i: number) => build.files.get(`compositions/c${i}.html`)!;

  it("accepts the camera, depth and motif fields as valid IR", () => {
    expect(validateVideoIR(ir).ok).toBe(true);
  });
  const motifTween = (html: string) => {
    const m = /tl\.fromTo\("#s-c\d__motif", (\{[^}]*\}), (\{[^}]*\}), 0\);/.exec(html);
    if (!m) throw new Error("no motif tween");
    const { duration: _d, ease: _e, ...to } = JSON.parse(m[2]!) as Record<string, number>;
    return { from: JSON.parse(m[1]!) as Record<string, number>, to };
  };

  it("draws the depth planes back to front, with captions and the lens unmoved by the camera", () => {
    const html = scene(0);
    const order = ["plane-back", "plane-underlay", "__motif", "plane-content", "plane-front", 'class="lens"'];
    // Corner brackets sit on the fixed lens, so no camera move pushes them out of the frame.
    expect(html.indexOf('class="corners"')).toBeGreaterThan(html.indexOf('class="lens"'));
    const at = order.map((id) => html.indexOf(id));
    expect(at.every((n) => n > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const layer of ["glow", "grid", "corners", "bokeh", "vignette", "grain"])
      expect(html).toContain(`class="${layer}"`);
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it("moves each plane by its depth over the whole scene", () => {
    const push = scene(0);
    expect(push).toContain('tl.fromTo("#s-c0__plane-content", {"scale":1}, {"scale":1.06,"duration":3');
    expect(push).toContain('tl.fromTo("#s-c0__plane-back", {"scale":1}, {"scale":1.03,"duration":3');
    expect(push).toContain('tl.fromTo("#s-c0__plane-front", {"scale":1}, {"scale":1.084,"duration":3');
    // Parallax spreads the planes: the front plane travels further than the content, the back less.
    const travel = (plane: string) =>
      Number(new RegExp(`"#s-c1__plane-${plane}", \\{"x":(\\d+)`).exec(scene(1))?.[1]);
    expect(travel("front")).toBeGreaterThan(travel("content"));
    expect(travel("content")).toBeGreaterThan(travel("back"));
    expect(scene(2)).toMatch(/"#s-c2__plane-content", \{"x":\d+\}, \{"x":-\d+/);
    // A sideways move scales the underlay just enough that its edges never show.
    expect(scene(2)).toMatch(/"#s-c2__plane-underlay", \{"x":\d+,"scale":1\.0\d+\}/);
  });

  it("hands the motif over at every cut and plays no stage tween on a match cut", () => {
    for (let i = 0; i < 2; i++) expect(motifTween(scene(i + 1)).from).toEqual(motifTween(scene(i)).to);
    expect(scene(0)).not.toMatch(/tl\.fromTo\("#s-c0__stage"/);
    expect(scene(1)).not.toMatch(/tl\.fromTo\("#s-c1__stage", [^\n]*, 0\);/);
    expect(scene(1)).toContain('{"clipPath":"circle(0% at 50% 50%)"');
    expect(scene(2)).toContain('{"clipPath":"circle(0% at 50% 50%)"');
  });

  it("passes the HyperFrames linter with no errors", async () => {
    const { dir, cleanup } = await tempDir("compile-depth");
    cleanups.push(cleanup);
    await writeComposition(build, dir);
    const result = await lintProject(dir);
    const errors = result.results.flatMap((r) => r.result.findings.filter((f) => f.severity === "error"));
    expect(errors).toEqual([]);
  });
});

describe("buildComposition without text shots", () => {
  it("still bundles a face for the family the stage CSS names, so no font is fetched", () => {
    const ir = structuredClone(brandIntro);
    for (const scene of ir.scenes)
      scene.shots = scene.shots.filter((s) => s.type === "image" || s.type === "video" || s.type === "logo");
    delete ir.captions;
    const build = buildComposition(ir, previewSize);
    const copies = [...build.copies.keys()];
    expect(copies).toContain("assets/fonts/inter-vietnamese-400-normal.woff2");
    for (const scene of ir.scenes) {
      const html = build.files.get(`compositions/${scene.id}.html`)!;
      expect(html).toContain("@font-face");
      expect(html).not.toMatch(/https?:\/\//);
    }
  });
});

describe("buildComposition product UI layouts", () => {
  const layouts: LayoutSpec[] = [
    { kind: "chat", title: "Studix", prompt: "Làm video 15 giây <ra mắt>", reply: "Đang dựng storyboard…" },
    {
      kind: "tool-call",
      name: "studix_create_video",
      args: [
        { key: "pack", value: "motion-graphic" },
        { key: "aspect", value: "9:16" },
      ],
      status: "done",
      result: "Job đã xếp hàng",
    },
    { kind: "pipeline", items: ["Brief", "Storyboard", "Render", "QA"], active: 2 },
    { kind: "player", title: "Bản xem trước" },
    { kind: "usage", used: 8.5, cap: 10, prefix: "$", label: "Ngân sách job" },
  ];
  const ir = structuredClone(brandIntro);
  ir.scenes = layouts.map((layout, i) => ({
    id: `u${i}`,
    role: "feature",
    durationMs: 4000,
    background: { color: "background" },
    shots: [{ id: `u${i}-layout`, type: "layout", startMs: 0, durationMs: 4000, layout }],
  }));
  ir.timeline = buildSequentialTimeline(ir.scenes);
  ir.format.durationMs = 4000 * layouts.length;
  delete ir.captions;
  ir.audio = [];
  const build = buildComposition(ir, previewSize);
  const scene = (i: number) => build.files.get(`compositions/u${i}.html`)!;

  it("draws accent text in the foreground colour when the accent is too faint on the background", () => {
    const faint = structuredClone(ir);
    faint.brand!.palette = { ...faint.brand!.palette, accent: "#2a1e18" };
    const toolCss = (b: ReturnType<typeof buildComposition>) =>
      /\.lo-v \{[^}]*color: ([^;]+);/.exec(b.files.get("compositions/u1.html")!)?.[1];
    expect(toolCss(build)).toBe("var(--c-accent)");
    expect(toolCss(buildComposition(faint, previewSize))).toBe("var(--c-foreground)");
  });

  it("validates the product UI layouts and rejects impossible ones", () => {
    expect(validateVideoIR(ir).ok).toBe(true);
    const bad = (layout: unknown) => {
      const next = structuredClone(ir);
      next.scenes[0]!.shots[0] = { ...next.scenes[0]!.shots[0]!, layout } as Shot;
      return validateVideoIR(next).ok;
    };
    expect(bad({ kind: "usage", used: 12, cap: 10 })).toBe(false);
    expect(bad({ kind: "pipeline", items: ["A", "B"], active: 2 })).toBe(false);
    expect(bad({ kind: "tool-call", name: "a\nb" })).toBe(false);
    expect(hyperframesSupport(ir, RENDER_PRESETS.preview).reasons).toEqual([]);
  });

  it("draws each device from its typed content, in the IR language", () => {
    // Chat: the prompt is typed into the input, then sent as an escaped bubble; the reply waits its turn.
    expect(scene(0)).toContain('<div class="lo-me">Làm video 15 giây &lt;ra mắt&gt;</div>');
    expect(scene(0)).not.toContain("<ra mắt>");
    expect(scene(0)).toContain('<div class="lo-ai">Đang dựng storyboard…</div>');
    // Tool call: Vietnamese status words, the arguments and the result once done.
    expect(scene(1)).toContain("Đang chạy");
    expect(scene(1)).toContain("Hoàn tất");
    expect(scene(1)).toContain('<span class="lo-v">"motion-graphic"</span>');
    expect(scene(1)).toContain("Job đã xếp hàng");
    // Pipeline: two stages done, the third running, the fourth to do.
    expect(scene(2).match(/class="lo-ptick"/g)).toHaveLength(2);
    expect(scene(2)).toContain('<div class="lo-pnode lo-n2"><span class="lo-pmark"><span class="lo-pring">');
    expect(scene(2)).toContain('<div class="lo-pnode lo-n3"><span class="lo-pmark"></span>');
    // Player: the default approve label in the IR language.
    expect(scene(3)).toContain("<span>Duyệt</span>");
    // Usage: Vietnamese decimal comma, one label per counting step, the cap marked.
    expect(scene(4)).toContain('<span class="lo-u12">$8,5</span>');
    expect(scene(4)).toContain("Giới hạn &#183; $10");
    const en = buildComposition({ ...ir, language: "en" }, previewSize);
    expect(en.files.get("compositions/u1.html")).toContain("Running");
    expect(en.files.get("compositions/u3.html")).toContain("<span>Approve</span>");
    expect(en.files.get("compositions/u4.html")).toContain('<span class="lo-u12">$8.5</span>');
  });

  it("animates each device with seek-safe tweens that finish inside the card", () => {
    const positions = (html: string) =>
      [...html.matchAll(/tl\.(?:fromTo|set)\([^;]*, ([\d.]+)\);/g)].map((m) => Number(m[1]));
    for (let i = 0; i < layouts.length; i++) {
      expect(scene(i)).not.toContain('"repeat"');
      expect(scene(i)).not.toContain("onUpdate");
      expect(Math.max(...positions(scene(i)))).toBeLessThanOrEqual(4);
    }
    // The chat hides what was typed once it is sent, and the reply rises after the typing dots.
    expect(scene(0)).toContain('tl.set("#s-u0__shot-u0-layout .lo-typed", {"opacity":0}');
    expect(scene(0)).toContain('"#s-u0__shot-u0-layout .lo-ai", {"opacity":0');
    // The spinner turns, then settles on done.
    expect(scene(1)).toContain('"#s-u1__shot-u1-layout .lo-spin", {"rotation":0}, {"rotation":360');
    expect(scene(1)).toContain('tl.set("#s-u1__shot-u1-layout .lo-trun", {"opacity":0}');
    // The pipeline fill (a column: four stages on a portrait frame) stops at the running stage: two of three gaps.
    expect(scene(2)).toMatch(/\.lo-pfill", \{"scaleY":0\}, \{"scaleY":0\.6666/);
    // The player scrubs to the end and presses approve.
    expect(scene(3)).toContain('"#s-u3__shot-u3-layout .lo-pkt", {"xPercent":0}, {"xPercent":100');
    expect(scene(3)).toContain('"#s-u3__shot-u3-layout .lo-acheck"');
    // The meter fills to 85% of its cap and shows the last step at the end of the fill.
    expect(scene(4)).toContain('{"scaleX":0.85,');
    expect(scene(4)).toContain('tl.set("#s-u4__shot-u4-layout .lo-u12", {"opacity":1}');
  });
});

describe("buildComposition logo lockup", () => {
  it("draws the mark beside the name and keeps a layout clear of a lockup above it", async () => {
    const promo = loadIrFixture("product-promo-16x9-assets");
    const { dir, cleanup } = await tempDir("compile-lockup");
    cleanups.push(cleanup);
    const scene = promo.scenes[0]!;
    const layout: LayoutSpec = { kind: "chat", prompt: "Make a launch video" };
    const shots: Shot[] = [
      {
        id: "brand",
        type: "logo",
        assetId: "logo",
        text: "Acme <Labs>",
        lockup: true,
        startMs: 0,
        durationMs: scene.durationMs,
        style: { textStyle: "body", region: "top" },
      },
      { id: "chat", type: "layout", startMs: 0, durationMs: scene.durationMs, layout },
    ];
    const withLockup = { ...promo, scenes: [{ ...scene, shots }, ...promo.scenes.slice(1)] };
    const without = { ...promo, scenes: [{ ...scene, shots: shots.slice(1) }, ...promo.scenes.slice(1)] };
    const files = { logo: await writePng(dir, "logo.png"), hero: await writePng(dir, "hero.webp") };
    const size = { width: 1920, height: 1080, assetFiles: files };
    const html = buildComposition(withLockup, size).files.get(`compositions/${scene.id}.html`)!;
    expect(html).toContain('<img class="lk-mark" src="assets/media/logo.png"');
    expect(html).toContain('<span class="lk-name">Acme &lt;Labs&gt;</span>');
    // The mark is 1.5x the body size: 66 px at a 1080 px short edge.
    expect(html).toMatch(/\.lk-mark \{[^}]*height: 66px;/);
    const fieldPx = (h: string) => Number(/\.lo-field \{[^}]*font-size: (\d+)px;/.exec(h)?.[1]);
    const plain = buildComposition(without, size).files.get(`compositions/${scene.id}.html`)!;
    expect(fieldPx(html)).toBeLessThan(fieldPx(plain));
  });

  it("draws the mark alone, named for the brand, when the lockup has no text", async () => {
    const promo = loadIrFixture("product-promo-16x9-assets");
    const { dir, cleanup } = await tempDir("compile-lockup-mark");
    cleanups.push(cleanup);
    const scene = promo.scenes[0]!;
    const shots: Shot[] = [
      {
        id: "brand",
        type: "logo",
        assetId: "logo",
        lockup: true,
        startMs: 0,
        durationMs: scene.durationMs,
        style: { textStyle: "body", region: "top" },
      },
    ];
    const ir = { ...promo, scenes: [{ ...scene, shots }, ...promo.scenes.slice(1)] };
    const files = { logo: await writePng(dir, "logo.png"), hero: await writePng(dir, "hero.webp") };
    const html = buildComposition(ir, { width: 1920, height: 1080, assetFiles: files }).files.get(
      `compositions/${scene.id}.html`,
    )!;
    expect(html).toContain('<img class="lk-mark" src="assets/media/logo.png"');
    expect(html).toContain(`alt="${promo.brand?.name ?? "logo"}"`);
    expect(html).not.toContain('<span class="lk-name">');
  });
});

describe("assignLanes", () => {
  const shot = (id: string, startMs: number, durationMs: number): Shot => ({
    id,
    type: "text",
    text: id,
    startMs,
    durationMs,
  });

  it("shares a lane for sequential shots and splits overlapping ones", () => {
    const lanes = assignLanes([shot("a", 0, 1000), shot("b", 1000, 1000), shot("c", 500, 1000)]);
    expect(lanes.map((l) => l.map((s) => s.id))).toEqual([["a", "b"], ["c"]]);
  });
});

describe("hyperframesSupport", () => {
  it("supports the brand-intro fixture", () => {
    expect(hyperframesSupport(brandIntro, RENDER_PRESETS.preview)).toEqual({ supported: true, reasons: [] });
  });

  it("supports video shots, video backgrounds and audio tracks", () => {
    const ir: VideoIR = structuredClone(loadIrFixture("product-promo-16x9-assets"));
    ir.assets.push({ ...ir.assets[0]!, id: "clip", kind: "video", mime: "video/mp4" });
    ir.scenes[1]!.background = { assetId: "clip" };
    ir.scenes[1]!.shots.push({
      id: "end-clip",
      type: "video",
      assetId: "clip",
      startMs: 0,
      durationMs: 1000,
    });
    expect(hyperframesSupport(ir, RENDER_PRESETS.preview)).toEqual({ supported: true, reasons: [] });
  });

  it("reports media types it cannot read instead of dropping them", () => {
    const ir: VideoIR = structuredClone(loadIrFixture("product-promo-16x9-assets"));
    ir.assets.push({ ...ir.assets[0]!, id: "clip", kind: "video", mime: "video/x-msvideo" });
    ir.scenes[1]!.shots.push({
      id: "end-clip",
      type: "video",
      assetId: "clip",
      startMs: 0,
      durationMs: 1000,
    });
    const support = hyperframesSupport(ir, RENDER_PRESETS.preview);
    expect(support.supported).toBe(false);
    expect(support.reasons).toEqual([
      'scene "end-card" shot "end-clip": video type video/x-msvideo is not supported',
    ]);
  });

  it("reports invalid IR", () => {
    const ir = structuredClone(brandIntro);
    ir.format.durationMs = 1000;
    const support = hyperframesSupport(ir, RENDER_PRESETS.preview);
    expect(support.supported).toBe(false);
    expect(support.reasons[0]).toMatch(/invalid IR at \/format\/durationMs/);
  });
});
