import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompositionRunRequest } from "@studix/core";
import { checkSceneFragment, hexLuma, resolvePalette } from "@studix/renderers";
import { type Scene, type VideoIR, validateVideoIR } from "@studix/video-ir";
import type { StageContext } from "@studix/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  directorFilmTiming,
  directorTierRuns,
  filmAccentRole,
  holdTimesMs,
  MG_DIRECTION_AGENT,
  MG_SCENE_BUILD_AGENT,
  MG_VISUAL_QA_STAGE,
  motionGraphicDirectorStage,
  motionGraphicTemplate,
  motionGraphicVisualQaStage,
  sceneClipTiming,
  withoutMotifCuts,
} from "../src/index.ts";
import { CHECK_GATE_JS, checkFailureSummary } from "../src/motion-graphic/motion-graphic-director-clip.ts";
import { FILM_EXEMPLARS } from "../src/motion-graphic/motion-graphic-director-exemplars.ts";
import {
  authorScenes,
  createBuildGrants,
  filmCheckTimeoutSeconds,
  filmFitsSandbox,
  filmRenderTimeoutSeconds,
  filmSandboxCents,
  filmSandboxMsEstimate,
  mapLimit,
} from "../src/motion-graphic/motion-graphic-director-film.ts";

// The contact sheet is drawn with ffmpeg; here it is any file the reviewer is sent.
vi.mock("@studix/renderers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@studix/renderers")>()),
  writeContactSheet: async (_video: string, _ms: number, _n: number, out: string) => {
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, "jpg");
  },
}));

const brief = { prompt: "Introduce Studix: describe a video, get a finished film", durationMs: 15_000 };
const director = { runtime: "pi", connectionId: "conn_1", provider: "anthropic" } as const;

/** A template graphic whose hook speaks "describe a video, get a finished film" over a 120 BPM bed. */
function graphic() {
  const ir = motionGraphicTemplate(brief);
  const words = ["Describe", "a", "video.", "Get", "a", "finished", "film."].map((w, i) => [
    w,
    120 + i * 300,
    360 + i * 300,
  ]);
  return {
    ...ir,
    metadata: {
      ...ir.metadata,
      spokenWords: words,
      beats: { bpm: 120, beatsMs: [0, 500, 1000, 1500, 2000, 2500], downbeatsMs: [0, 2000] },
    },
  };
}

const fragment = {
  html: '<div class="cam"><div class="head split">Get a finished film.</div></div>',
  css: ".head { position: absolute; left: 80px; top: 600px; font-size: 96px; }",
  js: 'settleCam($s(".cam"), t0, t1); typeWords($s(".head"), W(sid, "get"), T.beatLen / 4); bump($s(".head"), W(sid, "film"));',
};

const direction = {
  concept: "A sentence becomes a film",
  motif: "the prompt pill",
  rhythm: "type, press, reveal",
  scenes: [
    { scene: 1, shot: "the pill types and turns into a frame", focalWords: ["film"], exit: "frame centred" },
  ],
};

describe("sandbox check gate", () => {
  const gate = async (report: unknown) => {
    const { spawnSync } = await import("node:child_process");
    const d = await mkdtemp(join(tmpdir(), "mg-gate-"));
    const path = join(d, "check.json");
    if (report !== undefined)
      await writeFile(path, typeof report === "string" ? report : JSON.stringify(report));
    const run = spawnSync(process.execPath, ["-e", CHECK_GATE_JS, path], { encoding: "utf8" });
    await rm(d, { recursive: true, force: true });
    return { code: run.status, log: run.stdout };
  };
  const section = (findings: unknown[] = []) => ({
    errorCount: findings.length,
    findings,
  });
  const error = (code: string) => ({
    code,
    severity: "error",
    selector: "div.title",
    message: `${code} hit`,
  });

  it("lets layout, motion and contrast errors through to the render and the repair", async () => {
    const report = {
      ok: false,
      lint: section(),
      runtime: section(),
      layout: section([error("text_overlap")]),
      motion: section([error("motion_jump")]),
      contrast: section([error("contrast_aa_failure")]),
    };
    expect((await gate(report)).code).toBe(0);
  });

  it("blocks a missing, unreadable or failed report and lint or runtime errors, with a summary", async () => {
    expect((await gate(undefined)).code).toBe(1);
    expect((await gate("{not json")).code).toBe(1);
    expect((await gate({ error: "no index.html" })).code).toBe(1);
    const broken = await gate({ lint: section([error("unclosed_tag")]), runtime: section() });
    expect(broken.code).toBe(1);
    expect(checkFailureSummary(`noise\n${broken.log}`)).toBe("unclosed_tag div.title unclosed_tag hit");
  });

  it("summarises a failure without a gate line by the log's tail, at most 400 chars", () => {
    expect(checkFailureSummary(`${"x".repeat(500)}render crashed`)).toHaveLength(400);
  });
});

