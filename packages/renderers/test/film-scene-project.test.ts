import { resolveRenderSpec } from "@studix/video-ir";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFilmSceneProject,
  type FilmSceneMedia,
  type FilmScenePackage,
  filmSceneAssetIds,
  hyperframesSupport,
  parseFilmScenePackage,
} from "../src/index.ts";
import { filmSceneIr, filmScenePackage } from "./film-scene-fixture.ts";
import { tempDir, writePng } from "./render-test-helpers.ts";

let dir = "";
let cleanup: () => Promise<void> = async () => undefined;
let media: Map<string, FilmSceneMedia>;

beforeAll(async () => {
  ({ dir, cleanup } = await tempDir("film-project"));
  media = new Map();
  for (const id of ["set-base", "set-fg", "cel-a"])
    media.set(id, { filePath: await writePng(dir, `${id}.png`), kind: "image", ext: ".png" });
});
afterAll(() => cleanup());

const build = (pkg: FilmScenePackage, extra: Partial<Parameters<typeof buildFilmSceneProject>[0]> = {}) =>
  buildFilmSceneProject({ assetId: "scene-a", pkg, durationMs: 2500, fps: 12, media, ...extra });

describe("film scene package", () => {
  it("parses a valid package and lists the assets it references", () => {
    const pkg = parseFilmScenePackage(JSON.stringify(filmScenePackage()), "scene-a");
    expect(filmSceneAssetIds(pkg)).toEqual(["cel-a", "set-base", "set-fg"]);
  });

  it.each([
    ["not JSON", "{", /not valid JSON/],
    ["a wrong format", JSON.stringify({ ...filmScenePackage(), format: "other" }), /not a film scene/],
    ["a newer engine", JSON.stringify({ ...filmScenePackage(), engine: 2 }), /not a film scene/],
  ])("rejects %s", (_name, raw, message) => {
    expect(() => parseFilmScenePackage(raw, "scene-a")).toThrow(message);
  });

  it("rejects shots that do not tile the EDL in order", () => {
    const pkg = filmScenePackage();
    pkg.edl.shots[1]!.start = 1.5;
    expect(() => parseFilmScenePackage(JSON.stringify(pkg), "scene-a")).toThrow(/expected 1.25s/);
  });

  it("rejects a cel without an image and a retimed clip", () => {
    const pkg = filmScenePackage();
    delete pkg.edl.shots[1]!.img;
    expect(() => parseFilmScenePackage(JSON.stringify(pkg), "scene-a")).toThrow(/cel shots need img/);
    const retimed = filmScenePackage();
    retimed.edl.shots[1] = { id: "s02", kind: "video", start: 1.25, end: 2.5, src: "asset:clip", speed: 1.5 };
    expect(() => parseFilmScenePackage(JSON.stringify(retimed), "scene-a")).toThrow(/conformed clip/);
  });
});

describe("buildFilmSceneProject", () => {
  it("fills the edit page, bundles the scene offline and copies only project files", async () => {
    const project = await build(filmScenePackage(), { params: { push: 1.1 } });
    const html = project.files.get("index.html")!;
    expect(html).toContain('data-composition-id="main"');
    expect(html).toContain('data-duration="2.5000"');
    expect(html).toContain('<script src="assets/vendor/gsap.min.js"></script>');
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toMatch(/(src|href)="https?:/);
    // Karaoke caption: one span per aligned word, the speaker colour and the translation line.
    expect(html).toContain(
      '<div class="cap" id="cap-s01-0" style="--spk:#ffd6e2"><span class="l1"><span class="w0">Ready</span> <span class="w1">now</span></span><span class="l2">Sẵn sàng</span></div>',
    );
    expect(html).toContain('font-family: "Card Serif"');
    const js = project.files.get("dist/film.js")!;
    expect(js).toContain("assets/media/cel-a.png");
    expect(js).toMatch(/push: 1.1/);
    expect(js).not.toContain("asset:");
    expect([...project.copies.keys()].sort()).toEqual(
      expect.arrayContaining([
        "assets/media/cel-a.png",
        "assets/media/set-base.png",
        "assets/media/set-fg.png",
        "assets/vendor/gsap.min.js",
        "assets/fonts/be-vietnam-pro-vietnamese-600-normal.woff2",
      ]),
    );
    expect(project).toMatchObject({ width: 320, height: 180, durationMs: 2500 });
  });

  it("builds the same bundle for the same scene", async () => {
    const a = await build(filmScenePackage());
    const b = await build(filmScenePackage());
    expect(a.files.get("dist/film.js")).toBe(b.files.get("dist/film.js"));
  });

  it("rejects imports outside the engine, three.js and the virtual modules", async () => {
    for (const spec of [
      "https://cdn.example.com/x.js",
      "node:fs",
      "../secrets.js",
      "engine/../../package.json",
    ]) {
      const pkg = filmScenePackage();
      pkg.module = `import x from "${spec}";\nexport const scene = { x };`;
      await expect(build(pkg)).rejects.toThrow(/is not allowed in a film scene/);
    }
  });

  it("rejects a module that does not parse", async () => {
    const pkg = filmScenePackage();
    pkg.module = "export const scene = {";
    await expect(build(pkg)).rejects.toThrow(/does not build/);
  });

  it("rejects an unknown asset, a cel pointing at a non-image and a duration mismatch", async () => {
    const unknown = filmScenePackage();
    unknown.edl.shots[1]!.img = "asset:missing";
    await expect(build(unknown)).rejects.toThrow(/asset:missing is not an image or video asset/);

    const literal = filmScenePackage();
    literal.edl.shots[1]!.img = "assets/cels/s02.jpg";
    await expect(build(literal)).rejects.toThrow(/must reference an image asset/);

    await expect(build(filmScenePackage(), { durationMs: 4000 })).rejects.toThrow(/EDL lasts 2.5s/);
  });
});

describe("hyperframesSupport for composition shots", () => {
  const assets = (mime: string) => [
    {
      id: "scene-a",
      kind: "code" as const,
      storageKey: "test/scene-a.json",
      sha256: "a".repeat(64),
      mime,
      assetVersionId: "asv_1",
      provenance: { source: "generated" as const },
    },
  ];
  const spec = resolveRenderSpec("preview");

  it("accepts a film scene code asset", () => {
    const support = hyperframesSupport(filmSceneIr(assets("application/vnd.studix.film-scene+json")), spec);
    expect(support.reasons).toEqual([]);
  });

  it("reports other code assets", () => {
    const support = hyperframesSupport(filmSceneIr(assets("text/html")), spec);
    expect(support.reasons.join()).toMatch(/text\/html is not supported/);
  });
});
