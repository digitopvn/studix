import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { lintProject } from "@hyperframes/lint";
import type { RenderInspection, RenderIssue } from "@studix/core";
import { type Logger, StudixError } from "@studix/shared";
import { resolveSceneSpans, type Shot, type VideoIR } from "@studix/video-ir";
import { burnedCaptionBand, burnedCaptionEdge } from "./brand-tokens.ts";
import { buildComposition, writeComposition } from "./compile-composition.ts";
import { heroSettleMs, prepareHero } from "./hero-html.ts";
import { loadProducer, withConsoleOnLogger } from "./producer-render.ts";
import { shotDomId } from "./shot-markup.ts";

type HtmlShotValue = Extract<Shot, { type: "html" }>;

export interface HeroInspectInput {
  ir: VideoIR;
  width: number;
  height: number;
  fps: number;
  /** Absolute; the composition and the snapshots are written to `<workDir>/inspect`. */
  workDir: string;
  assetFiles?: Readonly<Record<string, string>>;
  logger: Logger;
  signal?: AbortSignal;
}

interface HeroTarget {
  sceneId: string;
  shot: HtmlShotValue;
  /** Global timeline ms of the snapshot. */
  atMs: number;
  /** Burned caption band to keep clear, when captions show during the shot. */
  captionBand?: Box;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What the page reports for one hero card at its settle time. */
interface Measurement {
  found: boolean;
  painted: number;
  overflow: string[];
  clipped: string[];
  captionOverlap: string[];
}

/** Share of each frame dimension text must keep off the frame edge. */
const SAFE_MARGIN = 0.03;
/** Measured problems reported per shot and kind; more of the same adds no signal for the agent. */
const MAX_PER_KIND = 3;

/** Every html shot with its snapshot time: when its entrances have settled, at least 100 ms before it ends. */
function heroTargets(ir: VideoIR, frame: { width: number; height: number }): HeroTarget[] {
  const starts = new Map(resolveSceneSpans(ir.timeline, ir.scenes).map((s) => [s.sceneId, s.startMs]));
  const cues = ir.captions?.mode === "burned" ? ir.captions.cues : [];
  const position = ir.captions?.position ?? "bottom";
  const targets: HeroTarget[] = [];
  for (const scene of ir.scenes) {
    const sceneStart = starts.get(scene.id) ?? 0;
    for (const shot of scene.shots) {
      if (shot.type !== "html") continue;
      const start = sceneStart + shot.startMs;
      const end = start + shot.durationMs;
      const settle = heroSettleMs(prepareHero(shot.html).entrances);
      const atMs = Math.max(start, Math.min(start + settle, end - 100));
      const captioned = cues.some((c) => c.startMs < end && c.endMs > start);
      targets.push({
        sceneId: scene.id,
        shot,
        atMs,
        captionBand: captioned ? captionBox(frame, position) : undefined,
      });
    }
  }
  return targets;
}

function captionBox(frame: { width: number; height: number }, position: "top" | "middle" | "bottom"): Box {
  const band = burnedCaptionBand(frame);
  const edge = burnedCaptionEdge(frame);
  const x = { left: edge, right: frame.width - edge };
  if (position === "top") return { ...x, top: edge, bottom: band };
  if (position === "middle") return { ...x, top: frame.height / 2, bottom: frame.height / 2 + band - edge };
  return { ...x, top: frame.height - band, bottom: frame.height - edge };
}

/**
 * The IR as inspected: film-scene composition shots are dropped (they are captured by the film engine, not
 * the page) and so are media shots whose files were not supplied, so hero cards can be checked before
 * every asset is downloaded.
 */
function inspectableIr(ir: VideoIR, assetFiles: Readonly<Record<string, string>>): VideoIR {
  const keep = (shot: Shot): boolean => {
    if (shot.type === "composition") return false;
    if (shot.type === "image" || shot.type === "video") return Boolean(assetFiles[shot.assetId]);
    if (shot.type === "logo") {
      const assetId = shot.assetId ?? ir.brand?.logoAssetId;
      return !assetId || Boolean(assetFiles[assetId]);
    }
    return true;
  };
  return { ...ir, scenes: ir.scenes.map((scene) => ({ ...scene, shots: scene.shots.filter(keep) })) };
}

/** In-page measurement of one hero card. Runs in the browser: it must stay self-contained. */
function measureInPage(args: {
  selector: string;
  frame: { width: number; height: number };
  margin: { x: number; y: number; percent: number };
  captionBand: Box | null;
}): Measurement {
  const result: Measurement = { found: false, painted: 0, overflow: [], clipped: [], captionOverlap: [] };
  const root = document.querySelector(args.selector);
  if (!root) return result;
  result.found = true;
  const { width, height } = args.frame;
  const describe = (el: Element): string => {
    const id = el.id ? `#${el.id}` : "";
    const cls = el.getAttribute("class")?.trim().split(/\s+/)[0];
    const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `<${el.tagName.toLowerCase()}${id}${cls ? `.${cls}` : ""}>${text ? ` "${text}"` : ""}`;
  };
  const opacity = (el: Element): number => {
    let value = 1;
    for (let node: Element | null = el; node; node = node.parentElement) {
      value *= Number(getComputedStyle(node).opacity);
      if (node === root) break;
    }
    return value;
  };
  const transparent = (color: string) => color === "transparent" || /rgba\(.*,\s*0\)$/.test(color);
  const hasText = (el: Element) =>
    [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
  const SHAPES = new Set(["path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "text"]);
  const painted = (el: Element, style: CSSStyleDeclaration): boolean => {
    if (hasText(el)) return true;
    if (el instanceof SVGElement) return SHAPES.has(el.tagName.toLowerCase());
    if (!transparent(style.backgroundColor) || style.backgroundImage !== "none") return true;
    if (style.boxShadow !== "none") return true;
    return ["Top", "Right", "Bottom", "Left"].some(
      (side) =>
        Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
        !transparent(style.getPropertyValue(`border-${side.toLowerCase()}-color`)),
    );
  };

  // Tight display leading (line-height ~0.85-1.05) lets ascenders and descenders spill a little past the line
  // box without being cut; only a box that clips, or text spilling past a third of its size, reads as clipped.
  const inkRoom = (style: CSSStyleDeclaration) =>
    style.overflowY === "visible" ? Math.max(1, 0.35 * Number.parseFloat(style.fontSize || "0")) : 1;
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || opacity(el) < 0.05) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || !painted(el, style)) continue;
    result.painted++;
    const name = describe(el);
    const text = hasText(el) || el.tagName.toLowerCase() === "text";
    // Inward distance of each side from its frame edge (negative: past the edge).
    const sides = [
      { d: r.left, m: args.margin.x },
      { d: r.top, m: args.margin.y },
      { d: width - r.right, m: args.margin.x },
      { d: height - r.bottom, m: args.margin.y },
    ];
    if (sides.some((s) => s.d < -1)) result.overflow.push(`${name} extends outside the frame`);
    // Text keeps the safe margin; a box may bleed flush to the frame edge but not hug it.
    else if (sides.some((s) => (text ? s.d < s.m : s.d > 1 && s.d < s.m)))
      result.overflow.push(`${name} is inside the ${args.margin.percent}% safe margin at the frame edge`);
    if (
      text &&
      el instanceof HTMLElement &&
      el.clientWidth > 0 &&
      (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + inkRoom(style))
    )
      result.clipped.push(
        `${name} text overflows its box (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`,
      );
    const band = args.captionBand;
    if (
      band &&
      text &&
      r.left < band.right &&
      r.right > band.left &&
      r.top < band.bottom &&
      r.bottom > band.top
    )
      result.captionOverlap.push(`${name} sits under the burned captions`);
  }
  return result;
}

function issuesFor(target: HeroTarget, m: Measurement): RenderIssue[] {
  const at = { sceneId: target.sceneId, shotId: target.shot.id };
  const issues: RenderIssue[] = [];
  if (!m.found || m.painted === 0) {
    issues.push({
      ...at,
      code: "blank",
      message: `html shot "${target.shot.id}" paints nothing visible at ${target.atMs} ms`,
    });
    return issues;
  }
  const push = (code: RenderIssue["code"], messages: string[]) => {
    for (const message of messages.slice(0, MAX_PER_KIND)) issues.push({ ...at, code, message });
    if (messages.length > MAX_PER_KIND)
      issues.push({
        ...at,
        code,
        message: `${messages.length - MAX_PER_KIND} more elements with the same problem`,
      });
  };
  push("overflow", m.overflow);
  push("text-clipped", m.clipped);
  push("caption-overlap", m.captionOverlap);
  return issues;
}

/** HyperFrames lint errors, each on the scene whose composition file it is (the first hero scene otherwise). */
async function lintIssues(
  projectDir: string,
  sceneIds: ReadonlySet<string>,
  fallback: string,
): Promise<RenderIssue[]> {
  const result = await lintProject(projectDir, undefined, { host: "cli" });
  return result.results.flatMap(({ file, result: lint }) => {
    const name = basename(file).replace(/\.html$/, "");
    const sceneId = sceneIds.has(name) ? name : fallback;
    return lint.findings
      .filter((f) => f.severity === "error")
      .map((f) => ({ sceneId, code: "lint" as const, message: `${f.code}: ${f.message}` }));
  });
}

const cancelled = () => new StudixError("CANCELLED", "Inspection cancelled");

/**
 * Pre-render visual QA of html hero cards: writes the composition to `<workDir>/inspect`, runs the HyperFrames
 * lint, then opens it in headless Chrome, seeks to each card's settle time, saves a PNG snapshot
 * (`<sceneId>-<shotId>.png`, kept for the caller) and measures overflow, clipped text, caption overlap and
 * blank cards. Without html shots it returns at once without launching anything.
 */
export async function inspectHeroCards(input: HeroInspectInput): Promise<RenderInspection> {
  const { width, height, signal } = input;
  const frame = { width, height };
  const targets = heroTargets(input.ir, frame);
  if (targets.length === 0) return { issues: [], snapshots: [] };
  if (signal?.aborted) throw cancelled();

  const dir = join(input.workDir, "inspect");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const build = buildComposition(inspectableIr(input.ir, input.assetFiles ?? {}), {
    width,
    height,
    assetFiles: input.assetFiles,
  });
  for (const warning of build.warnings) input.logger.warn(warning);
  await writeComposition(build, dir);

  const issues = await lintIssues(dir, new Set(input.ir.scenes.map((s) => s.id)), targets[0]!.sceneId);
  if (signal?.aborted) throw cancelled();

  const producer = await loadProducer();
  const snapshots: RenderInspection["snapshots"] = [];
  await withConsoleOnLogger(input.logger, async () => {
    const server = await producer.createFileServer({ projectDir: dir, port: 0 });
    let session: Awaited<ReturnType<typeof producer.createCaptureSession>> | undefined;
    let closing: Promise<void> | undefined;
    // Closing the browser on abort makes a pending capture fail fast instead of finishing first.
    const close = (): Promise<void> => {
      if (!session) return Promise.resolve();
      closing ??= producer.closeCaptureSession(session).catch(() => undefined);
      return closing;
    };
    const onAbort = () => void close();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      session = await producer.createCaptureSession(
        server.url,
        dir,
        { width, height, fps: { num: input.fps, den: 1 }, format: "png" },
        null,
        // Plain screenshots: one frame per card, so the fast-capture and dedup machinery only costs time.
        { useDrawElement: false, staticFrameDedup: false, enableBrowserPool: false },
      );
      if (signal?.aborted) throw cancelled();
      await producer.initializeSession(session);
      for (const target of targets) {
        if (signal?.aborted) throw cancelled();
        const time = target.atMs / 1000;
        const { buffer } = await producer.captureFrameToBuffer(session, Math.round(time * input.fps), time);
        const filePath = join(dir, `${target.sceneId}-${target.shot.id}.png`);
        await writeFile(filePath, buffer);
        snapshots.push({ sceneId: target.sceneId, shotId: target.shot.id, filePath, atMs: target.atMs });
        const measured = await session.page.evaluate(measureInPage, {
          selector: `#${shotDomId(`s-${target.sceneId}__`, target.shot.id)}`,
          frame,
          margin: { x: width * SAFE_MARGIN, y: height * SAFE_MARGIN, percent: SAFE_MARGIN * 100 },
          captionBand: target.captionBand ?? null,
        });
        issues.push(...issuesFor(target, measured));
      }
    } catch (err) {
      if (signal?.aborted) throw cancelled();
      if (err instanceof StudixError) throw err;
      throw new StudixError(
        "INTERNAL",
        `Hero card inspection failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          cause: err,
          suggestedAction: "Check that chrome-headless-shell is installed on the host.",
        },
      );
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await close();
      server.close();
    }
  });
  return { issues, snapshots };
}