/** A product-UI fragment for the scenes that speak none of the hook's words. */
const uiFragment = {
  html: '<div class="cam"><div class="sx-panel ui"><span class="sx-chip">Rendering</span><div class="sx-rail bar"></div></div></div>',
  css: ".ui { left: 80px; top: 420px; width: 920px; height: 900px; } .bar { left: 64px; right: 64px; top: 400px; }",
  js: 'settleCam($s(".cam"), t0, t1); railTo($s(".bar"), B(1), 0.8); pop($s(".sx-chip"), B(1));',
};

/** The template graphic with `middle` more scenes between its hook and its call to action. */
function filmGraphic(middle = 4): VideoIR {
  const base = graphic() as VideoIR;
  const [hook, cta] = base.scenes as [Scene, Scene];
  const { camera: _camera, motif: _motif, ...plain } = hook;
  const mids: Scene[] = Array.from({ length: middle }, (_, i) => ({
    ...plain,
    id: `mid-${i + 1}`,
    durationMs: 2000,
    shots: hook.shots.map((sh) => ({ ...sh, id: `${sh.id}-m${i + 1}`, startMs: 0, durationMs: 2000 })),
    transitionOut: { kind: "fade", durationMs: 300 },
  }));
  const scenes = [{ ...hook, transitionOut: { kind: "wipe", durationMs: 300 } } as Scene, ...mids, cta];
  let at = 0;
  const first = base.timeline.entries[0] as VideoIR["timeline"]["entries"][number];
  const entries = scenes.map((sc) => {
    const e = { ...first, sceneId: sc.id, startMs: at };
    at += sc.durationMs;
    return e;
  });
  return {
    ...base,
    scenes,
    timeline: { ...base.timeline, entries },
    format: { ...base.format, durationMs: at },
  };
}

/** What the luma measurement prints for a frame that shows only the page, on the first frame of `ir`'s scene 2. */
function blankSecondSceneLuma(ir: VideoIR): string {
  const fps = ir.format.fps;
  const start = Math.round(((ir.scenes[0]?.durationMs ?? 0) * fps) / 1000);
  const y = hexLuma(resolvePalette(ir.brand).background);
  return (
    `frame:0 pts:0 pts_time:${(start / fps).toFixed(6)}\nlavfi.signalstats.YAVG=${y}\n` +
    `lavfi.signalstats.YLOW=${y - 1}\nlavfi.signalstats.YHIGH=${y + 1}\n`
  );
}

const cleanReport = { lint: { errorCount: 0, findings: [] }, runtime: { errorCount: 0, findings: [] } };

