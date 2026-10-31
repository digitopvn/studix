import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StudixError } from "@studix/shared";
import { build as esbuild, type Plugin } from "esbuild";
import { type CompositionBuild, GSAP_ASSET } from "../hyperframes/compile-composition.ts";
import { escapeHtml } from "../hyperframes/html-utils.ts";
import { filmSceneFonts } from "./film-scene-fonts.ts";
import {
  type FilmEdl,
  type FilmScenePackage,
  filmSceneAssetIds,
  resolveAssetTokens,
} from "./film-scene-package.ts";

const require = createRequire(import.meta.url);

/** The ported engine (plain JS, kept as ported) and its page template. */
const ENGINE_ROOT = fileURLToPath(new URL("../../film-engine/", import.meta.url));
const ENGINE_SRC = join(ENGINE_ROOT, "src");
const TEMPLATE_PATH = join(ENGINE_ROOT, "edit-template.html");
const BUNDLE_PATH = "dist/film.js";
const DEFAULT_SIZE = { width: 1920, height: 1080 };

/** A local media file a scene references as `asset:<id>`. */
export interface FilmSceneMedia {
  filePath: string;
  kind: "image" | "video";
  /** Extension used inside the project, with the dot (".png"). */
  ext: string;
}

export interface FilmSceneProjectInput {
  /** Code asset id (error messages, page title fallback). */
  assetId: string;
  pkg: FilmScenePackage;
  /** Duration of the composition shot; the EDL must last the same (to one frame). */
  durationMs: number;
  /** Capture frame rate. */
  fps: number;
  /** Composition shot params, importable by the module as `params`. */
  params?: Readonly<Record<string, string | number | boolean>>;
  /** IR asset id -> local media file, for every asset the scene references. */
  media: ReadonlyMap<string, FilmSceneMedia>;
}

export interface FilmSceneProject extends CompositionBuild {
  /** Asset ids the scene references, sorted. */
  assetIds: string[];
}

const invalid = (assetId: string, message: string, details: Record<string, unknown> = {}) =>
  new StudixError("VALIDATION", `Film scene "${assetId}": ${message}`, {
    retryable: false,
    details: { assetId, ...details },
  });

const fixed = (n: number) => n.toFixed(6);

// Port of edit_page_builder._words_html: one span per aligned word, for the karaoke highlight.
function wordsHtml(line: NonNullable<FilmEdl["shots"][number]["dialogue"]>[number]): string {
  const words = line.words ?? [];
  if (words.length === 0) return escapeHtml(line.text).replace(/\n/g, "<br>");
  const spaced = line.text.trim().includes(" ");
  return words.map((w, i) => `<span class="w${i}">${escapeHtml(w.text)}</span>`).join(spaced ? " " : "");
}

// Port of edit_page_builder.captions_html: one hidden caption block per dialogue line.
function captionsHtml(edl: FilmEdl): string {
  const out: string[] = [];
  for (const shot of edl.shots) {
    (shot.dialogue ?? []).forEach((line, n) => {
      const color = (line.speaker ? edl.speakers?.[line.speaker]?.color : undefined) ?? "#ffffff";
      const mono = line.tr ? "" : " mono";
      const l2 = line.tr ? `<span class="l2">${escapeHtml(line.tr)}</span>` : "";
      const pos = line.cap_bottom !== undefined ? `;bottom:${line.cap_bottom}px` : "";
      out.push(
        `      <div class="cap${mono}" id="cap-${shot.id}-${n}" style="--spk:${color}${pos}"><span class="l1">${wordsHtml(line)}</span>${l2}</div>`,
      );
    });
  }
  return out.join("\n");
}

// Port of edit_page_builder.videos_html: HyperFrames cuts each muted clip by data-start / data-duration.
function videosHtml(edl: FilmEdl): string {
  return edl.shots
    .filter((s) => s.kind === "video")
    .map((s) => {
      const mediaStart = s.in ? ` data-media-start="${fixed(s.in)}"` : "";
      return `          <video class="clip" id="v-${s.id}" src="${escapeHtml(s.src!)}" data-start="${fixed(s.start)}" data-duration="${fixed(s.end - s.start)}"${mediaStart} muted playsinline preload="auto"></video>`;
    })
    .join("\n");
}

function titleHtml(edl: FilmEdl): string {
  if (!edl.title?.text) return "";
  return `      <div id="title"><span class="t1">${escapeHtml(edl.title.text)}</span><span class="t2">${escapeHtml(edl.title.sub ?? "")}</span></div>`;
}

/**
 * Resolve the bundle's imports: the engine (`engine/...` and its own relative imports), three.js, and the
 * virtual `edl`, `params` and scene modules. Anything else (a URL, a package, a path outside the engine)
 * fails the build, so a scene runs only code pinned in this package.
 */
function scenePlugin(entry: string, sceneModule: string, edl: unknown, params: unknown): Plugin {
  const threeDir = dirname(require.resolve("three"));
  const threeModule = join(threeDir, "three.module.js");
  const json = (value: unknown) => ({ contents: JSON.stringify(value), loader: "json" as const });
  return {
    name: "studix-film-scene",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path;
        if (args.kind === "entry-point") return { path: "entry", namespace: "film" };
        if (spec === "three") return { path: threeModule };
        if (spec === "edl" || spec === "params" || spec === "scene") return { path: spec, namespace: "film" };
        let target: string | undefined;
        if (spec.startsWith("engine/")) target = resolve(ENGINE_SRC, spec.slice("engine/".length));
        else if (
          (spec.startsWith("./") || spec.startsWith("../")) &&
          args.importer &&
          isAbsolute(args.importer)
        )
          target = resolve(dirname(args.importer), spec);
        // Relative imports stay inside the engine or the three.js build (three.module.js loads three.core.js).
        const inside = (root: string, path: string) => {
          const rel = relative(root, path);
          return !rel.startsWith("..") && !isAbsolute(rel) && rel.endsWith(".js");
        };
        if (target && (inside(ENGINE_SRC, target) || inside(threeDir, target))) return { path: target };
        return { errors: [{ text: `import "${spec}" is not allowed in a film scene` }] };
      });
      build.onLoad({ filter: /.*/, namespace: "film" }, (args) => {
        if (args.path === "entry") return { contents: entry, loader: "js", resolveDir: ENGINE_SRC };
        if (args.path === "scene") return { contents: sceneModule, loader: "js", resolveDir: ENGINE_SRC };
        if (args.path === "edl") return json(edl);
        return json(params);
      });
    },
  };
}

