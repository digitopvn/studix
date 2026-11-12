import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lintProject } from "@hyperframes/lint";
import { StudixError } from "@studix/shared";
import { RENDER_PRESETS, type VideoIR, validateVideoIR } from "@studix/video-ir";
import { afterAll, describe, expect, it } from "vitest";
import { planFonts } from "../src/hyperframes/bundled-fonts.ts";
import {
  buildComposition,
  HtmlCardPackage,
  hasCompositionShots,
  htmlCardProblems,
  hyperframesSupport,
  lintHtmlCard,
  writeComposition,
} from "../src/index.ts";
import { CLEAN_CARD, cardIr, writeCard } from "./html-card-fixture.ts";
import { tempDir } from "./render-test-helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

async function scratch(prefix: string): Promise<string> {
  const { dir, cleanup } = await tempDir(prefix);
  cleanups.push(cleanup);
  return dir;
}

describe("htmlCardProblems", () => {
  it("passes a clean card with inline SVG, nested CSS and a GSAP script", () => {
    expect(HtmlCardPackage.parse(CLEAN_CARD)).toEqual(CLEAN_CARD);
    expect(htmlCardProblems(CLEAN_CARD)).toEqual([]);
    // Identifiers that merely contain a blocked word are fine.
    expect(
      htmlCardProblems({
        ...CLEAN_CARD,
        script: "var updated = 1; var evaluate = 2; tl.to(root, { top: 0 });",
      }),
    ).toEqual([]);
  });

  it("names every rule a card breaks", () => {
    const problems = htmlCardProblems({
      ...CLEAN_CARD,
      html: '<img src="https://x.test/a.png"><div onclick="go()" style="background: url(/a.png)">x</div><style>a{}</style>',
      css: "@import 'x.css'; @font-face { src: url(https://x.test/f.woff2) }",
      script: 'fetch("/x"); setTimeout(f, 1); var n = Math.random() + Date.now(); root.innerHTML = "<b>";',
    });
    for (const expected of [
      "html: <img>",
      "html: <style>",
      "html: inline on* event",
      "html: http(s) URLs",
      "html: url(...)",
      "css: @import",
      "css: @font-face",
      "css: url(...)",
      "script: fetch",
      "script: setTimeout",
      "script: Math.random",
      "script: Date",
      "script: innerHTML",
    ])
      expect(problems.some((p) => p.startsWith(expected))).toBe(true);
    expect(HtmlCardPackage.safeParse({ ...CLEAN_CARD, html: "x".repeat(16_001) }).success).toBe(false);
    expect(HtmlCardPackage.safeParse({ ...CLEAN_CARD, extra: 1 }).success).toBe(false);
  });
});

