import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFilmSceneProject,
  type FilmSceneMedia,
  filmPlateScene,
  filmSceneAssetIds,
  parseFilmScenePackage,
} from "../src/index.ts";
import { tempDir, writePng } from "./render-test-helpers.ts";

let dir = "";
let cleanup: () => Promise<void> = async () => undefined;
let media: Map<string, FilmSceneMedia>;

beforeAll(async () => {
  ({ dir, cleanup } = await tempDir("film-plate"));
  media = new Map([["s1-key", { filePath: await writePng(dir, "s1-key.png"), kind: "image", ext: ".png" }]]);
});
afterAll(() => cleanup());

const plate = (extra: Partial<Parameters<typeof filmPlateScene>[0]> = {}) =>
  filmPlateScene({ imageAssetId: "s1-key", durationMs: 2000, fps: 12, width: 320, height: 180, ...extra });

describe("film plate scene", () => {
  it("is a valid one-cel film scene over the keyframe", () => {
    const pkg = parseFilmScenePackage(JSON.stringify(plate()), "s1-scene");
    expect(filmSceneAssetIds(pkg)).toEqual(["s1-key"]);
    expect(pkg.edl).toMatchObject({ fps: 12, duration: 2, width: 320, height: 180 });
    expect(pkg.edl.shots).toEqual([{ id: "plate", kind: "cel", start: 0, end: 2, img: "asset:s1-key" }]);
    expect(pkg.module).toContain("cels: { plate: { zoom: [1.0, 1.06], focus: [0.5, 0.5] } }");
    expect(pkg.module).not.toContain("weather");
  });

  it("adds a weather preset and its density, and pushes towards the focus", () => {
    const pkg = plate({ weather: "sakura", density: 0.5, push: 1.1, focus: [0.3, 0.6], lang: "vi" });
    expect(pkg.module).toContain('weather: { preset: "sakura"');
    expect(pkg.module).toContain("density: 0.5");
    expect(pkg.module).toContain("zoom: [1.0, 1.1], focus: [0.3, 0.6]");
    expect(pkg.lang).toBe("vi");
  });

  it("rejects an unknown preset and a push beyond the bound", () => {
    expect(() => plate({ weather: "rain" as never })).toThrow();
    expect(() => plate({ push: 2 })).toThrow();
  });

  it("bundles offline through the film scene project builder", async () => {
    const project = await buildFilmSceneProject({
      assetId: "s1-scene",
      pkg: parseFilmScenePackage(JSON.stringify(plate({ weather: "petal" })), "s1-scene"),
      durationMs: 2000,
      fps: 12,
      media,
    });
    const js = project.files.get("dist/film.js")!;
    expect(js).toContain("assets/media/s1-key.png");
    expect(js).not.toContain("asset:");
    expect(project.files.get("index.html")).not.toMatch(/(src|href)="https?:/);
    expect(project).toMatchObject({ width: 320, height: 180, durationMs: 2000 });
  });
});
