import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type {
  AgentRuntime,
  AgentTask,
  Job,
  MediaGenerationRequest,
  MediaGenerationResult,
  RendererAdapter,
  StillsOptions,
  StorageAdapter,
  TenantContext,
  UsageEvent,
} from "@studix/core";
import {
  createInMemoryJobStore,
  createInMemoryProjectRepository,
  createInMemoryRenderRepository,
  createInMemoryStageCache,
} from "@studix/core/testing";
import { FakeMediaProvider } from "@studix/providers";
import { createLogger, StudixError } from "@studix/shared";
import type { StoryboardReviewStatus, VideoIR } from "@studix/video-ir";
import {
  createJobExecutor,
  createVideoCreateWorkflow,
  type JobExecutorDeps,
  type QaExpectation,
  type QaGate,
  type WorkerJobQueue,
} from "@studix/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  finalRenderMsEstimate,
  MG_STAGES,
  MG_STORYBOARD_LIMITS,
  MG_VISUAL_QA_STAGE,
  MV_STAGES,
  motionBeatRange,
  packPipelines,
  packRegistry,
  stillWindowsMs,
} from "../src/index.ts";

const clock = { now: () => new Date() };
const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};
const actor = { type: "user", id: "usr_1" } as const;

/** An invented brand: three Vietnamese ad directions for a made-up tea shop. */
const brief = {
  prompt: "Ba quảng cáo dọc 20 giây cho tiệm trà Lá Mây",
  title: "Lá Mây — ba hướng quảng cáo",
  language: "vi",
  aspectRatio: "9:16" as const,
  durationMs: 20_000,
  brand: {
    name: "Lá Mây",
    tagline: "Trà ngon mỗi sớm",
    palette: { primary: "#2f6b4f", background: "#f4efe6", foreground: "#1d2a24", accent: "#d98e3f" },
    fonts: { heading: "Be Vietnam Pro", body: "Be Vietnam Pro" },
    voice: ["ấm áp", "gần gũi"],
  },
  directions: [
    {
      id: "sang-som",
      name: "Buổi sáng",
      concept: "Một tách trà nóng mở đầu ngày mới.",
      hook: "Sáng nay bạn đã uống trà chưa?",
      keyMessages: ["Lá trà hái tay mỗi sớm"],
    },
    {
      id: "ban-be",
      name: "Bạn bè",
      concept: "Nhóm bạn tụ tập bên ấm trà chiều.",
      hook: "Chiều nay hẹn nhau ở Lá Mây",
      keyMessages: ["Không gian yên tĩnh giữa phố"],
    },
    {
      id: "qua-tang",
      name: "Quà tặng",
      concept: "Hộp trà làm quà cho người thương.",
      hook: "Món quà nhỏ, ý nghĩa lớn",
      keyMessages: ["Hộp quà gói sẵn, giao tận nơi"],
    },
  ],
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studix-pack-pipelines-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function memoryStorage(): StorageAdapter & { keys(): string[] } {
  const objects = new Map<string, Buffer>();
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  return {
    keys: () => [...objects.keys()],
    async put(_ctx, key, body, opts) {
      if (!("filePath" in body)) throw new Error("memory storage takes files only");
      const bytes = await readFile(body.filePath);
      objects.set(key, bytes);
      return { key, bytes: bytes.length, sha256: sha(bytes), contentType: opts.contentType };
    },
    async get() {
      throw new Error("not used");
    },
    async download(_ctx, key, filePath) {
      const bytes = objects.get(key);
      if (!bytes) throw new StudixError("NOT_FOUND", `no object ${key}`);
      await writeFile(filePath, bytes);
      return { sha256: sha(bytes), bytes: bytes.length };
    },
    head: async () => undefined,
    signedUrl: async (_ctx, key) => `https://storage.test/${key}`,
    delete: async () => {},
  };
}

/** A tiny still video, so frames can be read from it. */
const writeVideo = (filePath: string, durationMs: number) =>
  execFileSync("ffmpeg", [
    ...["-nostdin", "-loglevel", "error", "-f", "lavfi"],
    ...["-i", `color=c=0x336699:s=160x90:r=5:d=${durationMs / 1000}`],
    ...["-pix_fmt", "yuv420p", "-y", filePath],
  ]);

function fakeRenderer(
  realVideo = false,
  failStillsOn?: number,
): RendererAdapter & { rendered: VideoIR[]; stilled: { ir: VideoIR; windows: StillsOptions["windows"] }[] } {
  const rendered: VideoIR[] = [];
  const stilled: { ir: VideoIR; windows: StillsOptions["windows"] }[] = [];
  return {
    id: "hyperframes",
    rendered,
    stilled,
    supports: () => ({ supported: true, reasons: [] }),
    async render(ir, opts) {
      rendered.push(ir);
      for (const asset of ir.assets) expect(opts.assetFiles[asset.id]).toBeDefined();
      const filePath = join(opts.workDir, "out.mp4");
      if (realVideo) writeVideo(filePath, ir.format.durationMs);
      else await writeFile(filePath, `mp4:${ir.title}`);
      return {
        filePath,
        mime: "video/mp4",
        probe: {
          durationMs: ir.format.durationMs,
          width: 540,
          height: 960,
          fps: 30,
          videoCodec: "h264",
          bytes: 0,
        },
      };
    },
    async stills(ir, opts) {
      stilled.push({ ir, windows: opts.windows });
      if (stilled.length === failStillsOn) throw new StudixError("INTERNAL", "capture crashed");
      for (const asset of ir.assets) expect(opts.assetFiles[asset.id]).toBeDefined();
      const filePath = join(opts.workDir, "stills.mp4");
      if (realVideo) writeVideo(filePath, ir.format.durationMs);
      else await writeFile(filePath, `mp4:${ir.title}`);
      return { filePath, seekMs: opts.windows.map((w) => w.fromMs), frames: opts.windows.length };
    },
  };
}

function harness(
  options: {
    storyboard?: StoryboardReviewStatus;
    qaFails?: boolean;
    /** Stages whose cached outputs are ignored, as after a change to what they produce. */
    uncached?: () => readonly string[];
    /** The in-worker agent; the worker runs no agent services when omitted. */
    agent?: AgentRuntime;
    /** Media kinds whose calls fail before anything is spent, as with a missing provider key. */
    unavailableKinds?: readonly string[];
    /** Media kinds missing from the provider's shared capability list, as when only a workspace has the key. */
    unlistedKinds?: readonly string[];
    /** Length of the voice take of a line, by what it says; the fake's default take otherwise. */
    voiceMs?: (text: string, instructions?: string) => number | undefined;
    /** The fake renderer writes a real video (the visual review reads its frames). */
    realVideo?: boolean;
    /** The fake renderer's stills capture throws on this capture (1-based). */
    failStills?: number;
    /** Rewrites what the fake made, as a real provider's file and word timings would differ. */
    outputs?: (
      request: MediaGenerationRequest,
      result: MediaGenerationResult,
    ) => Promise<MediaGenerationResult>;
  } = {},
) {
  const { jobs } = createInMemoryJobStore(clock);
  const projects = createInMemoryProjectRepository(clock);
  const renders = createInMemoryRenderRepository(clock);
  const storage = memoryStorage();
  const renderer = fakeRenderer(options.realVideo, options.failStills);
  const media = new FakeMediaProvider({ pricing: { estimateCents: (r) => (r.kind === "image" ? 2 : 5) } });
  const real = media.generate.bind(media);
  const listed = media.capabilities.bind(media);
  media.capabilities = async () => (await listed()).filter((c) => !options.unlistedKinds?.includes(c.kind));
  // Voice takes in flight at once, as a provider with a concurrent-request cap would count them.
  const voices = { inFlight: 0, peak: 0 };
  media.generate = async (c, request) => {
    if (request.kind !== "voice") return generateChecked(c, request);
    voices.peak = Math.max(voices.peak, ++voices.inFlight);
    try {
      // Yield so the stage's other lanes can start their takes before this one settles.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await generateChecked(c, request);
    } finally {
      voices.inFlight--;
    }
  };
  const generateChecked: typeof media.generate = async (c, request) => {
    if (options.unavailableKinds?.includes(request.kind)) {
      throw new StudixError("UNAVAILABLE", "multix is missing a key or setting: ELEVENLABS_API_KEY", {
        retryable: false,
      });
    }
    const voiceMs =
      request.kind === "voice"
        ? options.voiceMs?.(request.prompt, request.params?.instructions as string | undefined)
        : undefined;
    if (voiceMs !== undefined) request = { ...request, params: { ...request.params, durationMs: voiceMs } };
    // The real provider reads local inputs only from inside the request's workDir; the fake does not check.
    for (const name of ["image", "video", "audio"]) {
      const value = request.params?.[name];
      if (typeof value !== "string" || value.startsWith("https://")) continue;
      const rel = relative(request.workDir ?? "", value);
      if (!request.workDir || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new StudixError("VALIDATION", `params.${name} must be inside workDir`, { retryable: false });
      }
    }
    const made = await real(c, request);
    return options.outputs ? options.outputs(request, made) : made;
  };
  const generate = vi.spyOn(media, "generate");
  const usage: UsageEvent[] = [];
  const qaCalls: QaExpectation[] = [];
  const qa: QaGate = {
    async assertPasses(_file, expectation) {
      qaCalls.push(expectation);
      if (options.qaFails)
        throw new StudixError("VALIDATION", "QA hard gate failed: loudness", { retryable: false });
      return { pass: true };
    },
  };
  const settled = () => Promise.resolve(true);
  const queue = {
    leaseMs: 60_000,
    heartbeat: async () => ({ held: true, cancelRequested: false }),
    updateProgress: settled,
    writeStage: async (job: Job, _w: string, stage: Parameters<WorkerJobQueue["writeStage"]>[2]) => {
      await jobs.upsertStage(ctx, { ...stage, jobId: job.id, attempt: job.attempts } as never);
      return true;
    },
    recordUsage: async (_job: Job, _w: string, line: UsageEvent) => {
      if (!usage.some((u) => u.dedupeKey === line.dedupeKey)) usage.push(line);
      return true;
    },
    commit: async (_job: Job, _w: string, write: (r: never, c: TenantContext) => Promise<unknown>) => ({
      held: true,
      value: await write({ projects, renders } as never, ctx),
    }),
    complete: vi.fn(settled),
    fail: vi.fn(settled),
    cancel: vi.fn(settled),
    retry: vi.fn(settled),
    release: vi.fn(settled),
    park: vi.fn(settled),
  } as unknown as WorkerJobQueue & Record<"complete" | "fail" | "retry", ReturnType<typeof vi.fn>>;
  const workRoot = join(root, "work");
  const executor = createJobExecutor({
    queue,
    jobs,
    workflows: [
      createVideoCreateWorkflow({
        planner: async () => {
          throw new Error("pack pipelines never call the default planner");
        },
        renderer,
        storage,
        projects,
        renders,
        workRoot,
        pipelines: packPipelines(packRegistry),
      }),
    ],
    approvals: {
      findLatest: async () => undefined,
      list: async () => ({ items: [] }),
    } as unknown as JobExecutorDeps["approvals"],
    ...(options.agent
      ? {
          agents: {
            handoffs: { findLatest: async () => undefined },
            runtimeFor: () => options.agent,
          },
        }
      : {}),
    approvalPolicy: {} as JobExecutorDeps["approvalPolicy"],
    approvalTtlMs: 1,
    billing: { authorizeSpend: async () => ({ allowed: true }) } as unknown as JobExecutorDeps["billing"],
    ledger: {
      record: async () => ({}),
      jobCostCents: async () => usage.reduce((n, u) => n + u.costCents, 0),
    } as unknown as JobExecutorDeps["ledger"],
    clock,
    logger: createLogger({}, { level: "error", write: () => {} }),
    heartbeatIntervalMs: 10_000,
    stageCache: (() => {
      const cache = createInMemoryStageCache(clock);
      return {
        ...cache,
        get: (c: TenantContext, stage: string, key: string) =>
          options.uncached?.().includes(stage) ? Promise.resolve(undefined) : cache.get(c, stage, key),
      } as typeof cache;
    })(),
    storyboardStatus: async () => options.storyboard,
    services: { media, storage, renderer, qa, workRoot },
  });

  let seq = 0;
  async function run(payload: Record<string, unknown>, projectId: string, extra: Partial<Job> = {}) {
    const job = {
      id: `job_${++seq}`,
      organizationId: ctx.organizationId,
      workspaceId: ctx.workspaceId,
      projectId,
      kind: "video.create",
      status: "running",
      payload: { projectId, renderPreset: "preview", ...payload },
      progress: 0,
      attempts: 1,
      maxAttempts: 1,
      spentCents: 0,
      cancelRequested: false,
      createdBy: actor,
      ...extra,
    } as unknown as Job;
    const outcome = await executor.execute(job, "worker-1", new AbortController().signal);
    return { job, outcome };
  }
  /** The outcome with the job's failure, so a failed expectation says why the job failed. */
  const failureOf = (outcome: unknown) => ({ outcome, failure: queue.fail.mock.calls.at(-1)?.[2] });
  return {
    run,
    failureOf,
    jobs,
    projects,
    renders,
    storage,
    renderer,
    generate,
    usage,
    qaCalls,
    queue,
    voices,
  };
}

async function newProject(h: ReturnType<typeof harness>, workflowTemplate: string, b: unknown = brief) {
  const project = await h.projects.create(ctx, {
    title: "Lá Mây",
    status: "draft",
    brief: b as never,
    workflowTemplate,
    createdBy: actor,
  } as never);
  return project.id;
}

describe("marketing-video pipeline (fake providers)", () => {
  it("runs brief -> script -> storyboard frames and stops for review, without any clip or audio job", async () => {
    const h = harness();
    const projectId = await newProject(h, "marketing-video");
    const { outcome } = await h.run({ workflowTemplate: "marketing-video" }, projectId);
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });

    const kinds = h.generate.mock.calls.map(([, r]) => r.kind);
    expect(kinds.length).toBeGreaterThan(0);
    expect(new Set(kinds)).toEqual(new Set(["image"]));
    const project = await h.projects.get(ctx, projectId);
    expect(project?.status).toBe("in_review");
    const version = await h.projects.getVersion(ctx, project?.currentVersionId as string);
    const ir = version?.ir as VideoIR;
    expect(ir.scenes).toHaveLength(3);
    expect(ir.format).toMatchObject({ aspectRatio: "9:16", durationMs: 60_000 });
    expect(ir.language).toBe("vi");
    const images = ir.scenes.flatMap((s) => s.shots.filter((x) => x.type === "image"));
    expect(images).toHaveLength(kinds.length);
    expect(
      ir.assets
        .filter((a) => a.kind === "image")
        .every((a) => a.storageKey && h.storage.keys().includes(a.storageKey)),
    ).toBe(true);
    // Hook within the first three seconds of every ad; captions are chunked to at most nine words.
    for (const scene of ir.scenes) expect(scene.shots[0]?.durationMs).toBeLessThanOrEqual(3000);
    expect(ir.captions?.cues.every((c) => c.text.split(" ").length <= 9)).toBe(true);
    expect(h.renderer.rendered).toHaveLength(0);
    expect(h.usage.filter((u) => u.kind === "media.generation")).toHaveLength(kinds.length);
  });

  /** Once the job marks the project `rendering`, a newer render is approved, as a stale retry would find it. */
  function approveRightAfterRendering(h: ReturnType<typeof harness>) {
    const update = h.projects.update.bind(h.projects);
    vi.spyOn(h.projects, "update").mockImplementation(async (c, id, patch) => {
      const result = await update(c, id, patch);
      if (patch.status === "rendering") await update(c, id, { status: "approved" });
      return result;
    });
  }

  it("does not put an approved project back into review when the publish stage finishes", async () => {
    const h = harness({ storyboard: "approved" });
    const projectId = await newProject(h, "marketing-video");
    await h.run({ workflowTemplate: "marketing-video" }, projectId);
    const project = await h.projects.get(ctx, projectId);
    approveRightAfterRendering(h);
    const { outcome } = await h.run(
      { workflowTemplate: "marketing-video", versionId: project?.currentVersionId },
      projectId,
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect((await h.projects.get(ctx, projectId))?.status).toBe("approved");
  });

  it("moves a project still rendering to review when a feedback reframe finishes", async () => {
    const h = harness({ storyboard: "in_review" });
    const projectId = await newProject(h, "marketing-video");
    await h.run({ workflowTemplate: "marketing-video" }, projectId);
    const project = await h.projects.get(ctx, projectId);
    const base = await h.projects.getVersion(ctx, project?.currentVersionId as string);
    const patchedIr = structuredClone(base?.ir as VideoIR);
    const target = patchedIr.scenes[0]?.shots.find((s) => s.type === "image");
    if (target?.type !== "image") throw new Error("expected an image shot");
    target.alt = "A cup of green tea and loose leaves on a wooden windowsill at sunrise";
    const patched = await h.projects.createVersion(ctx, {
      projectId,
      ir: patchedIr,
      source: "patch",
      parentVersionId: base?.id,
      createdBy: actor,
      advanceFrom: base?.id,
    } as never);
    // An earlier job left the project rendering.
    await h.projects.update(ctx, projectId, { status: "rendering" });
    const { outcome } = await h.run(
      { workflowTemplate: "marketing-video", versionId: patched.id, feedbackId: "rev_1", makeCurrent: false },
      projectId,
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect((await h.projects.get(ctx, projectId))?.status).toBe("in_review");
  });

  it("regenerates only the frames a feedback patch changed, then goes back to review", async () => {
    const h = harness({ storyboard: "in_review" });
    const projectId = await newProject(h, "marketing-video");
    await h.run({ workflowTemplate: "marketing-video" }, projectId);
    const project = await h.projects.get(ctx, projectId);
    const base = await h.projects.getVersion(ctx, project?.currentVersionId as string);
    const baseIr = base?.ir as VideoIR;
    // What submitFeedback stores for a patch on one shot: a child version with the new description.
    const patchedIr = structuredClone(baseIr);
    const target = patchedIr.scenes[0]?.shots.find((s) => s.type === "image");
    if (target?.type !== "image") throw new Error("expected an image shot");
    target.alt = "A cup of green tea and loose leaves on a wooden windowsill at sunrise";
    const patched = await h.projects.createVersion(ctx, {
      projectId,
      ir: patchedIr,
      source: "patch",
      parentVersionId: base?.id,
      createdBy: actor,
      advanceFrom: base?.id,
    } as never);
    h.generate.mockClear();
    const usageBefore = h.usage.length;

    const { outcome } = await h.run(
      { workflowTemplate: "marketing-video", versionId: patched.id, feedbackId: "rev_1", makeCurrent: false },
      projectId,
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect(h.generate).toHaveBeenCalledTimes(1);
    const [, request] = h.generate.mock.calls[0] ?? [];
    expect(request?.kind).toBe("image");
    expect(request?.prompt).toContain("loose leaves on a wooden windowsill");
    expect(h.usage.length - usageBefore).toBe(1);
    expect(h.renderer.rendered).toHaveLength(0);

    const after = await h.projects.get(ctx, projectId);
    expect(after?.status).toBe("in_review");
    expect(after?.currentVersionId).not.toBe(patched.id);
    const reframed = await h.projects.getVersion(ctx, after?.currentVersionId as string);
    if (!reframed) throw new Error("expected the reframed version");
    expect(reframed.parentVersionId).toBe(patched.id);
    const changed = (reframed.ir as VideoIR).assets.filter(
      (a) => baseIr.assets.find((b) => b.id === a.id)?.storageKey !== a.storageKey,
    );
    expect(changed.map((a) => a.id)).toEqual([target.assetId]);

    // A patch that touches no frame description generates nothing and keeps the patched version current.
    const textIr = structuredClone(reframed.ir as VideoIR);
    const text = textIr.scenes[1]?.shots.find((s) => s.type === "text" || s.type === "title");
    if (!text || !("text" in text)) throw new Error("expected a text shot");
    text.text = "Góc yên tĩnh";
    const textVersion = await h.projects.createVersion(ctx, {
      projectId,
      ir: textIr,
      source: "patch",
      parentVersionId: reframed.id,
      createdBy: actor,
      advanceFrom: reframed.id,
    } as never);
    h.generate.mockClear();
    const second = await h.run(
      {
        workflowTemplate: "marketing-video",
        versionId: textVersion.id,
        feedbackId: "rev_2",
        makeCurrent: false,
      },
      projectId,
    );
    expect(h.failureOf(second.outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect(h.generate).not.toHaveBeenCalled();
    expect((await h.projects.get(ctx, projectId))?.currentVersionId).toBe(textVersion.id);
  });

  it("does not reopen review when a reframe job runs after the project moved on", async () => {
    const h = harness({ storyboard: "in_review" });
    const projectId = await newProject(h, "marketing-video");
    await h.run({ workflowTemplate: "marketing-video" }, projectId);
    const project = await h.projects.get(ctx, projectId);
    const base = await h.projects.getVersion(ctx, project?.currentVersionId as string);
    const patchedIr = structuredClone(base?.ir as VideoIR);
    const target = patchedIr.scenes[0]?.shots.find((s) => s.type === "image");
    if (target?.type !== "image") throw new Error("expected an image shot");
    target.alt = "A cup of green tea and loose leaves on a wooden windowsill at sunrise";
    const patched = await h.projects.createVersion(ctx, {
      projectId,
      ir: patchedIr,
      source: "patch",
      parentVersionId: base?.id,
      createdBy: actor,
      advanceFrom: base?.id,
    } as never);
    await h.projects.update(ctx, projectId, { status: "published" });

    const { outcome } = await h.run(
      { workflowTemplate: "marketing-video", versionId: patched.id, feedbackId: "rev_1", makeCurrent: false },
      projectId,
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect((await h.projects.get(ctx, projectId))?.status).toBe("published");
  });

  it("refuses image-to-video and charges nothing until the storyboard is approved", async () => {
    const h = harness({ storyboard: "in_review" });
    const projectId = await newProject(h, "marketing-video");
    await h.run({ workflowTemplate: "marketing-video" }, projectId);
    h.generate.mockClear();
    const project = await h.projects.get(ctx, projectId);
    const { outcome } = await h.run(
      { workflowTemplate: "marketing-video", versionId: project?.currentVersionId },
      projectId,
    );
    expect(outcome).toBe("failed");
    expect(h.generate).not.toHaveBeenCalled();
    const failure = h.queue.fail.mock.calls.at(-1)?.[2] as { code: string };
    expect(failure.code).toBe("APPROVAL_REQUIRED");
  });

  it("renders, gates and publishes one file per ad once the storyboard is approved", async () => {
    const h = harness({ storyboard: "approved" });
    const projectId = await newProject(h, "marketing-video");
    await h.run({ workflowTemplate: "marketing-video" }, projectId);
    const project = await h.projects.get(ctx, projectId);
    h.generate.mockClear();
    const { job, outcome } = await h.run(
      { workflowTemplate: "marketing-video", versionId: project?.currentVersionId },
      projectId,
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    const kinds = h.generate.mock.calls.map(([, r]) => r.kind);
    // One line per beat of each ad, in the IR's language, each with direction for its own beat.
    const voices = h.generate.mock.calls.filter(([, r]) => r.kind === "voice").map(([, r]) => r);
    expect(voices).toHaveLength(9);
    for (const r of voices) expect(r.params).toMatchObject({ language: "vi" });
    const ctaLines = voices.filter((r) => String(r.params?.instructions).includes("call to action"));
    expect(ctaLines).toHaveLength(3);
    expect(kinds.filter((k) => k === "music")).toHaveLength(3);
    expect(kinds.filter((k) => k === "sfx")).toHaveLength(3);
    expect(kinds.filter((k) => k === "video").length).toBeGreaterThanOrEqual(6);
    expect(h.renderer.rendered).toHaveLength(3);
    for (const one of h.renderer.rendered) {
      expect(one.format.durationMs).toBe(20_000);
      expect(one.scenes[0]?.shots.some((s) => s.type === "video")).toBe(true);
      expect(one.audio?.map((t) => t.kind).sort()).toEqual([
        "music",
        "sfx",
        "voiceover",
        "voiceover",
        "voiceover",
      ]);
      expect(one.audio?.every((t) => t.startMs + (t.durationMs ?? 0) <= 20_000)).toBe(true);
      // Each line is heard with its beat: the hook after the lead-in, the message and the call to action
      // on their cuts, none running into the next beat.
      const voice = (one.audio ?? []).filter((t) => t.kind === "voiceover");
      expect(voice.map((t) => t.startMs)).toEqual([300, 3000, 11_500]);
      voice.forEach((t, i) => {
        expect(t.startMs + (t.durationMs ?? 0)).toBeLessThanOrEqual([3000, 11_500, 19_700][i] as number);
      });
    }
    expect(h.qaCalls).toHaveLength(3);
    expect(h.qaCalls.every((q) => q.requireAudio && q.durationMs === 20_000)).toBe(true);
    const published = await h.renders.listByProject(ctx, projectId);
    expect(published.items.filter((r) => r.jobId === job.id)).toHaveLength(3);
    // Every paid call bills once: no dedupe key twice.
    expect(new Set(h.usage.map((u) => u.dedupeKey)).size).toBe(h.usage.length);
  });

  it("re-voices the ads without paying again for clips, music or SFX", async () => {
    let uncached: readonly string[] = [];
    const h = harness({ storyboard: "approved", uncached: () => uncached });
    const projectId = await newProject(h, "marketing-video");
    await h.run({ workflowTemplate: "marketing-video" }, projectId);
    const versionId = (await h.projects.get(ctx, projectId))?.currentVersionId;
    await h.run({ workflowTemplate: "marketing-video", versionId }, projectId);
    h.generate.mockClear();
    h.renderer.rendered.length = 0;
    uncached = [MV_STAGES.voiceover];
    const { job, outcome } = await h.run({ workflowTemplate: "marketing-video", versionId }, projectId);
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect(h.generate.mock.calls.map(([, r]) => r.kind)).toEqual(Array(9).fill("voice"));
    expect(h.renderer.rendered).toHaveLength(3);
    for (const one of h.renderer.rendered) {
      const voice = one.audio?.filter((t) => t.kind === "voiceover") ?? [];
      expect(voice.map((t) => t.startMs)).toEqual([300, 3000, 11_500]);
      for (const t of voice) {
        expect(one.assets.find((a) => a.id === t.assetId)?.storageKey).toContain(job.id);
      }
      expect(
        one.audio
          ?.filter((t) => t.kind !== "voiceover")
          .map((t) => t.kind)
          .sort(),
      ).toEqual(["music", "sfx"]);
    }
  });

  it("publishes nothing when the QA hard gate fails", async () => {
    const h = harness({ storyboard: "approved", qaFails: true });
    const projectId = await newProject(h, "marketing-video");
    await h.run({ workflowTemplate: "marketing-video" }, projectId);
    const project = await h.projects.get(ctx, projectId);
    const { outcome } = await h.run(
      { workflowTemplate: "marketing-video", versionId: project?.currentVersionId },
      projectId,
    );
    expect(outcome).toBe("failed");
    expect((await h.renders.listByProject(ctx, projectId)).items).toHaveLength(0);
  });

  it("fails before any paid call when a voice-over overruns the word budget", async () => {
    const h = harness();
    const long = Array.from({ length: 80 }, (_, i) => `từ${i}`).join(" ");
    const projectId = await newProject(h, "marketing-video", {
      ...brief,
      directions: [
        {
          ...brief.directions[0],
          beats: [
            { visual: "trà", voiceover: long },
            { visual: "ấm", voiceover: "Ghé Lá Mây" },
          ],
        },
      ],
    });
    const { outcome } = await h.run({ workflowTemplate: "marketing-video" }, projectId);
    expect(outcome).toBe("failed");
    expect(h.generate).not.toHaveBeenCalled();
    const failure = h.queue.fail.mock.calls.at(-1)?.[2] as { code: string } | undefined;
    expect(failure?.code).toBe("VALIDATION");
  });
});

describe("motion-graphic pipeline (fake providers)", () => {
  it("composes, voices, renders, gates and uploads with no image-to-video", async () => {
    const h = harness();
    const projectId = await newProject(h, "motion-graphic", {
      prompt: "Motion graphic giới thiệu tiệm trà Lá Mây",
      title: "Lá Mây",
      language: "vi",
      durationMs: 12_000,
      tone: ["editorial", "calm"],
      keyMessages: ["Trà hái tay mỗi sớm", "Giao tận nơi trong ngày"],
      callToAction: "Đặt trà ngay",
    });
    const { outcome } = await h.run({ workflowTemplate: "motion-graphic" }, projectId);
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    // Hook, two messages and the call to action: one line per card, the accent and one whoosh for the cuts.
    expect(h.generate.mock.calls.map(([, r]) => r.kind).sort()).toEqual([
      "sfx",
      "sfx",
      "voice",
      "voice",
      "voice",
      "voice",
    ]);
    expect(h.renderer.rendered).toHaveLength(1);
    const ir = h.renderer.rendered[0] as VideoIR;
    const ctaAt = ir.scenes
      .slice(
        0,
        ir.scenes.findIndex((sc) => sc.id === "cta"),
      )
      .reduce((ms, sc) => ms + sc.durationMs, 0);
    expect(ctaAt).toBeGreaterThan(0);
    // Every line starts where its card does (the first after the lead-in), so the call to action is heard
    // with the CTA card, and none runs into the next card.
    let at = 0;
    const cards = ir.scenes.map((sc) => {
      const span = { startMs: at, endMs: at + sc.durationMs };
      at = span.endMs;
      return span;
    });
    const voice = (ir.audio ?? []).filter((t) => t.kind === "voiceover");
    expect(voice.map((t) => t.assetId)).toEqual(["voiceover-1", "voiceover-2", "voiceover-3", "voiceover-4"]);
    expect(voice.slice(1).map((t) => t.startMs)).toEqual(cards.slice(1).map((c) => c.startMs));
    expect(voice[3]?.startMs).toBe(ctaAt);
    expect(voice[0]?.startMs).toBeGreaterThan(0);
    voice.forEach((t, i) => {
      expect(t.startMs + (t.durationMs ?? 0)).toBeLessThanOrEqual(cards[i]?.endMs as number);
    });
    expect(ir.audio?.at(-1)).toEqual(
      expect.objectContaining({ kind: "sfx", assetId: "sfx-accent", startMs: ctaAt }),
    );
    // No cut is silent: the one whoosh sweeps into every card but the CTA card, which the accent marks.
    const whooshes = (ir.audio ?? []).filter((t) => t.assetId === "sfx-whoosh");
    expect(whooshes.map((t) => t.startMs + 250)).toEqual(cards.slice(1, -1).map((c) => c.startMs));
    expect(h.usage.filter((u) => u.kind === "media.generation")).toHaveLength(6);
    expect(ir.captions?.cues.length).toBeGreaterThan(0);
    expect(ir.metadata?.styleProfile).toEqual(expect.any(String));
    expect(h.qaCalls).toEqual([expect.objectContaining({ requireAudio: true, durationMs: 12_000 })]);
    expect((await h.renders.listByProject(ctx, projectId)).items).toHaveLength(1);
    expect((await h.projects.get(ctx, projectId))?.status).toBe("in_review");
  });

  it("reads the script with direction and re-voices it without paying again for the accent", async () => {
    let uncached: readonly string[] = [];
    const h = harness({ uncached: () => uncached });
    const graphic = {
      prompt: "Motion graphic giới thiệu tiệm trà Lá Mây",
      title: "Lá Mây",
      language: "vi",
      durationMs: 12_000,
      keyMessages: ["Trà hái tay mỗi sớm"],
      callToAction: "Đặt trà ngay",
    };
    await h.run({ workflowTemplate: "motion-graphic" }, await newProject(h, "motion-graphic", graphic));
    const voices = h.generate.mock.calls.filter(([, r]) => r.kind === "voice").map(([, r]) => r);
    // Beats are voiced concurrently, so look each request up by what it says instead of by call order.
    expect(voices).toHaveLength(3);
    const byPrompt = (text: string) => voices.find((r) => r.prompt === text);
    const keyMessage = byPrompt("Trà hái tay mỗi sớm");
    const cta = byPrompt("Đặt trà ngay");
    const script = voices.find((r) => r !== keyMessage && r !== cta);
    expect(keyMessage).toBeDefined();
    expect(cta).toBeDefined();
    expect(script?.params).toMatchObject({
      language: "vi",
      instructions: expect.stringMatching(/Vietnamese.*lean in/),
    });
    expect(cta?.params?.instructions).toContain("call to action");
    h.generate.mockClear();
    h.renderer.rendered.length = 0;
    uncached = [MG_STAGES.voice];
    const { outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", graphic),
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect(h.generate.mock.calls.map(([, r]) => r.kind)).toEqual(["voice", "voice", "voice"]);
    expect(h.renderer.rendered[0]?.audio?.map((t) => t.kind)).toEqual([
      "voiceover",
      "voiceover",
      "voiceover",
      "sfx",
      "sfx",
    ]);
  });

  it("recuts the cards around a take that runs past its card instead of failing the job", async () => {
    const long = "Trà hái tay mỗi sớm";
    const h = harness({ voiceMs: (text) => (text === long ? 4_500 : undefined) });
    const projectId = await newProject(h, "motion-graphic", {
      prompt: "Motion graphic giới thiệu tiệm trà Lá Mây",
      title: "Lá Mây",
      language: "vi",
      durationMs: 12_000,
      keyMessages: [long, "Giao tận nơi trong ngày"],
      callToAction: "Đặt trà ngay",
    });
    const { outcome } = await h.run({ workflowTemplate: "motion-graphic" }, projectId);
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    // One take per line: the cards are cut to the takes, nothing is voiced again.
    expect(h.generate.mock.calls.filter(([, r]) => r.kind === "voice")).toHaveLength(4);
    const ir = h.renderer.rendered[0] as VideoIR;
    expect(ir.scenes.reduce((ms, sc) => ms + sc.durationMs, 0)).toBe(12_000);
    const message = ir.scenes.find((sc) => sc.id === "message-1");
    // The long line's card grew past the even share of the length, taken from the cards with short lines.
    expect(message?.durationMs).toBeGreaterThan(4_000);
    let at = 0;
    const cards = ir.scenes.map((sc) => {
      const span = { startMs: at, endMs: at + sc.durationMs };
      at = span.endMs;
      return span;
    });
    const voice = (ir.audio ?? []).filter((t) => t.kind === "voiceover");
    expect(voice.slice(1).map((t) => t.startMs)).toEqual(cards.slice(1).map((c) => c.startMs));
    voice.forEach((t, i) => {
      expect(t.startMs + (t.durationMs ?? 0)).toBeLessThanOrEqual(cards[i]?.endMs as number);
    });
    // Read at its own pace, whole: the card was cut to the take, so nothing is sped up.
    expect(voice[1]?.durationMs).toBeGreaterThan(4_000);
    expect(voice.every((t) => t.playbackRate === undefined)).toBe(true);
    // The captions, the accent and the whooshes follow the new cuts.
    const cues = ir.captions?.cues ?? [];
    const messageCues = cues.filter(
      (c) => c.startMs >= (cards[1]?.startMs ?? 0) && c.endMs <= (cards[1]?.endMs ?? 0),
    );
    expect(messageCues.map((c) => c.text).join(" ")).toBe(long);
    expect(ir.audio?.find((t) => t.assetId === "sfx-accent")?.startMs).toBe(cards.at(-1)?.startMs);
    const whooshes = (ir.audio ?? []).filter((t) => t.assetId === "sfx-whoosh");
    expect(whooshes.map((t) => t.startMs + 250)).toEqual(cards.slice(1, -1).map((c) => c.startMs));
  });

  it("lays a brisker re-take that fits its card on the cards as they stand", async () => {
    const long = "Trà hái tay mỗi sớm";
    // The long line runs past what any re-cut can give it; its brisker re-take fits its card, so no card moves.
    const h = harness({
      voiceMs: (text, instructions) =>
        text !== long ? undefined : String(instructions).includes("brisker") ? 3_000 : 9_000,
    });
    const projectId = await newProject(h, "motion-graphic", {
      prompt: "Motion graphic giới thiệu tiệm trà Lá Mây",
      title: "Lá Mây",
      language: "vi",
      durationMs: 12_000,
      keyMessages: [long, "Giao tận nơi trong ngày"],
      callToAction: "Đặt trà ngay",
    });
    const even = harness();
    const evenProject = await newProject(even, "motion-graphic", {
      prompt: "Motion graphic giới thiệu tiệm trà Lá Mây",
      title: "Lá Mây",
      language: "vi",
      durationMs: 12_000,
      keyMessages: [long, "Giao tận nơi trong ngày"],
      callToAction: "Đặt trà ngay",
    });
    const { outcome } = await h.run({ workflowTemplate: "motion-graphic" }, projectId);
    await even.run({ workflowTemplate: "motion-graphic" }, evenProject);
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    // The long line is voiced twice, the others once.
    expect(h.generate.mock.calls.filter(([, r]) => r.kind === "voice")).toHaveLength(5);
    const cards = (h.renderer.rendered[0] as VideoIR).scenes.map((sc) => sc.durationMs);
    expect(cards).toEqual((even.renderer.rendered[0] as VideoIR).scenes.map((sc) => sc.durationMs));
  });

  it("voices long lines once more, brisker, and fails only when the takes outrun the whole graphic", async () => {
    const h = harness({ voiceMs: () => 4_000 });
    const projectId = await newProject(h, "motion-graphic", {
      prompt: "Motion graphic giới thiệu tiệm trà Lá Mây",
      title: "Lá Mây",
      language: "vi",
      durationMs: 12_000,
      keyMessages: ["Trà hái tay mỗi sớm", "Giao tận nơi trong ngày"],
      callToAction: "Đặt trà ngay",
    });
    const { outcome } = await h.run({ workflowTemplate: "motion-graphic" }, projectId);
    expect(outcome).toBe("failed");
    const voices = h.generate.mock.calls.filter(([, r]) => r.kind === "voice").map(([, r]) => r);
    expect(voices).toHaveLength(8);
    expect(voices.filter((r) => String(r.params?.instructions).includes("brisker"))).toHaveLength(4);
    const failure = h.queue.fail.mock.calls.at(-1)?.[2] as
      | { code: string; message: string; details?: Record<string, unknown> }
      | undefined;
    expect(failure?.code).toBe("VALIDATION");
    // It names the lines that ran past their cards and by how much, so the caller knows what to shorten.
    expect(failure?.message).toMatch(
      /^The voice-over runs longer than the 12s graphic; past their cards: line 1 ".+" by \d+ ms/,
    );
    expect(failure?.details).toMatchObject({
      totalMs: 12_000,
      lines: expect.arrayContaining([
        expect.objectContaining({ line: 1, overrunMs: expect.any(Number), roomMs: expect.any(Number) }),
      ]),
    });
  });

  it("re-renders a stored version through render -> QA -> upload", async () => {
    const h = harness();
    const projectId = await newProject(h, "motion-graphic", {
      prompt: "Motion graphic cho Lá Mây",
      keyMessages: ["Trà ngon"],
    });
    await h.run({ workflowTemplate: "motion-graphic" }, projectId);
    h.generate.mockClear();
    const project = await h.projects.get(ctx, projectId);
    const { outcome } = await h.run(
      { workflowTemplate: "motion-graphic", versionId: project?.currentVersionId },
      projectId,
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.qaCalls).toHaveLength(2);
  });

  it("makes a voiceless graphic with no voice, captions or accent when the brief asks for none", async () => {
    const h = harness();
    const projectId = await newProject(h, "motion-graphic", {
      prompt: "Motion graphic cho Lá Mây",
      durationMs: 10_000,
      keyMessages: ["Trà hái tay mỗi sớm", "Giao tận nơi"],
      voiceover: false,
    });
    const { outcome } = await h.run({ workflowTemplate: "motion-graphic" }, projectId);
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect(h.generate).not.toHaveBeenCalled();
    const ir = h.renderer.rendered[0] as VideoIR;
    expect(ir.metadata?.voiceover).toBeUndefined();
    expect(ir.captions).toBeUndefined();
    expect(ir.audio ?? []).toEqual([]);
    expect(ir.scenes.map((sc) => sc.id)).toEqual(["hook", "message-1", "message-2", "cta"]);
    expect(h.qaCalls).toEqual([expect.objectContaining({ requireAudio: false })]);
  });

  it("adds the SFX accent when the call works although the shared capability list omits sound effects", async () => {
    const h = harness({ unlistedKinds: ["sfx"] });
    const projectId = await newProject(h, "motion-graphic", {
      prompt: "Motion graphic cho Lá Mây",
      durationMs: 10_000,
      keyMessages: ["Trà hái tay mỗi sớm"],
    });
    const { job, outcome } = await h.run({ workflowTemplate: "motion-graphic" }, projectId);
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    const ir = h.renderer.rendered[0] as VideoIR;
    expect(ir.audio?.map((t) => t.kind)).toEqual(["voiceover", "voiceover", "voiceover", "sfx", "sfx"]);
    const stages = await h.jobs.listStages(ctx, job.id);
    expect(stages.find((st) => st.name === MG_STAGES.accent)?.output?.warning).toBeUndefined();
  });

  it("skips the SFX accent with a warning when the media provider cannot make one", async () => {
    const h = harness({ unavailableKinds: ["sfx"] });
    const projectId = await newProject(h, "motion-graphic", {
      prompt: "Motion graphic cho Lá Mây",
      durationMs: 10_000,
      keyMessages: ["Trà hái tay mỗi sớm"],
    });
    const { job, outcome } = await h.run({ workflowTemplate: "motion-graphic" }, projectId);
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    const ir = h.renderer.rendered[0] as VideoIR;
    expect(ir.audio?.map((t) => t.kind)).toEqual(["voiceover", "voiceover", "voiceover"]);
    const stages = await h.jobs.listStages(ctx, job.id);
    const accent = stages.find((st) => st.name === MG_STAGES.accent);
    expect(accent?.output?.warning).toMatch(/SFX accent skipped: .*ELEVENLABS_API_KEY/);
  });
});

describe("motion-graphic storyboard agent (mock agent)", () => {
  const graphic = {
    prompt: "Motion graphic 10 giây giới thiệu tiệm trà Lá Mây",
    title: "Lá Mây",
    language: "vi",
    aspectRatio: "16:9" as const,
    durationMs: 10_000,
    keyMessages: ["Trà hái tay mỗi sớm"],
    callToAction: "Đặt trà ngay",
  };
  const storyboard = {
    styleProfile: "swiss-kinetic-editorial",
    beats: [
      {
        onScreen: "Sáng nay, trà gì?",
        voiceover: "Sáng nay bạn uống trà gì?",
        visual: "Chữ lớn trượt vào",
        enter: "slide-left",
        weight: 1,
      },
      {
        onScreen: "Hái tay mỗi sớm",
        voiceover: "Lá trà hái tay mỗi sớm.",
        visual: "Lưới Swiss, nhấn màu",
        layout: { kind: "chips", hub: "Lá Mây", items: ["Hái tay", "Mỗi sớm"] },
        enter: "pop",
        weight: 1.5,
      },
      {
        onScreen: "Đặt trà ngay",
        voiceover: "Đặt trà ngay hôm nay.",
        visual: "Logo và CTA",
        enter: "scale",
        weight: 1,
      },
    ],
    music: "calm lo-fi pulse, 90 bpm",
    brandName: "Lá Mây",
    rationale: "Swiss editorial suits a calm, factual tea brand.",
  };
  /** A scripted agent that records its tasks and bills 3¢ a run. */
  const mockAgent = (output: unknown) => {
    const tasks: AgentTask[] = [];
    const runtime: AgentRuntime = {
      id: "mock",
      run: async (_ctx, task) => {
        tasks.push(task);
        return { output, turns: 1, costCents: 3, inputTokens: 4000, outputTokens: 600, model: "mock-model" };
      },
    };
    return { runtime, tasks };
  };

  it("lays out the agent's style, beats, entrances, weights and music bed", async () => {
    const agent = mockAgent({ storyboard });
    const h = harness({ agent: agent.runtime });
    const { outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", graphic),
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    // The agent reads the brief, the style menu and a bounded digest of the three motion packs.
    expect(agent.tasks).toHaveLength(1);
    const task = agent.tasks[0] as AgentTask;
    expect(task.skill).toBe(MG_STAGES.storyboard);
    expect(task.maxCostCents).toBe(MG_STORYBOARD_LIMITS.maxCostCents);
    const input = task.input as { craft: string; wordBudget: number; styles: unknown[]; durationMs: number };
    expect(input.durationMs).toBe(10_000);
    expect(input.styles.length).toBeGreaterThan(10);
    expect(input.craft).toContain("Avoid:");
    expect(input.craft.length).toBeLessThanOrEqual(12_000);
    const ir = h.renderer.rendered[0] as VideoIR;
    expect(ir.metadata).toMatchObject({ styleProfile: "swiss-kinetic-editorial", storyboard: "agent" });
    // The profile locks entrances: "pop" is not a swiss-kinetic-editorial entrance, so its default stands in.
    expect(ir.scenes.map((sc) => sc.shots[0]?.animation?.enter)).toEqual(["slide-left", "slide-up", "scale"]);
    expect(ir.scenes.map((sc) => sc.durationMs)).toEqual([3300, 3500, 3200]);
    expect(ir.format).toMatchObject({ aspectRatio: "16:9", durationMs: 10_000 });
    expect(h.generate.mock.calls.map(([, r]) => r.kind).sort()).toEqual([
      "music",
      "sfx",
      "sfx",
      "voice",
      "voice",
      "voice",
    ]);
    // The bed sits under the whole graphic and dips while the voice speaks.
    expect(ir.audio?.find((t) => t.kind === "music")).toMatchObject({ startMs: 0, volume: 0.3, duckDb: -9 });
    // It is composed in sections that add up to the graphic, the drop where the CTA card starts.
    const music = h.generate.mock.calls.map(([, r]) => r).find((r) => r.kind === "music");
    const sections = music?.params?.sections as Array<{ name: string; durationMs: number }>;
    expect(sections.map((sc) => sc.name)).toEqual(["intro", "build", "drop"]);
    expect(sections.reduce((n, sc) => n + sc.durationMs, 0)).toBe(10_000);
    expect(music?.params?.durationMs).toBe(10_000);
    // Speech asks for word timings; the fake provider reports none, so reveals follow estimated words.
    const voices = h.generate.mock.calls.map(([, r]) => r).filter((r) => r.kind === "voice");
    expect(voices.every((r) => r.params?.timestamps === true)).toBe(true);
    expect(ir.metadata).toMatchObject({ wordSync: "estimate" });
    expect(h.usage.filter((u) => u.kind === "agent.run").map((u) => u.costCents)).toEqual([3]);
  });

  /** A storyboard agent that redesigns card 2, and a reviewer that fails card 2 once, then passes every card. */
  const reviewedAgent = () => {
    const restyled = {
      ...storyboard,
      beats: storyboard.beats.map((b, i) =>
        i === 1
          ? { ...b, voiceover: "Câu khác hẳn.", layout: { kind: "stat", value: "100%", label: "hái tay" } }
          : { ...b, onScreen: "Đổi lén" },
      ),
    };
    const score = (card: number, issues: string[] = [], value = 8) => ({
      card,
      score: value,
      issues,
      note: "",
    });
    const reviews = [
      // Card 1 is a headline card, which the hook may be; only card 2 fails.
      { cards: [score(1, ["headline-only"]), score(2, ["too-small"], 4), score(3)] },
      { cards: [score(1), score(2), score(3)] },
    ];
    const tasks: AgentTask[] = [];
    const runtime: AgentRuntime = {
      id: "mock",
      run: async (_ctx, task) => {
        tasks.push(task);
        const output =
          task.skill === MG_VISUAL_QA_STAGE
            ? reviews[tasks.filter((t) => t.skill === MG_VISUAL_QA_STAGE).length - 1]
            : { storyboard: (task.input as { repair?: unknown }).repair ? restyled : storyboard };
        return { output, turns: 1, costCents: 3, inputTokens: 4000, outputTokens: 600, model: "mock-model" };
      },
    };
    return { runtime, tasks };
  };

  it("reviews a still per card, redesigns only the failed card and captures it again, then renders once", async () => {
    const { runtime, tasks } = reviewedAgent();
    const h = harness({ agent: runtime, realVideo: true });
    const projectId = await newProject(h, "motion-graphic", graphic);
    const { outcome } = await h.run({ workflowTemplate: "motion-graphic" }, projectId);
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });

    // The reviewer sees one contact sheet image and what each card meant to show.
    const critiques = tasks.filter((t) => t.skill === MG_VISUAL_QA_STAGE);
    expect(critiques).toHaveLength(2);
    expect(critiques[0]?.images).toEqual([{ mimeType: "image/jpeg", data: expect.any(String) }]);
    expect((critiques[0] as AgentTask).input.cards).toHaveLength(3);
    const repair = tasks.find((t) => (t.input as { repair?: unknown }).repair)?.input as {
      repair: { cards: number[]; problem: string };
    };
    expect(repair.repair.cards).toEqual([2]);
    expect(repair.repair.problem).toMatch(/card 2.*too-small/);

    // Only card 2 changed: a layout device, its voice line and every card's length kept.
    // The review captures stills (one window per card), never a full render; the film renders once, after it.
    expect(h.renderer.stilled).toHaveLength(2);
    const [before, after] = h.renderer.stilled.map((c) => c.ir) as [VideoIR, VideoIR];
    expect(h.renderer.stilled[0]?.windows).toEqual(stillWindowsMs(before));
    expect(h.renderer.rendered).toEqual([after]);
    expect(after.scenes.map((sc) => sc.durationMs)).toEqual(before.scenes.map((sc) => sc.durationMs));
    expect(after.scenes[0]).toEqual(before.scenes[0]);
    expect(after.scenes[2]).toEqual(before.scenes[2]);
    expect(after.scenes[1]?.shots.find((sh) => sh.type === "layout")).toMatchObject({
      layout: { kind: "stat" },
    });
    expect(after.audio).toEqual(before.audio);
    expect(after.captions).toEqual(before.captions);
    expect(h.generate.mock.calls.filter(([, r]) => r.kind === "voice")).toHaveLength(3);

    // The stored version is the IR that was rendered last, and the scores are in the job result.
    const project = await h.projects.get(ctx, projectId);
    const version = await h.projects.getVersion(ctx, project?.currentVersionId as string);
    expect(version?.ir).toEqual(after);
    const result = h.queue.complete.mock.calls.at(-1)?.[2] as { visualQa: Record<string, unknown> };
    expect(result.visualQa).toMatchObject({
      status: "fixed",
      rounds: [{ round: 0, repaired: [2] }, { round: 1 }],
    });
    expect(h.usage.filter((u) => u.kind === "render.seconds")).toHaveLength(1);
  });

  it("skips the review when the deadline leaves only time for the final render, and still renders", async () => {
    const { runtime, tasks } = reviewedAgent();
    const h = harness({ agent: runtime, realVideo: true });
    const projectId = await newProject(h, "motion-graphic", graphic);
    // Enough for the final render of a 10 s film, not for a capture and a critique on top of it.
    const deadlineAt = new Date(Date.now() + 120_000);
    const { outcome } = await h.run({ workflowTemplate: "motion-graphic" }, projectId, { deadlineAt });
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    const ir = h.renderer.rendered[0] as VideoIR;
    expect(finalRenderMsEstimate(ir)).toBeLessThan(120_000);
    expect(tasks.filter((t) => t.skill === MG_VISUAL_QA_STAGE)).toHaveLength(0);
    expect(h.renderer.stilled).toHaveLength(0);
    expect(h.renderer.rendered).toHaveLength(1);
    const result = h.queue.complete.mock.calls.at(-1)?.[2] as { visualQa: Record<string, unknown> };
    expect(result.visualQa).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/final render/),
    });
  });

  it("keeps the reviewed IR when the second capture fails, and still ships the job", async () => {
    const h = harness({ agent: reviewedAgent().runtime, realVideo: true, failStills: 2 });
    const projectId = await newProject(h, "motion-graphic", graphic);
    const { outcome } = await h.run({ workflowTemplate: "motion-graphic" }, projectId);
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    // The version and the one render hold the IR that was reviewed, not the redesign that was never seen.
    expect(h.renderer.stilled).toHaveLength(2);
    expect(h.renderer.rendered).toEqual([h.renderer.stilled[0]?.ir]);
    const project = await h.projects.get(ctx, projectId);
    const version = await h.projects.getVersion(ctx, project?.currentVersionId as string);
    expect(version?.ir).toEqual(h.renderer.stilled[0]?.ir);
    const result = h.queue.complete.mock.calls.at(-1)?.[2] as { visualQa: Record<string, unknown> };
    expect(result.visualQa).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/capture failed/),
    });
  });

  it("cuts on the music's beats and reveals each card on its spoken words", async () => {
    // A 120 BPM click bed (a beat every 500 ms, an accented downbeat every 2 s) as the music the provider made,
    // and every take reported with word timings, as ElevenLabs speech with timestamps reports them.
    const rate = 11_025;
    const clicks = new Float32Array(rate * 10);
    for (let beat = 0; beat * 500 < 10_000; beat++) {
      const at = Math.round((beat * 500 * rate) / 1000);
      const level = beat % 4 === 0 ? 0.9 : 0.4;
      for (let i = 0; i < 300 && at + i < clicks.length; i++)
        clicks[at + i] = level * Math.sin(i / 2) * (1 - i / 300);
    }
    const wav = Buffer.alloc(44 + clicks.length * 2);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + clicks.length * 2, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24);
    wav.writeUInt32LE(rate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(clicks.length * 2, 40);
    clicks.forEach((v, i) => {
      wav.writeInt16LE(Math.round(v * 32_767), 44 + i * 2);
    });
    const agent = mockAgent({ storyboard });
    const h = harness({
      agent: agent.runtime,
      outputs: async (request, made) => {
        const [output] = made.outputs;
        if (!output) return made;
        if (request.kind === "music") {
          await writeFile(output.filePath, wav);
          return { ...made, outputs: [{ ...output, durationMs: 10_000 }] };
        }
        if (request.kind !== "voice") return made;
        const words = request.prompt
          .split(/\s+/)
          .map((text, i) => ({ text, startMs: 80 + i * 180, endMs: 220 + i * 180 }));
        return { ...made, outputs: [{ ...output, words }] };
      },
    });
    const { outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", graphic),
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    const ir = h.renderer.rendered[0] as VideoIR;
    const beats = ir.metadata?.beats as { bpm: number; downbeatsMs: number[]; beatsMs: number[] };
    expect(beats.bpm).toBeCloseTo(120, 0);
    expect(ir.metadata).toMatchObject({ wordSync: "alignment", beatSync: { cuts: 2 } });
    // Every cut the voice left room to move sits on a beat of the bed.
    const cuts = [
      ir.scenes[0]?.durationMs ?? 0,
      (ir.scenes[0]?.durationMs ?? 0) + (ir.scenes[1]?.durationMs ?? 0),
    ];
    const onBeat = cuts.filter((cut) => beats.beatsMs.some((b) => Math.abs(b - cut) <= 1));
    expect(onBeat.length).toBe((ir.metadata?.beatSync as { onBeat?: number } | undefined)?.onBeat);
    expect(onBeat.length).toBeGreaterThan(0);
    expect(ir.scenes.reduce((n, sc) => n + sc.durationMs, 0)).toBe(10_000);
    // The message card's headline enters as its first shared word is heard, not on the cut.
    const message = ir.scenes[1];
    const headline = message?.shots.find((sh) => sh.type === "text");
    expect(headline?.startMs).toBeGreaterThan(0);
    // The voice still fits every card after the cuts moved.
    const voice = (ir.audio ?? []).filter((t) => t.kind === "voiceover");
    expect(voice).toHaveLength(3);
  });

  it("adds no music when the storyboard asks for none", async () => {
    const h = harness({ agent: mockAgent({ storyboard: { ...storyboard, music: null } }).runtime });
    await h.run({ workflowTemplate: "motion-graphic" }, await newProject(h, "motion-graphic", graphic));
    expect(h.generate.mock.calls.map(([, r]) => r.kind)).not.toContain("music");
  });

  it("skips the music bed with a warning when the media provider cannot make one", async () => {
    const h = harness({ agent: mockAgent({ storyboard }).runtime, unavailableKinds: ["music"] });
    const { job, outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", graphic),
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    const ir = h.renderer.rendered[0] as VideoIR;
    expect(ir.audio?.map((t) => t.kind)).not.toContain("music");
    const stages = await h.jobs.listStages(ctx, job.id);
    const music = stages.find((st) => st.name === MG_STAGES.music);
    expect(music?.output?.warning).toMatch(/Music bed skipped: .*ELEVENLABS_API_KEY/);
  });

  it("scales the beat count with the length: about one card every five seconds, 3 to 12", () => {
    expect(motionBeatRange(6_000)).toEqual({ target: 3, min: 3, max: 6 });
    expect(motionBeatRange(15_000)).toEqual({ target: 3, min: 3, max: 6 });
    expect(motionBeatRange(30_000)).toEqual({ target: 6, min: 5, max: 9 });
    expect(motionBeatRange(60_000)).toEqual({ target: 12, min: 9, max: 12 });
  });

  it("asks again for a long video held on too few cards, then whooshes every cut with one SFX", async () => {
    const long = {
      ...graphic,
      prompt: "Motion graphic 60 giây giới thiệu tiệm trà Lá Mây",
      durationMs: 60_000,
    };
    const beats = Array.from({ length: 12 }, (_, i) => ({
      onScreen: `Thẻ ${i + 1}`,
      voiceover: `Lá Mây kể câu chuyện số ${i + 1}.`,
      visual: "Chữ lớn trên nền nhấn màu",
      layout: { kind: "chips", hub: "Lá Mây", items: ["Hái tay", "Mỗi sớm"] },
      enter: "pop",
      weight: 1,
    }));
    // No music: the fake provider makes audio of at most 30 s.
    const agent = sequenceAgent([
      { storyboard: { ...storyboard, music: null } },
      { storyboard: { ...storyboard, music: null, beats } },
    ]);
    const h = harness({ agent: agent.runtime });
    const { outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", long),
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect(agent.tasks).toHaveLength(2);
    const [first, second] = agent.tasks as [AgentTask, AgentTask];
    expect((first.input as { beats: unknown }).beats).toEqual({ target: 12, min: 9, max: 12 });
    const repair = (second.input as { repair?: { problem: string } }).repair;
    expect(repair?.problem).toMatch(/has 3 beats; a 60s graphic needs 9 to 12/);
    const ir = h.renderer.rendered[0] as VideoIR;
    expect(ir.metadata?.storyboard).toBe("agent");
    expect(ir.scenes).toHaveLength(12);
    // Twelve lines, voiced a few at a time: never more than a provider's concurrent cap (ElevenLabs allows 5).
    expect(h.generate.mock.calls.filter(([, r]) => r.kind === "voice")).toHaveLength(12);
    expect(h.voices.peak).toBeGreaterThan(1);
    expect(h.voices.peak).toBeLessThanOrEqual(3);
    // Eleven cuts: ten whooshes from one generated SFX, and the accent on the cut into the CTA card.
    expect(h.generate.mock.calls.filter(([, r]) => r.kind === "sfx")).toHaveLength(2);
    expect((ir.audio ?? []).filter((t) => t.assetId === "sfx-whoosh")).toHaveLength(10);
    expect((ir.audio ?? []).filter((t) => t.assetId === "sfx-accent")).toHaveLength(1);
  });

  it("keeps a fitting storyboard whose beat count is still off after the repair turn", async () => {
    const long = { ...graphic, durationMs: 60_000 };
    const beats = Array.from({ length: 8 }, (_, i) => ({
      ...structuredClone(storyboard.beats[1]),
      onScreen: `Thẻ ${i + 1}`,
    }));
    const agent = sequenceAgent([{ storyboard: { ...storyboard, music: null, beats } }]);
    const h = harness({ agent: agent.runtime });
    const { outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", long),
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect(agent.tasks).toHaveLength(2);
    const ir = h.renderer.rendered[0] as VideoIR;
    expect(ir.metadata?.storyboard).toBe("agent");
    expect(ir.scenes).toHaveLength(8);
  });

  const brisker = (instructions?: string) => String(instructions).includes("brisker");

  it("voices again only the line that does not fit even read faster, then lays the takes on the graphic", async () => {
    const message = storyboard.beats[1]?.voiceover as string;
    // The other lines fit their cards only sped up; the message line fits only its brisker re-take, and the
    // speech as first voiced outruns the graphic, so recutting cannot help.
    const h = harness({
      agent: mockAgent({ storyboard }).runtime,
      voiceMs: (text, instructions) => (text !== message ? 3100 : brisker(instructions) ? 3400 : 4500),
    });
    const { outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", graphic),
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    // The lines that fit sped up are not paid for again: three first takes and one brisker re-take.
    const voices = h.generate.mock.calls.filter(([, r]) => r.kind === "voice").map(([, r]) => r);
    expect(voices).toHaveLength(4);
    expect(
      voices.filter((r) => brisker(r.params?.instructions as string | undefined)).map((r) => r.prompt),
    ).toEqual([message]);
    const ir = h.renderer.rendered[0] as VideoIR;
    const cards = ir.scenes.map((sc) => sc.durationMs);
    expect(cards.reduce((a, b) => a + b, 0)).toBe(10_000);
    // Every card holds its take, sped up at most the allowed rate.
    const voice = (ir.audio ?? []).filter((t) => t.kind === "voiceover");
    expect(voice.every((t) => (t.playbackRate ?? 1) <= 1.12)).toBe(true);
    let at = 0;
    voice.forEach((t, i) => {
      at += i === 0 ? 0 : (cards[i - 1] as number);
      expect(t.startMs + (t.durationMs ?? 0)).toBeLessThanOrEqual(at + (cards[i] as number));
    });
  });

  it("voices the lines that fit only sped up once more too, when the graphic still needs the time", async () => {
    const message = storyboard.beats[1]?.voiceover as string;
    // The message line never fits its card; the others fit theirs only sped up, so they are voiced again,
    // brisker, only after the message line's re-take still leaves the graphic short of time.
    const h = harness({
      agent: mockAgent({ storyboard }).runtime,
      voiceMs: (text, instructions) =>
        text === message ? (brisker(instructions) ? 4300 : 4500) : brisker(instructions) ? 2400 : 3200,
    });
    const { outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", graphic),
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    const voices = h.generate.mock.calls.filter(([, r]) => r.kind === "voice").map(([, r]) => r);
    // Three first takes, the message line's re-take, then one re-take each of the other two; none twice.
    expect(voices).toHaveLength(6);
    const retaken = voices
      .filter((r) => brisker(r.params?.instructions as string | undefined))
      .map((r) => r.prompt);
    expect(retaken[0]).toBe(message);
    expect(new Set(retaken).size).toBe(3);
    // The message card took the time its long take needs from the cards whose lines were re-read shorter.
    const cards = (h.renderer.rendered[0] as VideoIR).scenes.map((sc) => sc.durationMs);
    expect(cards[1]).toBeGreaterThan(Math.max(cards[0] as number, cards[2] as number));
  });

  it("falls back to the template, both runs billed, when the voice-over still overruns the length after the repair turn", async () => {
    const long = "một hai ba bốn năm sáu bảy tám chín mười ".repeat(4).trim();
    const beats = storyboard.beats.map((b) => ({ ...b, voiceover: long }));
    const h = harness({ agent: mockAgent({ storyboard: { ...storyboard, beats } }).runtime });
    const { outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", graphic),
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect(h.renderer.rendered[0]?.metadata?.storyboard).toBe("template");
    expect(h.usage.filter((u) => u.kind === "agent.run")).toHaveLength(2);
  });

  /** An agent that answers each run with the next scripted output, and records its tasks. */
  const sequenceAgent = (outputs: unknown[]) => {
    const tasks: AgentTask[] = [];
    const runtime: AgentRuntime = {
      id: "mock",
      run: async (_ctx, task) => {
        const output = outputs[Math.min(tasks.length, outputs.length - 1)];
        tasks.push(task);
        return { output, turns: 1, costCents: 3, inputTokens: 4000, outputTokens: 600, model: "mock-model" };
      },
    };
    return { runtime, tasks };
  };
  /** 10 + 10 + 8 words: inside the 28-word budget, yet the cards need 10.1 s once rounded up and padded. */
  const words = (n: number) => Array.from({ length: n }, (_, i) => `từ${i + 1}`).join(" ");
  const tight = {
    ...storyboard,
    beats: storyboard.beats.map((b, i) => ({ ...b, voiceover: words([10, 10, 8][i] as number), weight: 1 })),
  };

  it("gives the agent one repair turn for a storyboard that does not fit, and bills both runs", async () => {
    const agent = sequenceAgent([{ storyboard: tight }, { storyboard }]);
    const h = harness({ agent: agent.runtime });
    const { outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", graphic),
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect(agent.tasks).toHaveLength(2);
    const first = agent.tasks[0]?.input as Record<string, unknown>;
    const second = agent.tasks[1]?.input as { repair?: { problem: string; storyboard: unknown } };
    expect(first.repair).toBeUndefined();
    expect(second.repair?.storyboard).toEqual(tight);
    expect(second.repair?.problem).toMatch(/does not fit its beat|longer than/);
    expect(agent.tasks[1]?.maxCostCents).toBe(MG_STORYBOARD_LIMITS.maxCostCents);
    expect(h.renderer.rendered[0]?.metadata?.storyboard).toBe("agent");
    expect(h.usage.filter((u) => u.kind === "agent.run").map((u) => u.costCents)).toEqual([3, 3]);
  });

  it("falls back, billing both runs, when the repair turn itself fails", async () => {
    let runs = 0;
    const runtime: AgentRuntime = {
      id: "mock",
      run: async () => {
        runs += 1;
        if (runs === 2) throw new StudixError("INTERNAL", "agent crashed", { retryable: false });
        return {
          output: { storyboard: tight },
          turns: 1,
          costCents: 3,
          inputTokens: 4000,
          outputTokens: 600,
          model: "mock-model",
        };
      },
    };
    const h = harness({ agent: runtime });
    const { outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", graphic),
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect(h.renderer.rendered[0]?.metadata?.storyboard).toBe("template");
    expect(h.usage.filter((u) => u.kind === "agent.run").map((u) => u.costCents)).toEqual([3]);
  });

  it("falls back to the template after a repair that still does not fit, billing both runs", async () => {
    const agent = sequenceAgent([{ storyboard: tight }]);
    const h = harness({ agent: agent.runtime });
    const { job, outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", graphic),
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect(agent.tasks).toHaveLength(2);
    expect(h.renderer.rendered[0]?.metadata?.storyboard).toBe("template");
    expect(h.usage.filter((u) => u.kind === "agent.run").map((u) => u.costCents)).toEqual([3, 3]);
    const stages = await h.jobs.listStages(ctx, job.id);
    const out = stages.find((st) => st.name === MG_STAGES.storyboard)?.output;
    expect(out?.fallbackReason).toMatch(/still does not fit after one repair turn/);
  });

  it("falls back to the template when the agent's cards cannot each hold their line", async () => {
    // 10 + 10 + 8 words: 28, inside the 28 a 10 s graphic holds, but rounded up to the 100 ms the cards are
    // cut in, with the lead-in and closing pads, they need 3700 + 3400 + 3000 ms, more than the 10 s.
    const words = (n: number) => Array.from({ length: n }, () => "bốn").join(" ");
    const beats = storyboard.beats.map((b, i) => ({ ...b, voiceover: words([10, 10, 8][i] ?? 8) }));
    const h = harness({ agent: mockAgent({ storyboard: { ...storyboard, beats } }).runtime });
    const { job, outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", graphic),
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect(h.renderer.rendered[0]?.metadata?.storyboard).toBe("template");
    const stages = await h.jobs.listStages(ctx, job.id);
    const board = stages.find((st) => st.name === MG_STAGES.storyboard);
    expect(board?.output?.fallbackReason).toMatch(/does not fit/);
  });

  it("falls back to the template when the workspace has no agent model", async () => {
    const runtime: AgentRuntime = {
      id: "none",
      run: async () => {
        throw new StudixError("UNAVAILABLE", "No model is configured for agent stage", { retryable: false });
      },
    };
    const h = harness({ agent: runtime });
    const { outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", graphic),
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    const ir = h.renderer.rendered[0] as VideoIR;
    expect(ir.metadata?.storyboard).toBe("template");
    expect(h.generate.mock.calls.map(([, r]) => r.kind)).not.toContain("music");
    expect(h.usage.filter((u) => u.kind === "agent.run")).toHaveLength(0);
  });

  it.each([
    ["agent", { agent: { runtime: "pi", connectionId: "conn_1", provider: "openai" } }],
    ["legacy agentModel", { agentModel: { connectionId: "conn_1", provider: "openai", modelId: "gpt-5" } }],
  ])("fails instead of falling back when the job named an agent (%s) that cannot run", async (_, chosen) => {
    const runtime: AgentRuntime = {
      id: "none",
      run: async () => {
        throw new StudixError("UNAVAILABLE", "No model is configured for agent stage", { retryable: false });
      },
    };
    const h = harness({ agent: runtime });
    const { outcome } = await h.run(
      { workflowTemplate: "motion-graphic", ...chosen },
      await newProject(h, "motion-graphic", graphic),
    );
    expect(h.failureOf(outcome)).toEqual({
      outcome: "failed",
      failure: expect.objectContaining({ code: "UNAVAILABLE" }),
    });
    expect(h.renderer.rendered).toHaveLength(0);
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("fails the job on an agent output that breaks the schema instead of silently using the template", async () => {
    const h = harness({
      agent: mockAgent({ storyboard: { ...storyboard, styleProfile: "made-up" } }).runtime,
    });
    const { outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", graphic),
    );
    expect(outcome).toBe("failed");
    expect(h.generate).not.toHaveBeenCalled();
  });
});

describe("pack pipeline routing", () => {
  it("fails the job up front for an unknown workflow template", async () => {
    const h = harness();
    const projectId = await newProject(h, "brand-intro");
    const { outcome } = await h.run({ workflowTemplate: "no-such-pack" }, projectId);
    expect(outcome).toBe("failed");
    expect(MV_STAGES.script).toBe("marketing-video.script");
  });
});

describe("motion-graphic launch film with layouts (mock agent)", () => {
  const beats = [
    { onScreen: "Studix is open source", voiceover: "Studix is open source today." },
    {
      onScreen: "Every model, wired in",
      voiceover: "It wires in every model you already use.",
      layout: { kind: "chips", hub: "Studix", items: ["Claude", "Veo", "Kling", "ElevenLabs"] },
    },
    {
      onScreen: "5,000 free credits",
      voiceover: "One credit is one US cent.",
      layout: { kind: "counter", from: 0, to: 5000, label: "free credits" },
    },
    {
      onScreen: "MIT licensed",
      voiceover: "And the code is MIT licensed.",
      layout: { kind: "stat", value: "MIT", label: "Open source, forever" },
    },
    { onScreen: "Try Studix now", voiceover: "Try Studix now." },
  ];
  const storyboard = {
    styleProfile: "swiss-kinetic-editorial",
    beats: beats.map((b) => ({ ...b, visual: "Layout device under the headline", enter: "pop", weight: 1 })),
    music: null,
    brandName: "Studix",
    rationale: "A launch film shows each claim as a device.",
  };

  it("keeps every card's captions and voice on that card after recutting around a long take", async () => {
    const runtime: AgentRuntime = {
      id: "mock",
      run: async () => ({
        output: { storyboard },
        turns: 1,
        costCents: 3,
        inputTokens: 1,
        outputTokens: 1,
        model: "m",
      }),
    };
    // The credits line runs long, so the cards are recut around it.
    const h = harness({ agent: runtime, voiceMs: (text) => (text === beats[2]?.voiceover ? 6_000 : 1_800) });
    const projectId = await newProject(h, "motion-graphic", {
      prompt: "Launch film for Studix",
      title: "Studix",
      language: "en",
      aspectRatio: "16:9",
      durationMs: 20_000,
    });
    const { outcome } = await h.run({ workflowTemplate: "motion-graphic" }, projectId);
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    const ir = h.renderer.rendered[0] as VideoIR;
    expect(ir.scenes.find((sc) => sc.id === "message-2")?.durationMs).toBeGreaterThan(5_000);
    let at = 0;
    const cards = ir.scenes.map((sc) => {
      const span = { startMs: at, endMs: at + sc.durationMs };
      at = span.endMs;
      return span;
    });
    const voice = (ir.audio ?? []).filter((t) => t.kind === "voiceover");
    expect(voice).toHaveLength(beats.length);
    cards.forEach((card, i) => {
      const said = (ir.captions?.cues ?? [])
        .filter((c) => c.startMs >= card.startMs && c.endMs <= card.endMs)
        .map((c) => c.text)
        .join(" ");
      expect(said).toBe(beats[i]?.voiceover);
      const track = voice[i];
      expect(track?.startMs).toBeGreaterThanOrEqual(card.startMs);
      expect((track?.startMs ?? 0) + (track?.durationMs ?? 0)).toBeLessThanOrEqual(card.endMs);
    });
  });
});
