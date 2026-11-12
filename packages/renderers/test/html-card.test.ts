import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lintProject } from "@hyperframes/lint";
import { StudixError } from "@studix/shared";
import { RENDER_PRESETS, type VideoIR, validateVideoIR } from "@studix/video-ir";
import { afterAll, describe, expect, it } from "vitest";
import { planFonts } from "../src/hyperframes/bundled-fonts.ts";
import { sanitizeHtmlCard } from "../src/hyperframes/html-card.ts";
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
  it("passes a clean card with inline SVG, card CSS and tweens", () => {
    expect(HtmlCardPackage.parse(CLEAN_CARD)).toEqual(CLEAN_CARD);
    expect(htmlCardProblems(CLEAN_CARD)).toEqual([]);
  });

  it("rejects the bypasses of a deny-list and names each rule", () => {
    const html = (markup: string) => htmlCardProblems({ ...CLEAN_CARD, html: markup });
    const css = (sheet: string) => htmlCardProblems({ ...CLEAN_CARD, css: sheet });
    expect(html("<svg/onload=alert(1)></svg>")).toEqual(['html: attribute "onload" is not allowed']);
    expect(html('<div title=">" onclick=x>a</div>')).toEqual([
      'html: attribute "title" is not allowed',
      'html: attribute "onclick" is not allowed',
    ]);
    expect(html('<img src="https://x.test/a.png"><style>a{}</style>')).toEqual([
      "html: <img> is not allowed (cards use text elements and inline SVG only)",
      "html: <style> is not allowed (cards use text elements and inline SVG only)",
    ]);
    expect(html('<svg><rect fill="url(https://x.test/a.svg#p)" /></svg>')).toEqual([
      "html: url(...) may only point at #ids inside the card",
    ]);
    expect(html("<svg><div>x</div></svg><span><div>y</div></span>")).toEqual([
      "html: <div> is not allowed inside <svg>",
      "html: <div> is not allowed inside <span> (inline content only)",
    ]);
    expect(css("} body{display:none} #z {")[0]).toMatch(/^css: parse error: Unexpected }/);
    expect(css(".a {} body {display:none}")).toEqual([
      'css: selector "body" must not target :root, html or body',
    ]);
    expect(css("@import 'x.css';")).toEqual(["css: @import is not allowed (no at-rules)"]);
    expect(css(".a { background: url(https://x.test/a.png) }")).toEqual([
      "css: url(...) may only point at #ids inside the card",
    ]);
    expect(css("+ .x { color: red } .a { b: c !important; d: expression(1) }")).toEqual([
      'css: selector "+ .x" must not start with + or ~ (it would leave the card)',
      "css: !important is not allowed",
      "css: expression(), image-set() and element() are not allowed",
    ]);
    // Tweens are data: an unknown property, an ease outside the list or a complex selector fails the schema.
    for (const tween of [
      { target: ".a", at: 0, duration: 1, to: { width: 10 } },
      { target: ".a", at: 0, duration: 1, to: { x: 1 }, ease: "steps(4)" },
      { target: ".a, body", at: 0, duration: 1, to: { x: 1 } },
      { target: ".a", at: 0, duration: 1 },
    ])
      expect(HtmlCardPackage.safeParse({ ...CLEAN_CARD, tweens: [tween] }).success).toBe(false);
    expect(HtmlCardPackage.safeParse({ ...CLEAN_CARD, script: "x" }).success).toBe(false);
  });

  it("re-serializes the checked tree and namespaces ids and url(#id) references", () => {
    const card = sanitizeHtmlCard(
      {
        ...CLEAN_CARD,
        html: '<P CLASS="a">x &lt;b&gt;<!-- c --></P><svg viewbox="0 0 1 1"><linearGradient id="g"></linearGradient><rect fill="url(#g)" /></svg>',
        css: "fill: url('#g'); .a, #g > .b { color: red }",
      },
      "s-x__shot-c",
    );
    expect(card.problems).toEqual([]);
    expect(card.html).toBe(
      '<p class="a">x &lt;b&gt;</p><svg viewBox="0 0 1 1"><linearGradient id="s-x__shot-c-g"></linearGradient><rect fill="url(#s-x__shot-c-g)"></rect></svg>',
    );
    expect(card.css).toBe(
      "#s-x__shot-c {\n  fill: url(#s-x__shot-c-g);\n}\n#s-x__shot-c .a,\n#s-x__shot-c #s-x__shot-c-g > .b {\n  color: red;\n}",
    );
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

  it("compile inline with a CSP, scoped CSS and a generated script, and lint clean", async () => {
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
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self' data: blob:; form-action 'none'" />`,
    );
    const hero = build.files.get("compositions/hero.html")!;
    expect(hero).toContain('<div id="s-hero__shot-card" class="html-card"><div class="wrap">');
    // The card sits between the regions and the captions.
    expect(hero.indexOf('class="content"')).toBeLessThan(hero.indexOf('class="html-card"'));
    expect(hero.indexOf('class="html-card"')).toBeLessThan(hero.indexOf('class="captions"'));
    expect(hero).toContain('--font-heading: "Be Vietnam Pro", sans-serif;');
    expect(hero).toMatch(/#s-hero__shot-card \{\n\s*background: radial-gradient/);
    expect(hero).toContain('<circle id="s-hero__shot-card-arc"');
    expect(hero).toContain('stroke="url(#s-hero__shot-card-g)"');
    // The script is generated: the only card-derived strings in it are JSON-encoded selectors.
    const script = hero.slice(hero.indexOf("<script>"), hero.indexOf("</script>"));
    expect(script).toContain('var root = document.getElementById("s-hero__shot-card");');
    expect(script).toContain(
      'q = root.querySelectorAll("#s-hero__shot-card-arc"); if (q.length) sub.fromTo(q, {"strokeDashoffset":252}, {"strokeDashoffset":0,"duration":0.9,"ease":"power2.out"}, 0);',
    );
    expect(script).toContain(
      'q = root.querySelectorAll(".ring"); if (q.length) sub.to(q, {"scale":1.08,"duration":0.5,"ease":"sine.inOut"}, 1.6);',
    );
    expect(script).toContain("tl.add(sub, 0.2);");
    const strings = [...script.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    for (const text of ["Ra mắt", "wrap", "radial-gradient"])
      expect(strings.some((v) => v?.includes(text))).toBe(false);
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
    await writeFile(bad, JSON.stringify({ ...CLEAN_CARD, html: '<div onclick="x">a</div>' }), "utf8");
    try {
      build(bad);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(StudixError);
      expect((err as StudixError).code).toBe("VALIDATION");
      expect((err as StudixError).details?.problems).toEqual(['html: attribute "onclick" is not allowed']);
    }
  });
});

describe("lintHtmlCard", () => {
  it("reports no errors for a clean card and errors for a broken one", async () => {
    const workDir = await scratch("card-lint");
    const opts = { width: 1080, height: 1920, durationMs: 3000, palette: { primary: "#112233" }, workDir };
    expect((await lintHtmlCard(CLEAN_CARD, opts)).errors).toEqual([]);
    expect((await lintHtmlCard({ ...CLEAN_CARD, html: "<iframe></iframe>" }, opts)).errors).toEqual([
      "html: <iframe> is not allowed (cards use text elements and inline SVG only)",
    ]);
    // A safe card the HyperFrames linter rejects: a font family that is not bundled.
    const linted = await lintHtmlCard(
      { ...CLEAN_CARD, css: '.title { font-family: "Comic Sans MS"; }' },
      opts,
    );
    expect(linted.errors.some((e) => e.startsWith("font_family_without_font_face:"))).toBe(true);
    // Internal failures come back as errors instead of throwing.
    const odd = await lintHtmlCard(CLEAN_CARD, { ...opts, width: 1000, height: 1200 });
    expect(odd.errors[0]).toMatch(/^internal: .*matches no supported aspect ratio/);
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