describe("motion-graphic film mode", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup(
    opts: {
      premium?: boolean;
      sandbox?: boolean;
      allowed?: boolean;
      /** Scenes between the hook and the call to action. */
      middle?: number;
      budgetCents?: number;
      /** Builder answer per scene id (the default: the hook fragment for the hook, a UI fragment otherwise). */
      buildFor?: (sid: string, input: Record<string, unknown>) => unknown;
      /** Exit code per sandbox run, in order; 0 once the list runs out. */
      exitCodes?: number[];
      /** Sandbox run (from 1) that throws instead of answering. */
      throwOnRun?: number;
      /** The film check's report and log. */
      filmReport?: unknown;
      checkLog?: string;
      /** What the luma measurement prints. */
      luma?: string;
      /** Replies per agent, in order; the default reply once a queue runs out. */
      replies?: Record<string, unknown[]>;
    } = {},
  ) {
    dir = await mkdtemp(join(tmpdir(), "mg-director-"));
    const objects = new Map<string, Uint8Array>();
    const tasks: string[] = [];
    const inputs: Array<Record<string, unknown>> = [];
    const instructions = new Map<string, string>();
    const runs: CompositionRunRequest[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const enc = (t: string) => new TextEncoder().encode(t);
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    const storage = {
      head: async (_c: unknown, key: string) => (objects.has(key) ? { key } : undefined),
      get: async (_c: unknown, key: string) => {
        const bytes = objects.get(key);
        if (!bytes) throw new Error(`no object ${key}`);
        return { body: new Blob([Buffer.from(bytes)]).stream() };
      },
      put: async (_c: unknown, key: string, body: Uint8Array | { filePath: string }) => {
        const bytes = body instanceof Uint8Array ? body : new Uint8Array(await readFile(body.filePath));
        objects.set(key, bytes);
        return { key, bytes: bytes.byteLength, sha256: sha(bytes), contentType: "x" };
      },
      download: async (_c: unknown, key: string, file: string) => {
        const bytes = objects.get(key) as Uint8Array;
        await writeFile(file, bytes);
        return { sha256: sha(bytes), bytes: bytes.byteLength };
      },
    };
    const runner = {
      async run(_s: StageContext, request: CompositionRunRequest) {
        runs.push(request);
        if (opts.throwOnRun === runs.length) throw new Error("sandbox lost");
        const tree = `compositions/${request.compositionId}/files/`;
        const exitCode = opts.exitCodes?.[runs.length - 1] ?? 0;
        if (request.command.includes("out/film-check.json")) {
          objects.set(`${tree}out/film-check.json`, enc(JSON.stringify(opts.filmReport ?? cleanReport)));
          return { exitCode: 0, durationMs: 40_000, log: opts.checkLog ?? "checked", changed: [] };
        }
        const clips = request.command.includes("out/film.mp4")
          ? [...request.command.matchAll(/faststart (out\/\S+\.mp4)/g)].map((m) => m[1] as string)
          : [request.check?.path as string];
        for (const c of clips) objects.set(`${tree}${c}`, enc("mp4"));
        if (opts.luma) objects.set(`${tree}out/film-luma.txt`, enc(opts.luma));
        return {
          exitCode,
          durationMs: 300_000,
          log: "rendered",
          changed: clips.map((path) => ({ path, bytes: 3, sha256: "x", contentType: "video/mp4" })),
        };
      },
    };
    const runtime = {
      id: "fake",
      async run(
        _ctx: unknown,
        task: { skill: string; instructions: string; input: Record<string, unknown> },
      ) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        tasks.push(task.skill);
        instructions.set(task.skill, task.instructions);
        inputs.push(task.input);
        const queued = opts.replies?.[task.skill];
        const sid = (task.input.scene as { id?: string } | undefined)?.id ?? "";
        const output = queued?.length
          ? queued.shift()
          : task.skill === MG_DIRECTION_AGENT
            ? { direction: filmDirection(opts.middle ?? 4) }
            : opts.buildFor
              ? opts.buildFor(sid, task.input)
              : sid.startsWith("mid-")
                ? uiFragment
                : fragment;
        return { output, costCents: 3, inputTokens: 1, outputTokens: 1, turns: 1 };
      },
    };
    const ir = filmGraphic(opts.middle ?? 4);
    const s = {
      ctx: {},
      job: {
        id: "job_director1",
        payload: opts.premium === false ? {} : { roles: { director } },
        budgetCents: opts.budgetCents ?? 1000,
        spentCents: 0,
      },
      attempt: 1,
      signal: new AbortController().signal,
      outputs: { brief: { brief }, "motion-graphic.heroes": { ir } },
      services: {
        storage,
        workRoot: dir,
        ...(opts.sandbox === false
          ? {}
          : { compositions: { runner, centsPerMinute: 2, allows: () => opts.allowed !== false } }),
      },
      agents: { runtime, latestOverrun: async () => undefined, grantedOverruns: async () => 0 },
    } as unknown as StageContext;
    return { s, ir, objects, tasks, inputs, runs, instructions, maxInFlight: () => maxInFlight };
  }

  /** A direction for every scene of `filmGraphic(middle)`. */
  function filmDirection(middle: number, extra: Record<string, unknown> = {}) {
    const count = middle + 2;
    return {
      ...direction,
      system: {
        surface: "a prompt box that becomes a job, then a player",
        anchor: { x: 80, y: 520, w: 920, h: 620 },
      },
      scenes: Array.from({ length: count }, (_, i) => ({
        scene: i + 1,
        shot: i === 0 ? "the pill types" : "the job renders",
        focalWords: ["film"],
        exit: "panel centred",
        exitRect: { x: 100 + i, y: 400, w: 880, h: 700 },
      })),
      ...extra,
    };
  }

  type Out = { ir: VideoIR; warning?: string; film?: Record<string, number> };

  it("leaves a standard graphic untouched", async () => {
    const { s, ir, tasks } = await setup({ premium: false });
    const result = await motionGraphicDirectorStage.run(s);
    expect((result.output as { ir: unknown }).ir).toEqual(ir);
    expect(tasks).toEqual([]);
  });

  it("leaves the graphic exactly as it is, unpaid, when the worker has no sandbox", async () => {
    const { s, ir, tasks } = await setup({ sandbox: false });
    expect(await motionGraphicDirectorStage.estimateCostCents?.(s)).toBe(0);
    expect((await motionGraphicDirectorStage.run(s)).output).toEqual({ ir });
    expect(tasks).toEqual([]);
  });

  it("spends nothing for a workspace outside the sandbox allowlist", async () => {
    const { s, ir, tasks, runs } = await setup({ allowed: false });
    expect(await motionGraphicDirectorStage.estimateCostCents?.(s)).toBe(0);
    const result = await motionGraphicDirectorStage.run(s);
    expect(result.output).toEqual({ ir });
    expect(result.usage ?? []).toEqual([]);
    expect(tasks).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("authors every scene in parallel, checks and renders the film once, and cuts a clip per scene", async () => {
    const { s, ir, objects, tasks, inputs, runs, maxInFlight } = await setup();
    const result = await motionGraphicDirectorStage.run(s);
    const out = result.output as Out;
    const ids = ir.scenes.map((sc) => sc.id);
    // The middle scenes speak no words, so the direction goes back once for their focal words.
    expect(tasks).toEqual([MG_DIRECTION_AGENT, MG_DIRECTION_AGENT, ...ids.map(() => MG_SCENE_BUILD_AGENT)]);
    expect(maxInFlight()).toBeGreaterThan(1);
    expect(maxInFlight()).toBeLessThanOrEqual(5);
    // Run 1 checks the whole film; run 2 renders it and splits it on frame boundaries.
    expect(runs).toHaveLength(2);
    expect(runs[0]?.command).toBe(
      "mkdir -p out && { hyperframes check . --json > out/film-check.json || true; }",
    );
    expect(runs[1]?.timeoutSeconds).toBe(filmRenderTimeoutSeconds(ir.format));
    expect(runs[1]?.command).not.toContain("--quiet");
    expect(runs[1]?.check).toMatchObject({ path: "out/film.mp4", durationMs: ir.format.durationMs });
    for (const id of ids) expect(runs[1]?.command).toContain(`faststart out/${id}.mp4`);
    const tree = `compositions/${runs[0]?.compositionId}/files/`;
    const page = new TextDecoder().decode(objects.get(`${tree}index.html`));
    expect(page).toContain('<div id="chrome" class="layer">');
    // The render isolates scenes too: one that throws is logged and dropped alone, not the film.
    expect(page).toContain('"isolate":true');
    for (const id of ids) {
      expect(page).toContain(`<section id="sc-${id}"`);
      expect(objects.has(`${tree}scenes/${id}.scene.html`)).toBe(true);
      expect(objects.has(`${tree}data/task-${id}.json`)).toBe(true);
    }
    expect(objects.has(`${tree}data/film.json`)).toBe(true);
    // Every scene is now its own muted clip; transitions between two clips are hard cuts.
    for (const sc of out.ir.scenes)
      expect(sc.shots).toEqual([
        expect.objectContaining({ type: "video", muted: true, assetId: `${sc.id}-authored` }),
      ]);
    expect(out.ir.scenes.slice(0, -1).every((sc) => sc.transitionOut?.kind === "cut")).toBe(true);
    expect(out.ir.metadata?.authoredScenes).toEqual(ids);
    expect(out.ir.metadata?.director).toMatchObject({
      shellVersion: 2,
      scenes: ids.map(() => ({ status: "authored" })),
    });
    expect(out.film).toEqual({ checkSeconds: 40, renderSeconds: 300, authored: ids.length, cards: 0 });
    expect(validateVideoIR(out.ir).ok).toBe(true);
    // Only the hook and the call to action carry a line and a headline floor.
    const builds = inputs.slice(2) as Array<{
      scene: { role: string; onScreen?: unknown };
      frame: Record<string, unknown>;
    }>;
    expect(builds.map((b) => b.scene.role)).toEqual(["hook", ...ids.slice(2).map(() => "scene"), "cta"]);
    expect(builds[1]?.scene).not.toHaveProperty("onScreen");
    expect(builds[1]?.frame).not.toHaveProperty("headlinePx");
    expect(builds[0]?.frame).toHaveProperty("headlinePx");
    // The surface carries across cuts: the hook opens at the system anchor, each scene where the last one left it.
    const enter = (i: number) => (builds[i]?.scene as { enterRect?: unknown } | undefined)?.enterRect;
    expect(enter(0)).toEqual({ x: 80, y: 520, w: 920, h: 620 });
    expect(enter(1)).toEqual({ x: 100, y: 400, w: 880, h: 700 });
    expect(enter(2)).toEqual({ x: 101, y: 400, w: 880, h: 700 });
    // No brand logo: the film shows a generated mark, recorded and warned about.
    expect(out.ir.metadata?.generatedMark).toEqual({ kind: "monogram" });
    expect(out.warning).toMatch(/monogram because the brand kit has no logo/);
  });

  it("uses the director's mark, sanitized, when the brand kit has no logo", async () => {
    const mark = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#ff0000" onload="x()"/></svg>';
    const { s, objects, runs } = await setup({
      replies: { [MG_DIRECTION_AGENT]: [{ direction: filmDirection(4, { mark }) }] },
    });
    const out = (await motionGraphicDirectorStage.run(s)).output as Out;
    expect(out.ir.metadata?.generatedMark).toEqual({ kind: "director" });
    const page = new TextDecoder().decode(
      objects.get(`compositions/${runs[0]?.compositionId}/files/index.html`),
    );
    expect(page).toContain(
      '<symbol id="sx-mark" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#ff0000"></circle></symbol>',
    );
    expect(page).not.toContain("onload");
  });

  it("keeps the card of a scene whose fragment still breaks the contract after one repair", async () => {
    const { s, ir, tasks, inputs, runs } = await setup({
      buildFor: (sid) =>
        sid === "mid-2"
          ? { ...uiFragment, js: 'fetch("/x");' }
          : sid.startsWith("mid-")
            ? uiFragment
            : fragment,
    });
    const out = (await motionGraphicDirectorStage.run(s)).output as Out;
    // One builder call per scene, and one repair for the scene that broke the contract.
    expect(tasks.filter((t) => t === MG_SCENE_BUILD_AGENT)).toHaveLength(ir.scenes.length + 1);
    const repair = inputs.find((i) => "repair" in i && "scene" in i)?.repair as {
      issues: Array<{ message: string }>;
    };
    expect(repair.issues[0]?.message).toMatch(/network access/);
    expect(runs[1]?.command).not.toContain("out/mid-2.mp4");
    const card = out.ir.scenes.find((sc) => sc.id === "mid-2");
    expect(card).toEqual(ir.scenes.find((sc) => sc.id === "mid-2"));
    expect(out.ir.metadata?.authoredScenes).not.toContain("mid-2");
    expect(out.warning).toMatch(
      /1 scene kept the template card: mid-2 \(the fragment breaks the contract: js: network access/,
    );
    expect(out.film).toMatchObject({ authored: ir.scenes.length - 1, cards: 1 });
    expect(validateVideoIR(out.ir).ok).toBe(true);
  });

  it("attributes film check errors to their scene and renders only the scenes that passed", async () => {
    const { s, runs } = await setup({
      filmReport: {
        lint: { errorCount: 1, findings: [{ code: "bad_ref", severity: "error", selector: "#sc-mid-1 .x" }] },
        runtime: { errorCount: 0, findings: [] },
      },
      checkLog: "[studix-scene mid-3] boom is not defined",
    });
    const out = (await motionGraphicDirectorStage.run(s)).output as Out;
    expect(runs[1]?.command).not.toContain("out/mid-1.mp4");
    expect(runs[1]?.command).not.toContain("out/mid-3.mp4");
    expect(runs[1]?.command).toContain("out/mid-2.mp4");
    const record = out.ir.metadata?.director as {
      scenes: Array<{ sceneId: string; status: string; reason?: string }>;
    };
    expect(record.scenes.find((r) => r.sceneId === "mid-1")).toMatchObject({
      status: "card",
      reason: expect.stringMatching(/bad_ref/),
    });
    expect(record.scenes.find((r) => r.sceneId === "mid-3")).toMatchObject({
      status: "card",
      reason: expect.stringMatching(/threw/),
    });
  });

  it("keeps every card when the film check names no scene for an error", async () => {
    const { s, ir, runs } = await setup({
      filmReport: {
        lint: { errorCount: 1, findings: [{ code: "shell", severity: "error", message: "broken" }] },
      },
    });
    const out = (await motionGraphicDirectorStage.run(s)).output as Out;
    expect(runs).toHaveLength(1);
    expect(out.ir.scenes).toEqual(ir.scenes);
    expect(out.warning).toMatch(/the film check failed: shell broken/);
  });

  it("keeps every card when the film render fails", async () => {
    const { s, ir } = await setup({ exitCodes: [0, 1] });
    const out = (await motionGraphicDirectorStage.run(s)).output as Out;
    expect(out.ir.scenes).toEqual(ir.scenes);
    expect(out.warning).toMatch(/the film render failed \(exit 1\)/);
    expect(out.film).toMatchObject({ renderSeconds: 300 });
  });

  it("flags a scene that opens on a blank frame at its cut", async () => {
    // mid-1 starts at the hook's length: its first frame shows only the page.
    const { s } = await setup({ luma: blankSecondSceneLuma(filmGraphic()) });
    const out = (await motionGraphicDirectorStage.run(s)).output as Out;
    const record = out.ir.metadata?.director as { scenes: Array<{ sceneId: string; blankCut?: boolean }> };
    expect(record.scenes.find((r) => r.sceneId === "mid-1")?.blankCut).toBe(true);
    expect(record.scenes.filter((r) => r.blankCut)).toHaveLength(1);
    expect(out.warning).toMatch(/mid-1 shows a blank frame at a cut/);
  });

  it("skips the tier before the director is paid when the deadline cannot hold it, and says so", async () => {
    const { s, ir, tasks, runs } = await setup();
    const near = { ...s, job: { ...s.job, deadlineAt: new Date(Date.now() + 10 * 60_000) } } as StageContext;
    expect(await motionGraphicDirectorStage.estimateCostCents?.(near)).toBe(0);
    const out = (await motionGraphicDirectorStage.run(near)).output as Out;
    expect(out.ir).toEqual(ir);
    expect(out.warning).toMatch(/Director tier skipped: .*deadlineSeconds/);
    expect(tasks).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("keeps the card of a scene whose clip cannot be stored, and the record matches the IR", async () => {
    const { s } = await setup();
    const storage = s.services.storage as { put: (...a: never[]) => Promise<unknown> };
    const put = storage.put;
    storage.put = async (...a: never[]) => {
      if (String(a[1]).includes("/authored/mid-1.mp4")) throw new Error("bucket full");
      return put(...a);
    };
    const out = (await motionGraphicDirectorStage.run(s)).output as Out;
    const record = out.ir.metadata?.director as {
      scenes: Array<{ sceneId: string; status: string; reason?: string }>;
    };
    const mid = record.scenes.find((r) => r.sceneId === "mid-1");
    expect(mid?.status).toBe("card");
    expect(mid?.reason).toMatch(/could not be stored/);
    expect(out.ir.metadata?.authoredScenes).not.toContain("mid-1");
    expect(out.ir.metadata?.authoredScenes).toContain("mid-2");
  });

  it("admits the tier on the director, one scene and both sandbox runs, and estimates every scene", async () => {
    // 30¢ director + 15¢ scene + both sandbox runs at their bounds.
    const probe = await setup();
    const sandbox = filmSandboxCents(probe.s, probe.ir.format);
    expect(sandbox).toBeGreaterThan(0);
    const tight = await setup({ budgetCents: 44 + sandbox });
    expect(directorTierRuns(tight.s, tight.ir.scenes.length, tight.ir.format)).toBe(false);
    const enough = await setup({ budgetCents: 45 + sandbox });
    expect(directorTierRuns(enough.s, enough.ir.scenes.length, enough.ir.format)).toBe(true);
    expect(await motionGraphicDirectorStage.estimateCostCents?.(enough.s)).toBe(45 + sandbox);
    expect(await motionGraphicDirectorStage.estimateCostCents?.(probe.s)).toBe(30 + 6 * 15 + sandbox);
  });

  it("scales the sandbox bounds with film length, frame size and rate, and refuses films past the cap", () => {
    const f = { durationMs: 60_000, width: 1920, height: 1080, fps: 30 };
    expect(filmCheckTimeoutSeconds(f)).toBe(660);
    expect(filmRenderTimeoutSeconds(f)).toBe(2460);
    expect(filmSandboxMsEstimate(f)).toBe((360 + 960) * 1000);
    expect(filmRenderTimeoutSeconds({ ...f, durationMs: 15_000, width: 1080, height: 1920 })).toBe(660);
    expect(filmFitsSandbox(f)).toBe(true);
    expect(filmFitsSandbox({ ...f, fps: 60 })).toBe(false);
  });

  it("lets builders in flight settle before rethrowing the first failure", async () => {
    const settled: number[] = [];
    const run = mapLimit([0, 1, 2, 3], 2, async (i) => {
      if (i === 0) throw new Error("boom");
      await new Promise((r) => setTimeout(r, 5));
      settled.push(i);
      return i;
    });
    await expect(run).rejects.toThrow("boom");
    expect(settled).toEqual([1]);
  });

  it("names the role the other scenes really paint with as the film's accent", () => {
    const ir = graphic();
    const palette = { ...ir.brand!.palette, primary: "#1e4bff", accent: "#e8b84a" };
    const painted = {
      ...ir,
      brand: { ...ir.brand!, palette },
      scenes: ir.scenes.map((sc) => ({
        ...sc,
        motif: sc.motif ? { ...sc.motif, color: "#1E4BFF" } : sc.motif,
        shots: sc.shots.map((sh) => ({ ...sh, style: { ...sh.style, color: "primary" } })),
      })),
    } as VideoIR;
    expect(filmAccentRole(painted, painted.scenes[0]!.id)).toBe("primary");
    expect(filmAccentRole({ ...ir, brand: { ...ir.brand!, palette } } as VideoIR, ir.scenes[0]!.id)).toBe(
      "accent",
    );
  });

  describe("visual review of authored scenes", () => {
    const score = (card: number, value: number, issues: string[] = []) => ({
      card,
      score: value,
      issues,
      note: "",
    });

    /** Runs the director, then the review over its IR with a stills capture that records what it drew. */
    async function review(opts: Parameters<typeof setup>[0]) {
      const env = await setup(opts);
      const authored = ((await motionGraphicDirectorStage.run(env.s)).output as { ir: VideoIR }).ir;
      const captured: VideoIR[] = [];
      const engine = {
        render: { name: "render", estimateCostCents: () => 5, run: async () => ({ output: {} }) },
        stills: async (_s: StageContext, ir: VideoIR) => {
          captured.push(ir);
          return { filePath: join(dir as string, "stills.mp4"), seekMs: ir.scenes.map(() => 0), frames: 1 };
        },
      };
      const s = {
        ...env.s,
        outputs: { brief: { brief }, "motion-graphic.authored-scenes": { ir: authored } },
      } as unknown as StageContext;
      const result = await motionGraphicVisualQaStage(engine as never).run(s);
      const out = result.output as { ir: VideoIR; visualQa: { status: string; reason?: string } };
      return { ...env, authored, captured, out };
    }

    it("judges authored scenes at their midpoint", async () => {
      const env = await setup();
      const authored = ((await motionGraphicDirectorStage.run(env.s)).output as { ir: VideoIR }).ir;
      const mid = authored.scenes[1] as Scene;
      const start = authored.scenes[0]?.durationMs ?? 0;
      expect(holdTimesMs(authored)[1]).toBe(start + mid.durationMs / 2);
    });

    it("sends only the three worst scenes back to their builders, with role-aware issues", async () => {
      const cards = { cards: [score(1, 2), score(2, 5), score(3, 1), score(4, 4), score(5, 9), score(6, 3)] };
      const passed = { cards: [1, 2, 3, 4, 5, 6].map((c) => score(c, 8)) };
      const { out, inputs, runs } = await review({
        replies: { [MG_VISUAL_QA_STAGE]: [cards, passed] },
      });
      const repairs = inputs.filter((i) => "repair" in i && "scene" in i) as Array<{
        scene: { id: string };
        repair: { issues: Array<{ message: string }> };
      }>;
      // Scores 1 (card 3), 2 (card 1) and 3 (card 6): the worst three, each one sandbox render.
      const ids = out.ir.scenes.map((sc) => sc.id);
      expect(repairs.map((r) => r.scene.id).sort()).toEqual([ids[0], "mid-2", ids[5]].sort());
      expect(runs).toHaveLength(2 + 3);
      const hook = repairs.find((r) => r.scene.id === out.ir.scenes[0]?.id);
      expect(hook?.repair.issues[0]?.message).toMatch(/headline is at least/);
      const mid = repairs.find((r) => r.scene.id === "mid-2");
      expect(mid?.repair.issues[0]?.message).toMatch(/with no headline/);
      expect(out.visualQa.status).toBe("fixed");
    });

    it("sends a scene that opens blank back to its builder even when its still passed", async () => {
      const luma = blankSecondSceneLuma(filmGraphic());
      const passed = { cards: [1, 2, 3, 4, 5, 6].map((c) => score(c, 8)) };
      const { inputs, out } = await review({ luma, replies: { [MG_VISUAL_QA_STAGE]: [passed, passed] } });
      const repairs = inputs.filter((i) => "repair" in i && "scene" in i) as Array<{
        scene: { id: string };
        repair: { issues: Array<{ message: string }> };
      }>;
      expect(repairs.map((r) => r.scene.id)).toEqual(["mid-1"]);
      expect(repairs[0]?.repair.issues.map((i) => i.message).join()).toMatch(/show only the background/);
      expect(out.visualQa.status).toBe("fixed");
    });
  });

  it("gives a scene clip the hook's words, the bed's beats and its place in the film", () => {
    const ir = graphic();
    const timing = sceneClipTiming(ir, ir.scenes[0]?.id as string);
    expect(timing.scenes[ir.scenes[0]?.id as string]?.lines[0]?.words[0]).toEqual(["describe", 0.12, 0.36]);
    expect(timing.beatLen).toBe(0.5);
    expect(timing.captions).toEqual([]);
    expect(timing.options).toEqual({ fadeIn: false, fadeOut: false });
    expect(timing.film).toEqual({ offset: 0, duration: ir.format.durationMs / 1000 });
    const second = sceneClipTiming(ir, ir.scenes[1]?.id as string);
    expect(second.film?.offset).toBe((ir.scenes[0]?.durationMs ?? 0) / 1000);
    const film = directorFilmTiming(ir);
    expect(film.options).toEqual({ fadeIn: false, fadeOut: false, isolate: true });
    expect(film.duration).toBe(ir.format.durationMs / 1000);
  });
});

describe("film mode helpers", () => {
  const ok = { html: "<i></i>", css: "", js: "pop(S, t0);" };

  it("fans out at most `concurrency` builders and repairs each contract failure once, in parallel", async () => {
    let inFlight = 0;
    let max = 0;
    const calls: Array<{ index: number; repair: boolean }> = [];
    const result = await authorScenes({
      count: 8,
      concurrency: 3,
      build: async (index, repair) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        calls.push({ index, repair: Boolean(repair) });
        if (index === 7) return { failure: "the agent reached its cap", runs: 1 };
        // Scene 2 is fixed by its repair, scene 4 stays broken, scene 5 used its own schema repair turn.
        const bad = (index === 2 && !repair) || index === 4 || index === 5;
        return { built: bad ? { ...ok, js: 'fetch("/x");' } : ok, runs: index === 5 ? 2 : 1 };
      },
      check: (index, built) => checkSceneFragment(built, { sid: `s${index}` }),
    });
    expect(max).toBe(3);
    expect(
      calls
        .filter((c) => c.repair)
        .map((c) => c.index)
        .sort(),
    ).toEqual([2, 4]);
    expect(result.map((r) => ("failure" in r ? r.failure.slice(0, 30) : "ok"))).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "the fragment breaks the contra",
      "the fragment breaks the contra",
      "ok",
      "the agent reached its cap",
    ]);
  });

  it("grants each builder what is left after grants in flight and the sandbox runs", () => {
    let left = 160;
    const grants = createBuildGrants(() => left, 60);
    expect(grants.take()).toBe(40);
    expect(grants.take()).toBe(40);
    // 160 - 80 in flight - 60 held back: 20¢ still holds a scene's expected 15¢.
    expect(grants.take()).toBe(20);
    expect(grants.take()).toBeUndefined();
    grants.release(40);
    left -= 10; // the released call spent 10¢
    expect(grants.take()).toBe(30);
    expect(createBuildGrants(() => Number.POSITIVE_INFINITY, 60).take()).toBe(40);
  });

  it("ships exemplar fragments that pass the contract", () => {
    for (const e of FILM_EXEMPLARS)
      expect(checkSceneFragment({ html: e.html, css: e.css, js: e.js }, { sid: "s01" }).problems).toEqual([]);
  });
});

describe("withoutMotifCuts", () => {
  it("turns a match cut out of an authored hook into a plain cut so the IR stays valid", () => {
    const ir = motionGraphicTemplate(brief);
    const [hook, next] = ir.scenes;
    if (!hook || !next) throw new Error("template needs two scenes");
    // The authored hook lost its motif, but the storyboard's match cut into the next scene survived.
    const { motif: _motif, ...bare } = hook;
    const scenes = ir.scenes.map((sc, i) =>
      i === 0
        ? { ...bare, transitionOut: { kind: "match-cut" as const, durationMs: 0 } }
        : i === 1
          ? { ...sc, motif: { shape: "circle" as const } }
          : sc,
    );
    expect(validateVideoIR({ ...ir, scenes }).ok).toBe(false);
    const fixed = withoutMotifCuts(ir, scenes, hook.id);
    expect(fixed[0]?.transitionOut?.kind).toBe("cut");
    expect(validateVideoIR({ ...ir, scenes: fixed }).ok).toBe(true);
  });
});
