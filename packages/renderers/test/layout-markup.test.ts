import { lintProject } from "@hyperframes/lint";
import type { Layout, Shot, VideoIR } from "@studix/video-ir";
import { validateVideoIR } from "@studix/video-ir";
import { afterAll, describe, expect, it } from "vitest";
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
function layoutIr(aspect: "9:16" | "16:9"): VideoIR {
  const ir = structuredClone(loadIrFixture("brand-intro-9x16"));
  if (aspect === "16:9") ir.format = { ...ir.format, aspectRatio: "16:9", width: 1920, height: 1080 };
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

  for (const aspect of ["9:16", "16:9"] as const) {
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
      expect(feature).toContain("<span>.</span>");
      expect(feature).toContain('class="ct-strip"');
      // The highlighted line, the focused card and the active step get their own tweens.
      expect(feature).toContain("layout-1-hl");
      expect(feature).toContain("layout-5-ring");
      expect(feature).toMatch(/layout-3-d1/);
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
