import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type {
  AgentRuntime,
  AgentTask,
  Job,
  RendererAdapter,
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
import { MG_STAGES, MG_STORYBOARD_LIMITS, MV_STAGES, packPipelines, packRegistry } from "../src/index.ts";

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

function fakeRenderer(): RendererAdapter & { rendered: VideoIR[] } {
  const rendered: VideoIR[] = [];
  return {
    id: "hyperframes",
    rendered,
    supports: () => ({ supported: true, reasons: [] }),
    async render(ir, opts) {
      rendered.push(ir);
      for (const asset of ir.assets) expect(opts.assetFiles[asset.id]).toBeDefined();
      const filePath = join(opts.workDir, "out.mp4");
      await writeFile(filePath, `mp4:${ir.title}`);
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
  } = {},
) {
  const { jobs } = createInMemoryJobStore(clock);
  const projects = createInMemoryProjectRepository(clock);
  const renders = createInMemoryRenderRepository(clock);
  const storage = memoryStorage();
  const renderer = fakeRenderer();
  const media = new FakeMediaProvider({ pricing: { estimateCents: (r) => (r.kind === "image" ? 2 : 5) } });
  const real = media.generate.bind(media);
  media.generate = async (c, request) => {
    if (options.unavailableKinds?.includes(request.kind)) {
      throw new StudixError("UNAVAILABLE", "multix is missing a key or setting: ELEVENLABS_API_KEY", {
        retryable: false,
      });
    }
    // The real provider reads local inputs only from inside the request's workDir; the fake does not check.
    for (const name of ["image", "video", "audio"]) {
      const value = request.params?.[name];
      if (typeof value !== "string" || value.startsWith("https://")) continue;
      const rel = relative(request.workDir ?? "", value);
      if (!request.workDir || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new StudixError("VALIDATION", `params.${name} must be inside workDir`, { retryable: false });
      }
    }
    return real(c, request);
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
  async function run(payload: Record<string, unknown>, projectId: string) {
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
    } as unknown as Job;
    const outcome = await executor.execute(job, "worker-1", new AbortController().signal);
    return { job, outcome };
  }
  /** The outcome with the job's failure, so a failed expectation says why the job failed. */
  const failureOf = (outcome: unknown) => ({ outcome, failure: queue.fail.mock.calls.at(-1)?.[2] });
  return { run, failureOf, jobs, projects, renders, storage, renderer, generate, usage, qaCalls, queue };
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
    // Hook, two messages and the call to action: one line per card.
    expect(h.generate.mock.calls.map(([, r]) => r.kind).sort()).toEqual([
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
    expect(h.usage.filter((u) => u.kind === "media.generation")).toHaveLength(5);
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
    ]);
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
    expect(ir.scenes.map((sc) => sc.shots[0]?.animation?.enter)).toEqual(["slide-left", "pop", "scale"]);
    expect(ir.scenes.map((sc) => sc.durationMs)).toEqual([3300, 3600, 3100]);
    expect(ir.format).toMatchObject({ aspectRatio: "16:9", durationMs: 10_000 });
    expect(h.generate.mock.calls.map(([, r]) => r.kind).sort()).toEqual([
      "music",
      "sfx",
      "voice",
      "voice",
      "voice",
    ]);
    expect(ir.audio?.find((t) => t.kind === "music")).toMatchObject({ startMs: 0, volume: 0.18 });
    expect(h.usage.filter((u) => u.kind === "agent.run").map((u) => u.costCents)).toEqual([3]);
  });

  it("adds no music when the storyboard asks for none", async () => {
    const h = harness({ agent: mockAgent({ storyboard: { ...storyboard, music: null } }).runtime });
    await h.run({ workflowTemplate: "motion-graphic" }, await newProject(h, "motion-graphic", graphic));
    expect(h.generate.mock.calls.map(([, r]) => r.kind)).not.toContain("music");
  });

  it("falls back to the template, billed, when the agent's voice-over overruns the length", async () => {
    const long = "một hai ba bốn năm sáu bảy tám chín mười ".repeat(4).trim();
    const beats = storyboard.beats.map((b) => ({ ...b, voiceover: long }));
    const h = harness({ agent: mockAgent({ storyboard: { ...storyboard, beats } }).runtime });
    const { outcome } = await h.run(
      { workflowTemplate: "motion-graphic" },
      await newProject(h, "motion-graphic", graphic),
    );
    expect(h.failureOf(outcome)).toEqual({ outcome: "succeeded", failure: undefined });
    expect(h.renderer.rendered[0]?.metadata?.storyboard).toBe("template");
    expect(h.usage.filter((u) => u.kind === "agent.run")).toHaveLength(1);
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
