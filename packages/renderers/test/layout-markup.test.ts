import { lintProject } from "@hyperframes/lint";
import type { Layout, Shot, VideoIR } from "@studix/video-ir";
import { validateVideoIR } from "@studix/video-ir";
import { afterAll, describe, expect, it } from "vitest";
import { renderLayoutMarkup } from "../src/hyperframes/layout-markup.ts";
import { buildComposition, writeComposition } from "../src/index.ts";
import { loadIrFixture, tempDir } from "./render-test-helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

const LAYOUTS: Layout[] = [
  { kind: "prompt-box", text: "Tạo video giới thiệu <Studix> 60 giây" },
  {
    kind: "code",
    title: "mcp.json",
    lines: ["{", '  "studix": {', '    "url": "https://…"', "  }", "}"],
    highlight: 2,
  },
  { kind: "chips", hub: "Studix MCP", items: ["Claude", "ChatGPT", "Cursor"] },
  {
    kind: "checklist",
    items: [
      { label: "Tạo job", state: "done" },
      { label: "Xem preview", state: "active" },
      { label: "Duyệt", state: "todo" },
    ],
  },
  { kind: "counter", from: 0, to: 12500, suffix: "+", label: "credit mỗi tháng" },
  { kind: "cards-row", items: ["Hook", "Demo", "CTA"], focus: 1 },
  { kind: "swatches", colors: [{ color: "#ff6a00", name: "Cam" }, { color: "foreground" }] },
  { kind: "stat", value: "3×", label: "nhanh hơn dựng tay" },
];

/** The brand-intro fixture with its feature scene showing every layout in turn. */
function layoutIr(aspect: "9:16" | "16:9" | "1:1"): VideoIR {
  const ir = structuredClone(loadIrFixture("brand-intro-9x16"));
  if (aspect === "16:9") ir.format = { ...ir.format, aspectRatio: "16:9", width: 1920, height: 1080 };
  if (aspect === "1:1") ir.format = { ...ir.format, aspectRatio: "1:1", width: 1080, height: 1080 };
  const feature = ir.scenes.find((s) => s.id === "feature")!;
  const each = Math.floor(feature.durationMs / LAYOUTS.length);
  feature.shots = LAYOUTS.map(
    (layout, i): Shot => ({
      id: `layout-${i}`,
      type: "layout",
      startMs: i * each,
      durationMs: each,
      layout: structuredClone(layout),
      style: { region: "middle" },
      animation: { enter: "slide-up", exit: "fade", durationMs: 200 },
    }),
  );
  return ir;
}

describe("layout shots", () => {
  it("rejects an index past its list", () => {
    const ir = layoutIr("9:16");
    const shot = ir.scenes.find((s) => s.id === "feature")!.shots[1]!;
    if (shot.type !== "layout" || shot.layout.kind !== "code") throw new Error("fixture changed");
    shot.layout.highlight = 7;
    const result = validateVideoIR(ir);
    expect(result.ok).toBe(false);
  });

  it("settles every layout's own motion before a short card's exit, and never before the shot", () => {
    for (const layout of [...LAYOUTS, { kind: "counter", from: 120, to: 2, label: "giờ" } as Layout]) {
      const shot = {
        id: "l",
        type: "layout",
        startMs: 250,
        durationMs: 1250,
        layout,
        animation: { enter: "slide-up", exit: "fade", durationMs: 400 },
      } as const;
      const lines: string[] = [];
      const w = {
        lines,
        fromTo: (...a: unknown[]) => lines.push(JSON.stringify(a)),
        set: (...a: unknown[]) => lines.push(JSON.stringify(a)),
      };
      const ctx = {
        prefix: "s__",
        scale: 1,
        frame: { width: 1080, height: 1080 },
        fontStacks: { heading: "x", body: "x" },
        fontWeights: { heading: new Set<number>(), body: new Set<number>() },
        assetPaths: new Map(),
        language: "vi",
      };
      const markup = renderLayoutMarkup(ctx, shot, "#s__shot-l");
      markup.motion(w as never);
      const ends = lines.map((l) => {
        const args = JSON.parse(l) as unknown[];
        const at = args.at(-1) as number;
        const to = args.length === 4 ? (args[2] as { duration?: number }) : {};
        expect(at).toBeGreaterThanOrEqual(0.25);
        return at + (to.duration ?? 0);
      });
      // Exit starts at 1.1 s; the last tween settles before it.
      expect(Math.max(...ends)).toBeLessThanOrEqual(1.1);
    }
  });

  it("rolls a counter down, hiding the leading digits it ends without", () => {
    const ir = layoutIr("9:16");
    const shot = ir.scenes.find((s) => s.id === "feature")!.shots[4]!;
    if (shot.type !== "layout") throw new Error("fixture changed");
    shot.layout = { kind: "counter", from: 120, to: 2 };
    const feature = buildComposition(ir, { width: 540, height: 960 }).files.get("compositions/feature.html")!;
    // Hundreds and tens start shown and fade out; the strip rolls down from the middle turn.
    expect(feature).toMatch(/layout-4__k0", \{"opacity":1\}, \{"opacity":0/);
    expect(feature).toMatch(/layout-4__k1", \{"opacity":1\}, \{"opacity":0/);
    expect(feature).not.toContain('layout-4__k2", {"opacity"');
  });

  for (const aspect of ["9:16", "16:9", "1:1"] as const) {
    it(`draws every layout at ${aspect} with seek-safe tweens that lint clean`, async () => {
      const ir = layoutIr(aspect);
      expect(validateVideoIR(ir).ok).toBe(true);
      const build = buildComposition(ir, { width: ir.format.width, height: ir.format.height });
      const feature = build.files.get("compositions/feature.html")!;
      // User text is escaped, typed a letter at a time, and Vietnamese letters stay whole.
      expect(feature).toContain("&lt;");
      expect(feature).not.toContain("<Studix>");
      expect(feature).toContain('class="pb-ch">ạ</span>');
      // Layout parts animate only opacity and transforms, at absolute positions.
      const tweens = feature.split("\n").filter((l) => l.includes("tl.") && l.includes("layout-"));
      expect(tweens.length).toBeGreaterThan(40);
      for (const line of tweens) {
        expect(line).toMatch(/, \d+(\.\d+)?\);$/);
        expect(line).not.toMatch(/"(width|height|left|top|margin|padding)"/);
      }
      // The counter groups digits the Vietnamese way and rolls each column.
      expect(feature).toMatch(/style="opacity: 0;">\.<\/span>/);
      expect(feature).toContain('class="ct-strip"');
      // The highlighted line, the focused card and the active step get their own tweens.
      expect(feature).toContain("layout-1__hl");
      expect(feature).toContain("layout-5__ring");
      expect(feature).toMatch(/layout-3__d1/);
      expect(buildComposition(ir, { width: ir.format.width, height: ir.format.height }).files).toEqual(
        build.files,
      );
      const { dir, cleanup } = await tempDir(`layouts-${aspect.replace(":", "x")}`);
      cleanups.push(cleanup);
      await writeComposition(build, dir);
      const result = await lintProject(dir);
      const errors = result.results.flatMap((r) => r.result.findings.filter((f) => f.severity === "error"));
      expect(errors).toEqual([]);
    });
  }
});
