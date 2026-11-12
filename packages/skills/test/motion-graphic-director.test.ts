import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompositionRunRequest } from "@studix/core";
import { type VideoIR, validateVideoIR } from "@studix/video-ir";
import type { StageContext } from "@studix/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filmAccentRole,
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

describe("motion-graphic authored hook scene", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup(
    opts: {
      premium?: boolean;
      sandbox?: boolean;
      allowed?: boolean;
      build?: unknown;
      exitCode?: number;
      /** Exit code per sandbox run, in order; `exitCode` once the list runs out. */
      exitCodes?: number[];
      /** Sandbox run (from 1) that throws instead of answering. */
      throwOnRun?: number;
      /** `hyperframes check --json` report the sandbox leaves per run, in order. */
      reports?: unknown[];
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
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    const storage = {
      head: async (_c: unknown, key: string) => (objects.has(key) ? { key } : undefined),
      get: async (_c: unknown, key: string) => ({
        body: new Blob([Buffer.from(objects.get(key) as Uint8Array)]).stream(),
      }),
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
        const clip = request.check?.path as string;
        objects.set(`compositions/${request.compositionId}/files/${clip}`, new TextEncoder().encode("mp4"));
        const report = opts.reports?.[runs.length - 1];
        if (report !== undefined) {
          const path = clip.replace(/\.mp4$/, "-check.json").replace("-reframed-check", "-check");
          objects.set(
            `compositions/${request.compositionId}/files/${path}`,
            new TextEncoder().encode(JSON.stringify(report)),
          );
        }
        return {
          exitCode: opts.exitCodes?.[runs.length - 1] ?? opts.exitCode ?? 0,
          durationMs: 30_000,
          log: "rendered",
          changed: [],
        };
      },
    };
    const runtime = {
      id: "fake",
      async run(
        _ctx: unknown,
        task: { skill: string; instructions: string; input: Record<string, unknown> },
      ) {
        tasks.push(task.skill);
        instructions.set(task.skill, task.instructions);
        inputs.push(task.input);
        const queued = opts.replies?.[task.skill];
        const output = queued?.length
          ? queued.shift()
          : task.skill === MG_DIRECTION_AGENT
            ? { direction }
            : (opts.build ?? fragment);
        return { output, costCents: 3, inputTokens: 1, outputTokens: 1, turns: 1 };
      },
    };
    const ir = graphic();
    const s = {
      ctx: {},
      job: {
        id: "job_director1",
        payload: opts.premium === false ? {} : { roles: { director } },
        budgetCents: 1000,
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
    return { s, ir, objects, tasks, inputs, runs, instructions };
  }

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

  it("authors, stores and renders the hook, then swaps it in as a muted full-frame clip", async () => {
    const { s, ir, objects, tasks, runs } = await setup();
    const result = await motionGraphicDirectorStage.run(s);
    const out = (result.output as { ir: VideoIR }).ir;
    const hook = ir.scenes[0]?.id as string;
    expect(tasks).toEqual([MG_DIRECTION_AGENT, MG_SCENE_BUILD_AGENT]);
    expect(runs[0]?.command).toBe(
      `mkdir -p out && { hyperframes check . --json > out/${hook}-check.json; node -e '${CHECK_GATE_JS}' out/${hook}-check.json; } && ` +
        `hyperframes render . -o out/${hook}.mp4 --quiet`,
    );
    const tree = `compositions/${runs[0]?.compositionId}`;
    expect(objects.has(`${tree}/files/index.html`)).toBe(true);
    expect(objects.has(`${tree}/files/scenes/${hook}.scene.html`)).toBe(true);
    expect(objects.has(`${tree}/files/data/timing.json`)).toBe(true);
    expect(objects.has(`${tree}/manifest.json`)).toBe(true);
    expect(out.scenes[0]?.shots).toEqual([
      expect.objectContaining({ type: "video", muted: true, assetId: `${hook}-authored` }),
    ]);
    expect(out.scenes.slice(1)).toEqual(ir.scenes.slice(1));
    expect(out.metadata?.authoredScenes).toEqual([hook]);
    expect(objects.has(`generated/job_director1/authored/${hook}.mp4`)).toBe(true);
    // Two agent runs at 3¢ and one started minute of sandbox time at 2¢.
    expect(result.usage?.reduce((sum, u) => sum + (u.costCents ?? 0), 0)).toBe(8);
  });

  it("falls back to the card when the fragment still breaks the contract after its repair turn", async () => {
    const { s, ir, runs, tasks, inputs } = await setup({ build: { ...fragment, js: 'fetch("/x");' } });
    const result = await motionGraphicDirectorStage.run(s);
    const out = result.output as { ir: VideoIR; warning: string };
    expect(out.warning).toMatch(/breaks the contract: js: network access/);
    expect(out.ir.scenes).toEqual(ir.scenes);
    expect(runs).toEqual([]);
    expect(tasks).toEqual([MG_DIRECTION_AGENT, MG_SCENE_BUILD_AGENT, MG_SCENE_BUILD_AGENT]);
    expect(inputs[2]?.repair).toMatchObject({
      issues: [expect.objectContaining({ path: "js", message: expect.stringMatching(/network access/) })],
      output: { js: 'fetch("/x");' },
    });
    expect(result.usage?.length).toBe(3);
  });

  it("authors the hook once the builder repairs a fragment that broke the contract", async () => {
    const { s, runs } = await setup({
      replies: { [MG_SCENE_BUILD_AGENT]: [{ ...fragment, js: 'fetch("/x");' }, fragment] },
    });
    const out = (await motionGraphicDirectorStage.run(s)).output as { ir: VideoIR; warning?: string };
    expect(out.warning).toBeUndefined();
    expect(runs).toHaveLength(1);
    expect(out.ir.metadata?.authoredScenes).toHaveLength(1);
  });

  it("reads a drifted but sound direction: long text, string numbers, odd keys, a fourth or unspoken focal word", async () => {
    const long = (n: number) => "the prompt pill glides and morphs ".repeat(20).slice(0, n);
    const drifted = JSON.stringify({
      direction: {
        concept: long(354),
        motif: long(290),
        rhythm: long(304),
        scenes: [
          {
            scene: "1",
            shot: long(306),
            focal_words: ["Film.", "get", "studix", "describe"],
            exit: long(121),
            exitRect: { x: "120", y: 300, w: 840, h: 220, r: 40, unit: "px" },
            mood: "calm",
          },
          { Scene: 2, shot: long(248), focalWords: "sign-up", exit: long(86), exitRect: null },
        ],
      },
    });
    const fenced = `\`\`\`json\n${drifted}\n\`\`\``;
    // Scene 2 speaks no "sign-up": it goes back to the director once, and the same answer earns a warning.
    const { s, inputs, tasks } = await setup({ replies: { [MG_DIRECTION_AGENT]: [fenced, fenced] } });
    const out = (await motionGraphicDirectorStage.run(s)).output as { ir: VideoIR; warning?: string };
    expect(tasks).toEqual([MG_DIRECTION_AGENT, MG_DIRECTION_AGENT, MG_SCENE_BUILD_AGENT]);
    expect(inputs[1]?.repair).toMatchObject({
      issues: [expect.objectContaining({ path: "direction.scenes.1.focalWords" })],
    });
    expect(out.warning).toMatch(/Scene 2 of the direction has no spoken focal word/);
    expect(out.ir.metadata?.authoredScenes).toHaveLength(1);
    const build = inputs[2] as {
      direction: { rhythm: string };
      scene: { focalWords: string[]; exitRect: unknown };
    };
    expect(build.direction.rhythm.length).toBeLessThanOrEqual(300);
    // "studix" is not spoken in the hook, and only three focal words are read.
    expect(build.scene.focalWords).toEqual(["film", "get"]);
    expect(build.scene.exitRect).toEqual({ x: 120, y: 300, w: 840, h: 220, r: 40 });
  });

  it("sends a direction that fails its schema back once, and names the failing paths when it stays broken", async () => {
    const broken = {
      direction: { concept: "x", motif: "y", rhythm: "z", scenes: [{ scene: 0, shot: "s", exit: "e" }] },
    };
    const repaired = await setup({ replies: { [MG_DIRECTION_AGENT]: [broken, { direction }] } });
    const ok = (await motionGraphicDirectorStage.run(repaired.s)).output as { warning?: string };
    expect(ok.warning).toBeUndefined();
    expect(repaired.tasks.slice(0, 2)).toEqual([MG_DIRECTION_AGENT, MG_DIRECTION_AGENT]);
    expect(repaired.inputs[1]?.repair).toMatchObject({
      output: broken,
      issues: expect.arrayContaining([expect.objectContaining({ path: "direction.scenes.0.scene" })]),
    });

    const failing = await setup({ replies: { [MG_DIRECTION_AGENT]: [broken, broken] } });
    const result = await motionGraphicDirectorStage.run(failing.s);
    const out = result.output as { warning: string };
    expect(out.warning).toMatch(
      /fails its schema \(direction\.scenes\.0\.scene: .*direction\.scenes\.0\.focalWords/,
    );
    expect(failing.tasks).toEqual([MG_DIRECTION_AGENT, MG_DIRECTION_AGENT]);
    expect(result.usage?.length).toBe(2);
  });

  it("tells the builder the film's accent token and to keep text inside the frame during camera moves", async () => {
    const { s, inputs, instructions } = await setup();
    await motionGraphicDirectorStage.run(s);
    const build = inputs[1] as {
      theme: { filmAccent: { token: string; color: string }; tokens: Record<string, string> };
    };
    // The template's cards set their accents in the accent role, so the hook is told to use it too.
    expect(build.theme.filmAccent.token).toBe("--accent");
    expect(build.theme.filmAccent.color).toBe(build.theme.tokens["--accent"]);
    expect(instructions.get(MG_SCENE_BUILD_AGENT)).toMatch(/theme\.filmAccent\.token/);
    expect(instructions.get(MG_SCENE_BUILD_AGENT)).toMatch(/camera moves included/);
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

  it("sends text the check finds cut at the frame edge back once, keeping the first clip when the repair fails", async () => {
    const clipped = {
      layout: {
        findings: [
          {
            code: "canvas_overflow",
            severity: "info",
            time: 0.59,
            selector: "div.pill > span:nth-of-type(1)",
            containerSelector: "#root",
            text: "A 15s film",
            overflow: { left: 126 },
          },
        ],
      },
    };
    const { s, runs, inputs, tasks } = await setup({ reports: [clipped], exitCodes: [0, 1] });
    const out = (await motionGraphicDirectorStage.run(s)).output as { ir: VideoIR; warning?: string };
    const hook = out.ir.scenes[0]?.id as string;
    expect(tasks).toEqual([MG_DIRECTION_AGENT, MG_SCENE_BUILD_AGENT, MG_SCENE_BUILD_AGENT]);
    expect(inputs[2]?.repair).toMatchObject({
      issues: [
        { path: "fragment", message: expect.stringMatching(/"A 15s film" .* cut 126px past the left/) },
      ],
    });
    expect(runs.map((r) => r.check?.path)).toEqual([`out/${hook}.mp4`, `out/${hook}-reframed.mp4`]);
    expect(out.warning).toBeUndefined();
    expect(out.ir.metadata?.authoredScenes).toEqual([hook]);
  });

  const cutAtEdge = {
    layout: {
      findings: [
        {
          code: "canvas_overflow",
          severity: "info",
          time: 0.59,
          selector: "div.pill > span:nth-of-type(1)",
          containerSelector: "#root",
          text: "A 15s film",
          overflow: { left: 126 },
        },
      ],
    },
  };

  it("keeps the first clip when the layout repair's render throws", async () => {
    const { s, runs } = await setup({ reports: [cutAtEdge], throwOnRun: 2 });
    const out = (await motionGraphicDirectorStage.run(s)).output as { ir: VideoIR; warning?: string };
    const hook = out.ir.scenes[0]?.id as string;
    expect(runs).toHaveLength(2);
    expect(out.warning).toBeUndefined();
    expect(out.ir.metadata?.authoredScenes).toEqual([hook]);
  });

  it("keeps the first clip without a layout repair when the deadline cannot hold one", async () => {
    const { s, runs, tasks } = await setup({ reports: [cutAtEdge] });
    (s.job as { deadlineAt?: Date }).deadlineAt = new Date(Date.now() + 60_000);
    const out = (await motionGraphicDirectorStage.run(s)).output as { ir: VideoIR; warning?: string };
    expect(tasks).toEqual([MG_DIRECTION_AGENT, MG_SCENE_BUILD_AGENT]);
    expect(runs).toHaveLength(1);
    expect(out.ir.metadata?.authoredScenes).toEqual([out.ir.scenes[0]?.id]);
  });

  it("falls back to the card when the sandbox check or render fails", async () => {
    const { s, ir } = await setup({ exitCode: 1 });
    const result = await motionGraphicDirectorStage.run(s);
    const out = result.output as { ir: VideoIR; warning: string };
    expect(out.warning).toMatch(/sandbox check or render failed \(exit 1\)/);
    expect(out.ir.scenes).toEqual(ir.scenes);
    expect(out.ir.metadata?.director).toMatchObject({ scenes: [{ status: "card" }] });
  });

  describe("visual review of the authored hook", () => {
    const tooSmall = {
      cards: [
        { card: 1, score: 3, issues: ["too-small", "illegible"], note: "the visual sits in a small box" },
      ],
    };
    const passed = { cards: [{ card: 1, score: 8, issues: [], note: "" }] };
    const bigger = {
      ...fragment,
      css: ".head { position: absolute; left: 80px; top: 500px; font-size: 140px; }",
    };

    /** Runs the director, then the review over its IR with a stills capture that records what it drew. */
    async function review(opts: Parameters<typeof setup>[0], failCapture?: number) {
      const env = await setup(opts);
      const authored = ((await motionGraphicDirectorStage.run(env.s)).output as { ir: VideoIR }).ir;
      const captured: VideoIR[] = [];
      const engine = {
        render: { name: "render", estimateCostCents: () => 5, run: async () => ({ output: {} }) },
        stills: async (_s: StageContext, ir: VideoIR) => {
          captured.push(ir);
          if (failCapture === captured.length) throw new Error("capture lost");
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

    it("sends the authored hook's still and its line to the reviewer", async () => {
      const { out, inputs, tasks } = await review({ replies: { [MG_VISUAL_QA_STAGE]: [passed] } });
      expect(tasks.at(-1)).toBe(MG_VISUAL_QA_STAGE);
      const cards = inputs.at(-1)?.cards as unknown[] | undefined;
      expect(cards?.[0]).toMatchObject({ card: 1, authored: true });
      expect(out.visualQa.status).toBe("passed");
    });

    it("sends a hook that reads too small back to its builder once and swaps in the fixed clip", async () => {
      const { out, authored, inputs, tasks, runs, captured } = await review({
        replies: { [MG_VISUAL_QA_STAGE]: [tooSmall, passed], [MG_SCENE_BUILD_AGENT]: [fragment, bigger] },
      });
      expect(tasks.filter((t) => t === MG_SCENE_BUILD_AGENT)).toHaveLength(2);
      const fix = inputs.findLast((i) => "repair" in i)?.repair as { issues: Array<{ message: string }> };
      expect(fix.issues[0]?.message).toMatch(/too-small, illegible\): the visual sits in a small box/);
      expect(fix).toMatchObject({ output: fragment });
      expect(runs).toHaveLength(2);
      const hook = authored.scenes[0]?.id as string;
      const shot = out.ir.scenes[0]?.shots[0] as { assetId: string };
      expect(shot.assetId).toBe(`${hook}-authored-fix`);
      expect(out.ir.assets.some((a) => a.id === `${hook}-authored`)).toBe(false);
      expect(captured).toHaveLength(2);
      expect(out.visualQa.status).toBe("fixed");
    });

    it("keeps the repaired clip, not reviewed again, when the capture after the repair fails", async () => {
      const { out, authored } = await review(
        { replies: { [MG_VISUAL_QA_STAGE]: [tooSmall], [MG_SCENE_BUILD_AGENT]: [fragment, bigger] } },
        2,
      );
      const hook = authored.scenes[0]?.id as string;
      expect(out.ir.scenes[0]?.shots[0]).toMatchObject({ assetId: `${hook}-authored-fix` });
      expect(out.visualQa.status).toBe("failed");
      expect(out.visualQa.reason).toMatch(/repaired but not reviewed again: the review capture failed/);
    });

    it("keeps the current clip and its fragment when the sandbox throws during the repair", async () => {
      const { out, authored, objects, runs } = await review({
        throwOnRun: 2,
        replies: { [MG_VISUAL_QA_STAGE]: [tooSmall], [MG_SCENE_BUILD_AGENT]: [fragment, bigger] },
      });
      expect(out.ir).toEqual(authored);
      expect(out.visualQa.reason).toMatch(/kept its clip: sandbox lost/);
      const hook = authored.scenes[0]?.id as string;
      const stored = objects.get(`compositions/${runs[0]?.compositionId}/files/scenes/${hook}.scene.html`);
      expect(new TextDecoder().decode(stored)).toContain("font-size: 96px");
    });

    it("keeps the current clip when the repaired scene fails its render", async () => {
      const { out, authored, objects, runs } = await review({
        exitCodes: [0, 1],
        replies: { [MG_VISUAL_QA_STAGE]: [tooSmall], [MG_SCENE_BUILD_AGENT]: [fragment, bigger] },
      });
      expect(runs).toHaveLength(2);
      expect(out.ir).toEqual(authored);
      expect(out.visualQa.status).toBe("failed");
      expect(out.visualQa.reason).toMatch(/kept its clip: the sandbox check or render failed/);
      // The tree is put back on the fragment the film shows.
      const hook = authored.scenes[0]?.id as string;
      const stored = objects.get(`compositions/${runs[0]?.compositionId}/files/scenes/${hook}.scene.html`);
      expect(new TextDecoder().decode(stored)).toContain("font-size: 96px");
    });
  });

  it("gives the clip the hook's words and the bed's beats", () => {
    const ir = graphic();
    const timing = sceneClipTiming(ir, ir.scenes[0]?.id as string);
    expect(timing.scenes[ir.scenes[0]?.id as string]?.lines[0]?.words[0]).toEqual(["describe", 0.12, 0.36]);
    expect(timing.beatLen).toBe(0.5);
    expect(timing.captions).toEqual([]);
    expect(timing.options).toEqual({ fadeIn: false, fadeOut: false });
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
