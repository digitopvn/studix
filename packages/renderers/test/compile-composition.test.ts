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
    { kind: "counter", from: 0, to: 1250, suffix: "credit", label: "còn lại" },
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
    // The counter's units roll two turns: from 0 to the 20 + 0th digit of the strip.
    expect(scene(4)).toContain(
      'tl.fromTo("#s-l4__shot-l4-layout .lo-d3", {"yPercent":0}, {"yPercent":-66.667,"duration":1.2,"ease":"power2.out"}, 0.3);',
    );
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

  it("passes the HyperFrames linter with no errors", async () => {
    const { dir, cleanup } = await tempDir("compile-layouts");
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