const ENTRY = [
  'import { bootFilm } from "engine/boot-film-engine.js";',
  'import * as m from "scene";',
  "if (!m.scene) throw new Error('film scene module exports no \"scene\"');",
  "bootFilm({ scene: m.scene, fxCues: m.fxCues || null, editCues: m.editCues || null });",
].join("\n");

async function bundle(assetId: string, sceneModule: string, edl: unknown, params: unknown): Promise<string> {
  try {
    const result = await esbuild({
      entryPoints: ["entry"],
      bundle: true,
      write: false,
      format: "iife",
      target: "chrome120",
      platform: "browser",
      logLevel: "silent",
      legalComments: "none",
      charset: "utf8",
      plugins: [scenePlugin(ENTRY, sceneModule, edl, params)],
    });
    const out = result.outputFiles[0];
    if (!out) throw new Error("esbuild produced no output");
    return out.text;
  } catch (err) {
    const errors = (err as { errors?: { text: string }[] }).errors?.map((e) => e.text) ?? [];
    throw invalid(assetId, `the scene module does not build: ${errors[0] ?? String(err)}`, { errors });
  }
}

/**
 * Build the HyperFrames project of one film scene: the ported edit page (videos, captions, title), the
 * scene bundled against the engine, GSAP, the card and caption fonts, and the referenced media. The page
 * loads nothing from outside the project.
 */
export async function buildFilmSceneProject(input: FilmSceneProjectInput): Promise<FilmSceneProject> {
  const { assetId, pkg, fps } = input;
  const frameMs = 1000 / fps;
  if (Math.abs(pkg.edl.duration * 1000 - input.durationMs) > frameMs + 0.5) {
    throw invalid(assetId, `the EDL lasts ${pkg.edl.duration}s but the shot lasts ${input.durationMs}ms`, {
      edlDurationS: pkg.edl.duration,
      shotDurationMs: input.durationMs,
    });
  }

  const assetIds = filmSceneAssetIds(pkg);
  const paths = new Map<string, string>();
  const copies = new Map<string, string>();
  for (const id of assetIds) {
    const media = input.media.get(id);
    if (!media)
      throw invalid(assetId, `asset:${id} is not an image or video asset of the IR`, { missing: id });
    const dest = `assets/media/${id}${media.ext}`;
    paths.set(id, dest);
    copies.set(dest, media.filePath);
  }

  // The EDL drives both the page and the engine; its duration is the shot's, so frame rounding never differs.
  const edl = JSON.parse(resolveAssetTokens(JSON.stringify(pkg.edl), paths)) as FilmEdl;
  edl.duration = input.durationMs / 1000;
  const last = edl.shots[edl.shots.length - 1]!;
  last.end = edl.duration;
  for (const shot of edl.shots) {
    const ref = shot.kind === "cel" ? shot.img : shot.kind === "video" ? shot.src : undefined;
    if (ref === undefined) continue;
    const id = [...paths].find(([, p]) => p === ref)?.[0];
    const want = shot.kind === "cel" ? "image" : "video";
    if (!id || input.media.get(id)?.kind !== want) {
      throw invalid(assetId, `shot "${shot.id}" must reference an ${want} asset as asset:<id>`, {
        shotId: shot.id,
      });
    }
  }
  const width = edl.width ?? DEFAULT_SIZE.width;
  const height = edl.height ?? DEFAULT_SIZE.height;
  edl.width = width;
  edl.height = height;

  const sceneModule = resolveAssetTokens(pkg.module, paths);
  const js = await bundle(assetId, sceneModule, edl, input.params ?? {});

  const fonts = filmSceneFonts();
  const replacements: Record<string, string> = {
    __LANG__: pkg.lang ?? "vi",
    __ORIENTATION__: width >= height ? "landscape" : "portrait",
    __W__: String(width),
    __H__: String(height),
    __FPS__: String(edl.fps),
    __DURATION__: edl.duration.toFixed(4),
    __TITLE_PAGE__: escapeHtml(edl.title?.text ?? assetId),
  };
  let html = await readFile(TEMPLATE_PATH, "utf8");
  for (const [key, value] of Object.entries(replacements)) html = html.replaceAll(key, value);
  html = html
    .replace("/*FONTS*/", fonts.css)
    .replace("<!--VIDEOS-->", videosHtml(edl).trimStart())
    .replace("<!--TITLE-->", titleHtml(edl).trimStart())
    .replace("<!--CAPTIONS-->", captionsHtml(edl).trimStart());

  for (const [dest, source] of fonts.files) copies.set(dest, source);
  copies.set(GSAP_ASSET, require.resolve("gsap/dist/gsap.min.js"));
  const files = new Map<string, string>([
    ["index.html", html],
    [BUNDLE_PATH, js],
  ]);
  return { files, copies, durationMs: input.durationMs, width, height, warnings: [], assetIds };
}