describe("HTML card composition shots", () => {
  it("are supported; other code types are still rejected", async () => {
    const ir = cardIr(await writeCard(await scratch("card-support")));
    expect(hyperframesSupport(ir, RENDER_PRESETS.preview)).toEqual({ supported: true, reasons: [] });
    expect(hasCompositionShots(ir)).toBe(false);
    const other: VideoIR = structuredClone(ir);
    other.assets[0]!.mime = "application/vnd.example.scene+json";
    const support = hyperframesSupport(other, RENDER_PRESETS.preview);
    expect(support.supported).toBe(false);
    expect(support.reasons[0]).toMatch(
      /code asset type application\/vnd\.example\.scene\+json is not supported/,
    );
    expect(hasCompositionShots(other)).toBe(true);
  });

  it("compile inline with a CSP, scoped CSS and a wrapped script, and lint clean", async () => {
    const dir = await scratch("card-compile");
    const ir = cardIr(await writeCard(dir));
    expect(validateVideoIR(ir).ok).toBe(true);
    const build = buildComposition(ir, {
      width: 540,
      height: 960,
      assetFiles: { "hero-card": join(dir, "card.json") },
    });
    expect(build.warnings).toEqual([]);
    expect(build.files.get("index.html")).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self' data: blob:; form-action 'none'" />`,
    );
    const hero = build.files.get("compositions/hero.html")!;
    expect(hero).toContain('<div id="s-hero__shot-card" class="html-card"><div class="wrap">');
    // The card sits between the regions and the captions.
    expect(hero.indexOf('class="content"')).toBeLessThan(hero.indexOf('class="html-card"'));
    expect(hero.indexOf('class="html-card"')).toBeLessThan(hero.indexOf('class="captions"'));
    expect(hero).toContain('--font-heading: "Be Vietnam Pro", sans-serif;');
    expect(hero).toMatch(/#s-hero__shot-card \{\n\s*background: radial-gradient/);
    expect(hero).toContain(
      '})(sub, document.getElementById("s-hero__shot-card"), {"width":540,"height":960,"duration":2.3});',
    );
    expect(hero).toContain("tl.add(sub, 0.2);");
    // The card and caption weights are bundled; the code asset is not copied as media.
    const copies = [...build.copies.keys()];
    expect(copies).toContain("assets/fonts/be-vietnam-pro-vietnamese-800-normal.woff2");
    expect(copies).toContain("assets/fonts/be-vietnam-pro-vietnamese-600-normal.woff2");
    expect(copies.some((c) => c.includes("hero-card"))).toBe(false);
    expect(build.files.get("compositions/intro.html")).not.toContain("html-card");

    await writeComposition(build, join(dir, "project"));
    const lint = await lintProject(join(dir, "project"));
    const errors = lint.results.flatMap((r) => r.result.findings.filter((f) => f.severity === "error"));
    expect(errors).toEqual([]);
  });

  it("refuse a missing, malformed or unsafe card with VALIDATION", async () => {
    const dir = await scratch("card-bad");
    const ir = cardIr(join(dir, "card.json"));
    const build = (file?: string) =>
      buildComposition(ir, { width: 540, height: 960, assetFiles: file ? { "hero-card": file } : {} });
    expect(() => build()).toThrow(/no local file/);
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{", "utf8");
    expect(() => build(bad)).toThrow(/not readable JSON/);
    await writeFile(bad, JSON.stringify({ ...CLEAN_CARD, script: "fetch('/x')" }), "utf8");
    try {
      build(bad);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(StudixError);
      expect((err as StudixError).code).toBe("VALIDATION");
      expect((err as StudixError).details?.problems).toEqual(["script: fetch is not allowed (no network)"]);
    }
  });
});

describe("lintHtmlCard", () => {
  it("reports no errors for a clean card and errors for a broken one", async () => {
    const workDir = await scratch("card-lint");
    const opts = { width: 1080, height: 1920, durationMs: 3000, palette: { primary: "#112233" }, workDir };
    expect((await lintHtmlCard(CLEAN_CARD, opts)).errors).toEqual([]);
    expect((await lintHtmlCard({ ...CLEAN_CARD, html: "<iframe></iframe>" }, opts)).errors).toEqual([
      "html: <iframe> is not allowed (cards use inline SVG and CSS only)",
    ]);
    // A safe card the HyperFrames linter rejects: a script syntax error and an unbundled font family.
    const linted = await lintHtmlCard(
      { ...CLEAN_CARD, css: '.title { font-family: "Comic Sans MS"; }', script: "tl.to(root, { x: 1 }" },
      opts,
    );
    expect(linted.errors.some((e) => e.startsWith("invalid_inline_script_syntax:"))).toBe(true);
    expect(linted.errors.some((e) => e.startsWith("font_family_without_font_face:"))).toBe(true);
  });
});

describe("bundled preset fonts", () => {
  it("resolves every preset family to its own Vietnamese-capable files", () => {
    for (const family of ["Playfair Display", "Oswald", "Space Grotesk", "Plus Jakarta Sans"]) {
      const plan = planFonts([{ family, weights: new Set([400, 700]) }]);
      expect(plan.warnings).toEqual([]);
      expect(plan.stacks.get(family)).toMatch(new RegExp(`^"${family}"`));
      expect(plan.files.some((f) => f.dest.endsWith("-vietnamese-700-normal.woff2"))).toBe(true);
    }
  });
});
