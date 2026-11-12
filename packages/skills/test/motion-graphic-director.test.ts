import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompositionRunRequest } from "@studix/core";
import type { VideoIR } from "@studix/video-ir";
import type { StageContext } from "@studix/workflow";
import { afterEach, describe, expect, it } from "vitest";
import {
  MG_DIRECTION_AGENT,
  MG_SCENE_BUILD_AGENT,
  motionGraphicDirectorStage,
  motionGraphicTemplate,
  sceneClipTiming,
} from "../src/index.ts";

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
      /** Replies per agent, in order; the default reply once a queue runs out. */
      replies?: Record<string, unknown[]>;
    } = {},
  ) {
    dir = await mkdtemp(join(tmpdir(), "mg-director-"));
    const objects = new Map<string, Uint8Array>();
    const tasks: string[] = [];
    const inputs: Array<Record<string, unknown>> = [];
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
        const clip = request.check?.path as string;
        objects.set(`compositions/${request.compositionId}/files/${clip}`, new TextEncoder().encode("mp4"));
        return { exitCode: opts.exitCode ?? 0, durationMs: 30_000, log: "rendered", changed: [] };
      },
    };
    const runtime = {
      id: "fake",
      async run(_ctx: unknown, task: { skill: string; input: Record<string, unknown> }) {
        tasks.push(task.skill);
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
    return { s, ir, objects, tasks, inputs, runs };
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
    expect(runs[0]?.command).toBe(`hyperframes check . && hyperframes render . -o out/${hook}.mp4 --quiet`);
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

  it("falls back to the card when the sandbox check or render fails", async () => {
    const { s, ir } = await setup({ exitCode: 1 });
    const result = await motionGraphicDirectorStage.run(s);
    const out = result.output as { ir: VideoIR; warning: string };
    expect(out.warning).toMatch(/sandbox check or render failed \(exit 1\)/);
    expect(out.ir.scenes).toEqual(ir.scenes);
    expect(out.ir.metadata?.director).toMatchObject({ scenes: [{ status: "card" }] });
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
