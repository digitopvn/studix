import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import {
  type ClaudeAgentEvent,
  type ClaudeSessionRequest,
  createClaudeAgentRuntime,
  createFakeClaudeTransport,
} from "@studix/agent-runtime";
import { createJobBudgetPolicy, createUsageLedger, USAGE_KINDS } from "@studix/billing";
import {
  createDefaultApprovalPolicy,
  type MediaGenerationRequest,
  type RendererAdapter,
  type StorageAdapter,
  storyboardFromVideoIR,
  storyboardStatus,
  type TenantContext,
} from "@studix/core";
import { withTestDatabase } from "@studix/database/testing";
import { FakeMediaProvider } from "@studix/providers";
import { FILM_SCENE_MIME, parseFilmScenePackage } from "@studix/renderers";
import { createLogger, StudixError } from "@studix/shared";
import { filmOf, filmStageNames, packPipelines, packRegistry } from "@studix/skills";
import type { VideoIR } from "@studix/video-ir";
import {
  createJobExecutor,
  createVideoCreateWorkflow,
  createWorkerJobQueue,
  type QaExpectation,
  type QaGate,
  type SpeechProbe,
} from "@studix/workflow";
import { describe, expect, it } from "vitest";

/**
 * Both narrative packs end to end on the Postgres queue with fake providers: the scope and storyboard agents
 * (a fake Claude transport), G0 and G1 signed by a test reviewer on the approval mechanism, fake media, and
 * then, on an approved storyboard, dialogue, motion, lip-sync, score, continuity, render, QA and upload.
 */
const db = withTestDatabase();
const logger = createLogger({}, { level: "error", write: () => {} });
const actor = { type: "user", id: "usr_1" } as const;
const reviewer = { type: "user" as const, id: "usr_reviewer" };

const scope = JSON.parse(
  readFileSync(
    new URL("../../../packages/skills/test/fixtures/anime-scope-vi.json", import.meta.url),
    "utf8",
  ),
);
const fixtureScenes: { setId: string; shots: { id: string; characters: string[] }[] }[] = scope.scenes;
const shotIds: string[] = fixtureScenes.flatMap((s) => s.shots.map((x) => x.id));
/** The design a shot's keyframe is an edit of: its lead character's sheet, else its set's frame. */
function keyframeReference(shotId: string): string {
  const scene = fixtureScenes.find((s) => s.shots.some((x) => x.id === shotId));
  const lead = scene?.shots.find((x) => x.id === shotId)?.characters[0];
  return lead ? `${lead}-sheet-v1` : `${scene?.setId}-set-v1`;
}

/** The scope agent answers with the fixture, the storyboard agent with one panel per shot. */
function agentTranscript(request: ClaudeSessionRequest): ClaudeAgentEvent[] {
  const usage: ClaudeAgentEvent = {
    type: "usage",
    turns: 1,
    inputTokens: 400,
    outputTokens: 900,
    costUsd: 0.02,
  };
  if ("brief" in request.input) return [usage, { type: "result", output: { scope } }];
  const boards = shotIds.map((shotId, i) => ({
    shotId,
    frame: `Panel ${i + 1}: staging as the continuity state says`,
    motion: `Panel ${i + 1} motion`,
    ...(i === 0 ? { focus: [0.4, 0.5] } : {}),
  }));
  return [usage, { type: "result", output: { boards } }];
}

function memoryStorage(refuse?: (key: string) => boolean): StorageAdapter {
  const objects = new Map<string, Buffer>();
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  return {
    async put(_ctx, key, body, opts) {
      if (!("filePath" in body)) throw new Error("memory storage takes files only");
      if (refuse?.(key)) throw new StudixError("UNAVAILABLE", `storage refused ${key}`, { retryable: false });
      const bytes = await readFile(body.filePath);
      objects.set(key, bytes);
      return { key, bytes: bytes.length, sha256: sha(bytes), contentType: opts.contentType };
    },
    get: async () => {
      throw new Error("not used");
    },
    async download(_ctx, key, filePath) {
      const bytes = objects.get(key);
      if (!bytes) throw new StudixError("NOT_FOUND", `no object ${key}`);
      await writeFile(filePath, bytes);
      return { sha256: sha(bytes), bytes: bytes.length };
    },
    async head(_ctx, key) {
      const bytes = objects.get(key);
      return bytes ? { key, bytes: bytes.length, sha256: sha(bytes), contentType: "" } : undefined;
    },
    signedUrl: async (_ctx, key) => `https://storage.test/${key}`,
    delete: async () => {},
  };
}

/** `setFrame` gives set designs that size instead of the film's frame. */
function createWorld(
  opts: {
    setFrame?: { width: number; height: number };
    /** Wires a speech probe: `voiced(prompt, take)` says whether take `take` (1 for the first) of that effect has a voice. */
    voiced?: (prompt: string, take: number) => boolean;
    /** Requests the provider refuses with a plain, uncharged error. */
    refuse?: (request: MediaGenerationRequest) => boolean;
    /** Estimates of the models a request can name, in cents; other requests cost the fake's price. */
    modelCents?: Record<string, number>;
    /** Object keys the storage refuses to write. */
    refusePut?: (key: string) => boolean;
  } = {},
) {
  const { repos } = db.current;
  const queue = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
  const workRoot = mkdtempSync(join(tmpdir(), "studix-film-packs-"));
  const storage = memoryStorage(opts.refusePut);
  const rendered: VideoIR[] = [];
  const renderer: RendererAdapter = {
    id: "hyperframes",
    supports: () => ({ supported: true, reasons: [] }),
    async render(ir, opts) {
      rendered.push(ir);
      for (const asset of ir.assets) expect(opts.assetFiles[asset.id], asset.id).toBeDefined();
      // Every film-engine shot is a valid, pinned film scene over a downloaded keyframe.
      for (const asset of ir.assets.filter((a) => a.mime === FILM_SCENE_MIME)) {
        expect(asset.assetVersionId).toMatch(/^asv_/);
        parseFilmScenePackage(await readFile(opts.assetFiles[asset.id]!, "utf8"), asset.id);
      }
      const filePath = join(opts.workDir, "film.mp4");
      await writeFile(filePath, `mp4:${ir.title}`);
      return {
        filePath,
        mime: "video/mp4",
        probe: {
          durationMs: ir.format.durationMs,
          width: 1920,
          height: 1080,
          fps: 24,
          videoCodec: "h264",
          bytes: 0,
        },
      };
    },
  };
  const media = new FakeMediaProvider({ pricing: { estimateCents: (r) => (r.kind === "image" ? 2 : 5) } });
  const requests: MediaGenerationRequest[] = [];
  const promptOfFile = new Map<string, string>();
  const heard: { prompt: string; speech: boolean }[] = [];
  const takes = new Map<string, number>();
  const speech: SpeechProbe | undefined = opts.voiced
    ? {
        async measure(filePath) {
          const prompt = promptOfFile.get(filePath) ?? "";
          const take = (takes.get(prompt) ?? 0) + 1;
          takes.set(prompt, take);
          const voiced = opts.voiced!(prompt, take);
          heard.push({ prompt, speech: voiced });
          return { speechMs: voiced ? 1_000 : 0, durationMs: 3_000, speech: voiced };
        },
      }
    : undefined;
  const generate = media.generate.bind(media);
  const estimate = media.estimateCostCents.bind(media);
  // The fake runs one model; a model a request names (a cast voice) is recorded, then run on the fake.
  const onFake = <R extends { model?: string }>({ model: _, ...rest }: R) => rest;
  media.estimateCostCents = async (request) =>
    (request.model ? opts.modelCents?.[request.model] : undefined) ?? estimate(onFake(request));
  media.generate = async (ctx, original) => {
    requests.push(original);
    if (opts.refuse?.(original)) {
      throw new StudixError("PROVIDER_ERROR", "the provider refused this request", { retryable: false });
    }
    const request = onFake(original);
    // The real provider reads local inputs only from inside the request's workDir; the fake does not check.
    for (const name of ["image", "video", "audio"]) {
      const value = request.params?.[name];
      if (typeof value !== "string" || value.startsWith("https://")) continue;
      const rel = relative(request.workDir, value);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new StudixError("VALIDATION", `params.${name} must be inside workDir`, { retryable: false });
      }
    }
    if (opts.setFrame && /-set-v[0-9]+$/.test(request.idempotencyKey)) {
      const { aspectRatio: _, ...params } = request.params ?? {};
      return generate(ctx, { ...request, params: { ...params, ...opts.setFrame } });
    }
    // The fake answers a request by its content; a real provider runs a new job for a repeated call, so a
    // regeneration (its idempotency key ends in `:r<n>`) is given a seed of its own.
    const again = /:r\d+$/.exec(request.idempotencyKey)?.[0];
    const result = await generate(
      ctx,
      again ? { ...request, params: { ...request.params, seed: again } } : request,
    );
    for (const out of result.outputs) promptOfFile.set(out.filePath, original.prompt);
    return result;
  };
  const qaCalls: QaExpectation[] = [];
  const qa: QaGate = {
    async assertPasses(_file, expectation) {
      qaCalls.push(expectation);
      return { pass: true };
    },
  };
  const transport = createFakeClaudeTransport(agentTranscript);
  const runtime = createClaudeAgentRuntime({
    transport,
    model: "claude-test",
    killAfterMs: 20,
    closeTimeoutMs: 100,
    credentials: { resolve: async () => "sk-ant-api03-film-test-key-000000000000" },
  });
  const executor = createJobExecutor({
    queue,
    jobs: repos.jobs,
    approvals: repos.approvals,
    approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: 1000 }),
    approvalTtlMs: 3_600_000,
    billing: createJobBudgetPolicy(),
    ledger: createUsageLedger(repos.usage),
    stageCache: repos.stageCache,
    storyboardStatus: (ctx, projectId) => storyboardStatus(repos, ctx, projectId),
    agents: { handoffs: repos.agentHandoffs, runtimeFor: () => runtime },
    clock: { now: () => new Date() },
    logger,
    heartbeatIntervalMs: 50,
    services: { media, storage, renderer, qa, workRoot, ...(speech ? { speech } : {}) },
    workflows: [
      createVideoCreateWorkflow({
        planner: async () => {
          throw new Error("narrative packs never call the default planner");
        },
        renderer,
        storage,
        projects: repos.projects,
        renders: repos.renders,
        workRoot,
        pipelines: packPipelines(packRegistry),
      }),
    ],
  });

  return {
    repos,
    queue,
    requests,
    heard,
    rendered,
    qaCalls,
    transport,
    async runOnce(jobId: string) {
      const job = await queue.claim("worker-film");
      expect(job?.id).toBe(jobId);
      return executor.execute(job!, "worker-film", new AbortController().signal);
    },
  };
}

async function newFilm(slug: string, pack: string) {
  const { repos } = db.current;
  const { organization, workspace } = await repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
  });
  const ctx: TenantContext = {
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor: { type: "user", id: "usr_1", role: "owner" },
  };
  const project = await repos.projects.create(ctx, {
    title: "Hẹn trên sân thượng",
    status: "draft",
    brief: {
      prompt: "Một cảnh anime 15 giây: hai người bạn hẹn nhau xem pháo hoa trên sân thượng, có thoại",
      language: "vi",
      aspectRatio: "16:9",
      durationMs: 15_000,
    },
    workflowTemplate: pack,
    createdBy: actor,
  });
  return { ctx, project };
}

async function enqueue(
  ctx: TenantContext,
  projectId: string,
  pack: string,
  extra: Record<string, unknown> = {},
) {
  const { job } = await db.current.repos.queue.enqueue(ctx, {
    kind: "video.create",
    projectId,
    payload: { projectId, renderPreset: "preview", workflowTemplate: pack, ...extra },
    createdBy: actor,
    budgetCents: 500,
    maxAttempts: 2,
  });
  return job;
}

async function signGate(
  world: ReturnType<typeof createWorld>,
  ctx: TenantContext,
  jobId: string,
  gate: string,
) {
  const approval = await world.repos.approvals.findLatest(
    ctx,
    { type: "job", id: jobId },
    "creative.gate",
    `gate:${gate}`,
  );
  expect(approval).toMatchObject({ status: "pending" });
  await world.repos.approvals.decide(ctx, approval!.id, {
    status: "approved",
    decidedBy: reviewer,
    decidedAt: new Date(),
  });
  expect(await world.queue.resumeDecidedApprovals()).toBeGreaterThanOrEqual(1);
  return approval!;
}

async function currentIr(ctx: TenantContext, projectId: string) {
  const project = await db.current.repos.projects.get(ctx, projectId);
  const version = await db.current.repos.projects.getVersion(ctx, project!.currentVersionId!);
  return { project: project!, version: version!, ir: version!.ir as VideoIR };
}

/** What a person does on the dashboard: approve the storyboard of the current version. */
async function approveStoryboard(ctx: TenantContext, projectId: string, revision = 1) {
  const { version, ir } = await currentIr(ctx, projectId);
  const storyboard = storyboardFromVideoIR(ir);
  await db.current.repos.storyboards.append(ctx, {
    projectId,
    revision,
    versionId: version.id,
    storyboard: { ...storyboard, approval: { status: "approved", reviewer: reviewer.id } },
    createdBy: reviewer,
  });
}

/** A new film taken through G0, G1 and the storyboard, then approved, with its render job queued. */
async function renderJobOnApprovedBoard(world: ReturnType<typeof createWorld>, slug: string, pack: string) {
  const { ctx, project } = await newFilm(slug, pack);
  const job = await enqueue(ctx, project.id, pack);
  expect(await world.runOnce(job.id)).toBe("waiting_approval");
  await signGate(world, ctx, job.id, "G0");
  expect(await world.runOnce(job.id)).toBe("waiting_approval");
  await signGate(world, ctx, job.id, "G1");
  expect(await world.runOnce(job.id)).toBe("succeeded");
  const board = await currentIr(ctx, project.id);
  await approveStoryboard(ctx, project.id);
  const render = await enqueue(ctx, project.id, pack, { versionId: board.version.id });
  return { ctx, project, board, render };
}

describe.each(["anime", "long-form-film"])("%s pack on the Postgres queue (fake providers)", (pack) => {
  const n = filmStageNames(pack);

  it("stops a stale job without a creative gate when the project has already moved on", async () => {
    const world = createWorld();
    const { ctx, project } = await newFilm(`film-closed-${pack}`, pack);
    await db.current.repos.projects.update(ctx, project.id, { status: "published" });
    const job = await enqueue(ctx, project.id, pack);

    expect(await world.runOnce(job.id)).toBe("failed");
    expect(await db.current.repos.jobs.get(ctx, job.id)).toMatchObject({
      status: "failed",
      error: { code: "CONFLICT" },
    });
    expect(
      await world.repos.approvals.findLatest(ctx, { type: "job", id: job.id }, "creative.gate", "gate:G0"),
    ).toBeUndefined();
    const after = await db.current.repos.projects.get(ctx, project.id);
    expect(after?.status).toBe("published");
    expect(after?.currentVersionId).toBe(project.currentVersionId);
  });

  it("bills the designs it paid for when publishing the G1 board fails afterwards", async () => {
    const world = createWorld();
    const { ctx, project } = await newFilm(`film-designs-fail-${pack}`, pack);
    const job = await enqueue(ctx, project.id, pack);
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    await signGate(world, ctx, job.id, "G0");
    // The project is finished while the designs are being drawn, so publishing their board is refused.
    await db.current.repos.projects.update(ctx, project.id, { status: "published" });

    expect(await world.runOnce(job.id)).toBe("failed");
    expect(await db.current.repos.jobs.get(ctx, job.id)).toMatchObject({
      status: "failed",
      error: { code: "CONFLICT" },
    });
    expect(world.requests).toHaveLength(3);
    const usage = (await world.repos.usage.list(ctx, { jobId: job.id, limit: 200 })).items;
    expect(usage.filter((u) => u.kind === USAGE_KINDS.mediaGeneration)).toHaveLength(3);
  });

  it("stops at G0 and G1 for a person, then storyboards on the approved sheets, then renders on an approved storyboard", async () => {
    const world = createWorld();
    const { ctx, project } = await newFilm(`film-${pack}`, pack);
    const job = await enqueue(ctx, project.id, pack);

    // G0: the scope agent wrote the bible and beat sheet; the board is the project's current version. No media.
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    expect(world.requests).toHaveLength(0);
    const g0 = await currentIr(ctx, project.id);
    expect(g0.project.status).toBe("in_review");
    expect(g0.ir.scenes[0]?.id).toBe("board-bible");
    expect(filmOf(g0.ir).pack).toBe(pack);
    expect(world.transport.requests[0]?.instructions).toContain("Characters, designs and names are original");
    const g0Approval = await signGate(world, ctx, job.id, "G0");
    expect(g0Approval.reason).toMatch(/^G0: Approve the/);

    // G1: one sheet per character and a frame per set, as candidates on the design board.
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    expect(world.requests.map((r) => r.kind)).toEqual(["image", "image", "image"]);
    const g1 = await currentIr(ctx, project.id);
    expect(g1.version.id).not.toBe(g0.version.id);
    expect(g1.ir.scenes[0]?.shots.map((s) => s.id)).toEqual([
      "design-mai",
      "design-tun",
      "design-san-thuong",
    ]);
    expect(filmOf(g1.ir).production.characters.flatMap((c) => c.references.map((r) => r.status))).toEqual([
      "candidate",
      "candidate",
    ]);
    await signGate(world, ctx, job.id, "G1");

    // Storyboard: the sheets turn canonical and condition every keyframe with a character in it.
    expect(await world.runOnce(job.id)).toBe("succeeded");
    // Keyframes are generated concurrently, so their start order is not part of the contract.
    const keyframes = world.requests
      .slice(3)
      .sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
    expect(keyframes.map((r) => r.idempotencyKey.split(":").at(-1))).toEqual(
      shotIds.map((id) => `${id}-key`),
    );
    // A shot with characters is an edit of its lead's sheet; an empty shot is an edit of its set's signed
    // frame (drawn from text alone, an empty set came back as a bordered layout plate).
    expect(keyframes.map((r) => basename(String(r.params?.image)).replace(/\.[a-z0-9]+$/, ""))).toEqual(
      shotIds.map(keyframeReference),
    );
    // A reference already in the film's frame sets the edit's frame: no aspect ratio next to it (grok-image
    // refuses one).
    expect(keyframes.map((r) => r.params?.aspectRatio ?? null)).toEqual(shotIds.map(() => null));
    const board = await currentIr(ctx, project.id);
    expect(board.project.status).toBe("in_review");
    expect(board.ir.scenes[0]?.shots.map((s) => [s.id, s.type])).toEqual(shotIds.map((id) => [id, "image"]));
    const film = filmOf(board.ir);
    expect(film.production.characters.flatMap((c) => c.references.map((r) => r.status))).toEqual([
      "canonical",
      "canonical",
    ]);
    expect(film.production.shots.find((s) => s.shotId === "s4")?.conditioningRefs).toEqual(["mai-sheet-v1"]);
    expect(film.boards).toHaveLength(5);
    const stages = (await world.repos.jobs.listStages(ctx, job.id)).map((s) => s.name);
    expect(stages).toEqual(
      expect.arrayContaining([n.scope, n.bible, n.g0, n.designs, n.g1, n.storyboard, n.keyframes]),
    );

    // Without the storyboard approval nothing paid runs.
    world.requests.length = 0;
    const early = await enqueue(ctx, project.id, pack, { versionId: board.version.id });
    expect(await world.runOnce(early.id)).toBe("failed");
    expect(await world.repos.jobs.get(ctx, early.id)).toMatchObject({ error: { code: "APPROVAL_REQUIRED" } });
    expect(world.requests).toHaveLength(0);

    // Approved: dialogue first, then motion, lip-sync on the master lines, score and SFX, render, QA, upload.
    await approveStoryboard(ctx, project.id);
    const render = await enqueue(ctx, project.id, pack, { versionId: board.version.id });
    expect(await world.runOnce(render.id)).toBe("succeeded");
    const kinds = world.requests.map((r) => r.kind);
    // Each character keeps the voice the bible cast for every line; each line carries its own direction.
    // Lines are recorded concurrently: order them by their line id.
    const lines = world.requests
      .filter((r) => r.kind === "voice")
      .sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
    expect(lines.map((r) => [r.prompt, r.model, r.params?.voice])).toEqual([
      ["Cậu lại đến muộn rồi.", "openrouter:google/gemini-3.8-flash-tts", "Leda"],
      ["Xin lỗi, tàu điện bị trễ.", "openrouter:google/gemini-3.8-flash-tts", "Puck"],
      ["Vừa kịp lúc.", "openrouter:google/gemini-3.8-flash-tts", "Leda"],
    ]);
    const directions = lines.map((r) => String(r.params?.instructions));
    expect(directions[0]).toContain("Character voice: giọng nữ trẻ, nhẹ, hơi trách yêu.");
    expect(directions[0]).toContain("Read this line: trách yêu.");
    expect(directions[1]).toMatch(/^Tùng speaks one line in a Vietnamese animated film/);
    expect(directions[1]).toContain("Read this line: hụt hơi.");
    expect(directions[2]).toContain("Read this line: thì thầm.");
    const videos = world.requests.filter((r) => r.kind === "video");
    const clips = videos.filter((r) => r.params?.audio === undefined);
    const syncs = videos.filter((r) => r.params?.audio !== undefined);
    expect(clips.map((r) => r.params?.resolution)).toEqual(["480p", "480p", "480p"]);
    expect(clips.every((r) => typeof r.params?.image === "string" && r.params.generateAudio === false)).toBe(
      true,
    );
    expect(syncs).toHaveLength(2);
    expect(
      syncs.every((r) => typeof r.params?.video === "string" && typeof r.params.audio === "string"),
    ).toBe(true);
    expect(kinds.indexOf("voice")).toBeLessThan(kinds.indexOf("video"));
    expect(kinds.filter((k) => k === "music")).toHaveLength(1);
    expect(kinds.filter((k) => k === "sfx")).toHaveLength(4);
    // Effects are asked for as sounds only, so nothing in the cue is read out.
    const effects = world.requests.filter((r) => r.kind === "sfx").map((r) => r.prompt);
    expect(effects.sort()).toEqual([
      "distant fireworks launching",
      "fireworks bursting overhead",
      "heavy panting after a run",
      "soft wind over a rooftop",
    ]);

    expect(world.rendered).toHaveLength(1);
    const cut = world.rendered[0]!;
    expect(cut.format).toMatchObject({ durationMs: 15_000, fps: 24 });
    expect(cut.scenes[0]?.shots.map((s) => [s.id, s.type])).toEqual([
      ["s1", "composition"],
      ["s2", "video"],
      ["s3", "video"],
      ["s4", "video"],
      ["s5", "composition"],
    ]);
    // Every shot fills the frame; without the full region the renderer draws it as an inset card.
    expect(cut.scenes.flatMap((sc) => sc.shots).every((s) => s.style?.region === "full")).toBe(true);
    const s2 = cut.scenes[0]?.shots[1];
    expect(s2?.type === "video" && s2.assetId).toBe("s2-sync");
    const buses = (cut.audio ?? []).map((t) => t.kind).sort();
    expect(buses).toEqual(["dialogue", "dialogue", "dialogue", "music", "sfx", "sfx", "sfx", "sfx"]);
    expect((cut.audio ?? []).every((t) => t.startMs + (t.durationMs ?? 0) <= 15_000)).toBe(true);
    // A lip-synced line starts with its shot; captions follow the recorded lines.
    expect(cut.audio?.find((t) => t.assetId === "s2-l1-vo")?.startMs).toBe(2_000);
    expect(cut.captions?.cues.map((c) => c.text)).toEqual([
      "Cậu lại đến muộn rồi.",
      "Xin lỗi, tàu điện bị trễ.",
      "Vừa kịp lúc.",
    ]);
    const master = filmOf(cut).production.dialogue;
    expect(master.every((c) => c.status === "master" && c.alignment && c.audioAssetId)).toBe(true);

    expect(world.qaCalls).toEqual([
      expect.objectContaining({ requireAudio: true, durationMs: 15_000, fps: 24 }),
    ]);
    const published = await world.repos.renders.listByProject(ctx, project.id);
    expect(published.items.filter((r) => r.jobId === render.id)).toHaveLength(1);
    const usage = (await world.repos.usage.list(ctx, { jobId: render.id, limit: 200 })).items;
    expect(new Set(usage.map((u) => u.dedupeKey)).size).toBe(usage.length);
    expect(usage.filter((u) => u.kind === USAGE_KINDS.mediaGeneration)).toHaveLength(world.requests.length);
  });

  it("draws an empty shot from text with the film's aspect ratio when its set frame has another shape", async () => {
    const world = createWorld({ setFrame: { width: 1024, height: 1024 } });
    const { ctx, project } = await newFilm(`film-square-set-${pack}`, pack);
    const job = await enqueue(ctx, project.id, pack);
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    await signGate(world, ctx, job.id, "G0");
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    await signGate(world, ctx, job.id, "G1");
    expect(await world.runOnce(job.id)).toBe("succeeded");

    const keyframes = world.requests
      .slice(3)
      .sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
    const empty = shotIds.map((id) => keyframeReference(id).endsWith("-set-v1"));
    expect(empty).toContain(true);
    // An edit keeps its reference's frame, so a square set frame is not used; the shot asks for the film's frame.
    expect(keyframes.map((r) => typeof r.params?.image === "string")).toEqual(empty.map((e) => !e));
    expect(keyframes.map((r) => r.params?.aspectRatio ?? null)).toEqual(
      empty.map((e) => (e ? scope.aspectRatio : null)),
    );
  });

  it("redraws only the named sheet when G1 comes back with changes, bills it once, and asks G1 again", async () => {
    const world = createWorld();
    const { ctx, project } = await newFilm(`film-${pack}-revise`, pack);
    const job = await enqueue(ctx, project.id, pack);
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    await signGate(world, ctx, job.id, "G0");
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    const reviewed = await currentIr(ctx, project.id);
    expect(world.requests).toHaveLength(3);

    // The reviewer sends G1 back on Mai's sheet with a note.
    const note = "Shoulder-length black hair; yellow bow on her left in every view, back view included";
    const first = await world.repos.approvals.findLatest(
      ctx,
      { type: "job", id: job.id },
      "creative.gate",
      "gate:G1",
    );
    await world.repos.approvals.decide(ctx, first!.id, {
      status: "changes_requested",
      decidedBy: reviewer,
      decidedAt: new Date(),
      comment: note,
      changes: { targets: ["mai-sheet-v1"], note, invalidated: ["asset:mai-sheet-v1"] },
    });
    expect(await world.queue.resumeDecidedApprovals()).toBeGreaterThanOrEqual(1);
    expect(await world.runOnce(job.id)).toBe("waiting_approval");

    // Only Mai's sheet is redrawn, as v2, with the note next to the bible's anchors.
    expect(world.requests).toHaveLength(4);
    const redraw = world.requests[3]!;
    expect(redraw.idempotencyKey).toBe(`${job.id}:${n.g1}:mai-sheet-v2`);
    expect(redraw.prompt).toContain("Keep exactly:");
    expect(redraw.prompt).toContain(note);
    const revised = await currentIr(ctx, project.id);
    expect(revised.version.id).not.toBe(reviewed.version.id);
    expect(revised.version.parentVersionId).toBe(reviewed.version.id);
    expect(
      revised.ir.scenes[0]?.shots.map((sh) => [sh.id, "assetId" in sh ? sh.assetId : undefined]),
    ).toEqual([
      ["design-mai", "mai-sheet-v2"],
      ["design-tun", "tun-sheet-v1"],
      ["design-san-thuong", "san-thuong-set-v1"],
    ]);
    expect(
      filmOf(revised.ir).production.characters.map((c) => c.references.map((r) => [r.id, r.status])),
    ).toEqual([
      [
        ["mai-sheet-v1", "retired"],
        ["mai-sheet-v2", "candidate"],
      ],
      [["tun-sheet-v1", "candidate"]],
    ]);

    // G1 is open again, on the revised board.
    const again = await world.repos.approvals.findLatest(
      ctx,
      { type: "job", id: job.id },
      "creative.gate",
      "gate:G1",
    );
    expect(again?.id).not.toBe(first!.id);
    expect(again?.status).toBe("pending");
    expect(again?.reason).toContain("revision 1: redid mai-sheet-v1");
    const mediaUsage = async () =>
      (await world.repos.usage.list(ctx, { jobId: job.id, limit: 200 })).items.filter(
        (u) => u.kind === USAGE_KINDS.mediaGeneration,
      );
    expect(await mediaUsage()).toHaveLength(4);

    // Approved: no design is drawn again, the keyframes use the redrawn sheet, and every call is billed once.
    await signGate(world, ctx, job.id, "G1");
    const outcome = await world.runOnce(job.id);
    expect(outcome, JSON.stringify((await world.repos.jobs.get(ctx, job.id))?.error)).toBe("succeeded");
    const after = world.requests.slice(4);
    expect(after.map((r) => r.idempotencyKey.split(":").at(-1)).sort()).toEqual(
      shotIds.map((id) => `${id}-key`).sort(),
    );
    const gate = (await world.repos.jobs.listStages(ctx, job.id)).find((st) => st.name === n.g1);
    expect(gate?.output?.revisions).toEqual([
      expect.objectContaining({
        approvalId: first!.id,
        targets: ["mai-sheet-v1"],
        note,
        versionId: revised.version.id,
        invalidated: expect.arrayContaining(["asset:mai-sheet-v1", "asset:mai-sheet-v2", "shot:design-mai"]),
      }),
    ]);
    const storyboardTask = world.transport.requests.at(-1)?.input as {
      sheets: { characterId: string; references: { id: string }[] }[];
    };
    expect(storyboardTask.sheets.find((sh) => sh.characterId === "mai")?.references).toEqual([
      { id: "mai-sheet-v2", view: "turnaround" },
    ]);
    const film = filmOf((await currentIr(ctx, project.id)).ir);
    expect(film.production.shots.find((sh) => sh.shotId === "s4")?.conditioningRefs).toEqual([
      "mai-sheet-v2",
    ]);
    const usage = await mediaUsage();
    expect(usage).toHaveLength(world.requests.length);
    expect(new Set(usage.map((u) => u.dedupeKey)).size).toBe(usage.length);
  });

  it("redraws only the storyboard shots a reviewer sent back, with their notes, at most twice each", async () => {
    const world = createWorld();
    const { ctx, project } = await newFilm(`film-${pack}-redraw`, pack);
    const job = await enqueue(ctx, project.id, pack);
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    await signGate(world, ctx, job.id, "G0");
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    await signGate(world, ctx, job.id, "G1");
    expect(await world.runOnce(job.id)).toBe("succeeded");
    const board = await currentIr(ctx, project.id);
    world.requests.length = 0;

    // The reviewer sent s2 and s4 back; the render request carries the shots and their notes.
    const redraw = [
      { shotId: "s2", note: "No cream bars at the sides; the picture fills the frame" },
      { shotId: "s4", note: "Tùng in a long-sleeved white shirt and black trousers, as in s3" },
    ];
    const first = await enqueue(ctx, project.id, pack, {
      versionId: board.version.id,
      makeCurrent: false,
      storyboardRedraw: redraw,
    });
    const outcome = await world.runOnce(first.id);
    expect(outcome, JSON.stringify((await world.repos.jobs.get(ctx, first.id))?.error)).toBe("succeeded");
    const calls = [...world.requests].sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
    expect(calls.map((r) => r.idempotencyKey)).toEqual([
      `${first.id}:${n.redraw}:s2-key-v2`,
      `${first.id}:${n.redraw}:s4-key-v2`,
    ]);
    expect(calls[0]?.prompt).toContain(`Reviewer's correction, apply it exactly: ${redraw[0]!.note}`);
    expect(calls[1]?.prompt).toContain(redraw[1]!.note);
    // Same identity conditioning as the first keyframes: Mai's sheet, already in the film's frame.
    expect(
      calls.every((r) => typeof r.params?.image === "string" && r.params.aspectRatio === undefined),
    ).toBe(true);
    expect(world.rendered).toHaveLength(0);

    const redrawn = await currentIr(ctx, project.id);
    expect(redrawn.version.parentVersionId).toBe(board.version.id);
    expect(redrawn.project.status).toBe("in_review");
    expect(
      redrawn.ir.scenes[0]?.shots.map((sh) => [sh.id, "assetId" in sh ? sh.assetId : undefined]),
    ).toEqual([
      ["s1", "s1-key"],
      ["s2", "s2-key-v2"],
      ["s3", "s3-key"],
      ["s4", "s4-key-v2"],
      ["s5", "s5-key"],
    ]);
    // The replaced frames stay as history.
    expect(redrawn.ir.assets.map((a) => a.id)).toEqual(expect.arrayContaining(["s2-key", "s4-key"]));
    expect((await world.repos.jobs.get(ctx, first.id))?.result).toMatchObject({
      projectVersionId: redrawn.version.id,
      redrawn: [
        { shotId: "s2", assetId: "s2-key-v2", replaced: "s2-key" },
        { shotId: "s4", assetId: "s4-key-v2", replaced: "s4-key" },
      ],
    });
    const usage = (await world.repos.usage.list(ctx, { jobId: first.id, limit: 50 })).items;
    expect(usage.filter((u) => u.kind === USAGE_KINDS.mediaGeneration)).toHaveLength(2);

    // A second redraw of s2 is v3; a third is refused before any call.
    const second = await enqueue(ctx, project.id, pack, {
      versionId: redrawn.version.id,
      makeCurrent: false,
      storyboardRedraw: [{ shotId: "s2" }],
    });
    expect(await world.runOnce(second.id)).toBe("succeeded");
    expect(world.requests.at(-1)?.idempotencyKey).toBe(`${second.id}:${n.redraw}:s2-key-v3`);
    const third = await enqueue(ctx, project.id, pack, {
      versionId: (await currentIr(ctx, project.id)).version.id,
      makeCurrent: false,
      storyboardRedraw: [{ shotId: "s2" }],
    });
    const before = world.requests.length;
    expect(await world.runOnce(third.id)).toBe("failed");
    expect(await world.repos.jobs.get(ctx, third.id)).toMatchObject({ error: { code: "VALIDATION" } });
    expect(world.requests).toHaveLength(before);
  });

  it("pays again only for the effect whose cue changed: the lines, clips, lip-sync and music are reused", async () => {
    const world = createWorld();
    const { ctx, project } = await newFilm(`film-${pack}-reuse`, pack);
    const job = await enqueue(ctx, project.id, pack);
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    await signGate(world, ctx, job.id, "G0");
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    await signGate(world, ctx, job.id, "G1");
    expect(await world.runOnce(job.id)).toBe("succeeded");
    const board = await currentIr(ctx, project.id);
    await approveStoryboard(ctx, project.id);
    const first = await enqueue(ctx, project.id, pack, { versionId: board.version.id });
    expect(await world.runOnce(first.id)).toBe("succeeded");
    const paid = world.requests.filter((r) => r.kind !== "image").length;
    expect(paid).toBe(13);

    // One SFX cue of s4 changes in a new version; nothing else in the film does.
    const ir = structuredClone(board.ir);
    const film = (
      ir.metadata as { film: { scope: { scenes: { shots: { id: string; sfx: string[] }[] }[] } } }
    ).film;
    const s4 = film.scope.scenes.flatMap((sc) => sc.shots).find((sh) => sh.id === "s4");
    expect(s4?.sfx).toEqual(["distant fireworks launching"]);
    s4!.sfx = ["distant fireworks whistling upward"];
    const patched = await db.current.repos.projects.createVersion(ctx, {
      projectId: project.id,
      ir,
      source: "patch",
      parentVersionId: board.version.id,
      advanceFrom: board.version.id,
      createdBy: actor,
    });
    await approveStoryboard(ctx, project.id, 2);
    world.requests.length = 0;
    world.rendered.length = 0;
    const second = await enqueue(ctx, project.id, pack, { versionId: patched.id });
    expect(await world.runOnce(second.id)).toBe("succeeded");

    // The only provider call is the changed effect; every other output is the one the first job paid for.
    expect(world.requests.map((r) => [r.kind, r.prompt])).toEqual([
      ["sfx", "distant fireworks whistling upward"],
    ]);
    const usage = (await world.repos.usage.list(ctx, { jobId: second.id, limit: 200 })).items.filter(
      (u) => u.kind === USAGE_KINDS.mediaGeneration,
    );
    const reused = usage.filter((u) => u.metadata?.reused === true);
    expect(reused).toHaveLength(paid - 1);
    expect(reused.every((u) => u.costCents === 0 && u.metadata?.reusedFromJob === first.id)).toBe(true);
    expect(usage.filter((u) => u.costCents > 0).map((u) => u.metadata?.assetId)).toEqual(["s4-fx1"]);
    const cut = world.rendered[0]!;
    const keyOf = (id: string) => cut.assets.find((a) => a.id === id)?.storageKey ?? "";
    for (const id of ["s2-l1-vo", "s2-clip", "s2-sync", "s4-sync", "scene-1-score", "s1-fx1"].filter((id) =>
      cut.assets.some((a) => a.id === id),
    ))
      expect(keyOf(id), id).toContain(`generated/${first.id}/`);
    expect(keyOf("s4-fx1")).toContain(`generated/${second.id}/`);
  });

  /** Run the film through both gates, approve the storyboard, and queue the paid render. */
  async function queueRender(world: ReturnType<typeof createWorld>, slug: string) {
    const { ctx, project } = await newFilm(slug, pack);
    const job = await enqueue(ctx, project.id, pack);
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    await signGate(world, ctx, job.id, "G0");
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    await signGate(world, ctx, job.id, "G1");
    expect(await world.runOnce(job.id)).toBe("succeeded");
    const board = await currentIr(ctx, project.id);
    await approveStoryboard(ctx, project.id);
    world.requests.length = 0;
    const render = await enqueue(ctx, project.id, pack, { versionId: board.version.id });
    return { ctx, render };
  }

  it("generates an effect again once when it comes back with a voice, and bills both takes", async () => {
    const wind = "soft wind over a rooftop";
    const world = createWorld({ voiced: (prompt, take) => prompt === wind && take === 1 });
    const { ctx, render } = await queueRender(world, `film-${pack}-voiced-once`);

    expect(await world.runOnce(render.id)).toBe("succeeded");
    const effects = world.requests.filter((r) => r.kind === "sfx").map((r) => r.prompt);
    expect(effects.filter((p) => p === wind)).toHaveLength(2);
    expect(effects).toHaveLength(5);
    expect(world.heard.filter((h) => h.prompt === wind).map((h) => h.speech)).toEqual([true, false]);
    // The second take has its own upstream job, so it is a second paid call and a second usage line.
    const keys = world.requests.filter((r) => r.prompt === wind).map((r) => r.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    const usage = (await world.repos.usage.list(ctx, { jobId: render.id, limit: 200 })).items;
    expect(usage.filter((u) => u.kind === USAGE_KINDS.mediaGeneration)).toHaveLength(world.requests.length);
    expect(new Set(usage.map((u) => u.dedupeKey)).size).toBe(usage.length);
    const cut = world.rendered[0]!;
    expect((cut.audio ?? []).filter((t) => t.kind === "sfx")).toHaveLength(4);
  });

  it("fails with VALIDATION naming the shot and the cue when the second take still has a voice", async () => {
    const burst = "fireworks bursting overhead";
    const world = createWorld({ voiced: (prompt) => prompt === burst });
    const { ctx, render } = await queueRender(world, `film-${pack}-voiced-twice`);

    expect(await world.runOnce(render.id)).toBe("failed");
    const failed = await world.repos.jobs.get(ctx, render.id);
    expect(failed).toMatchObject({ status: "failed", error: { code: "VALIDATION" } });
    expect(failed?.error?.message).toContain("s5");
    expect(failed?.error?.message).toContain(burst);
    // Generated once more, not a third time; nothing voiced reached the mix.
    expect(world.requests.filter((r) => r.prompt === burst)).toHaveLength(2);
    expect(world.rendered).toHaveLength(0);
    const usage = (await world.repos.usage.list(ctx, { jobId: render.id, limit: 200 })).items;
    const paid = usage.filter((u) => u.kind === USAGE_KINDS.mediaGeneration);
    expect(paid).toHaveLength(world.requests.length);
  });

  it("keeps a cue marked as voiced without checking it, while the other effects are still checked", async () => {
    const burst = "fireworks bursting overhead";
    const world = createWorld({ voiced: (prompt) => prompt === burst });
    const { ctx, project } = await newFilm(`film-${pack}-voiced-on-purpose`, pack);
    const job = await enqueue(ctx, project.id, pack);
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    await signGate(world, ctx, job.id, "G0");
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    await signGate(world, ctx, job.id, "G1");
    expect(await world.runOnce(job.id)).toBe("succeeded");
    const board = await currentIr(ctx, project.id);
    await approveStoryboard(ctx, project.id);
    const ir = structuredClone(board.ir);
    const film = (
      ir.metadata as {
        film: { scope: { scenes: { shots: { id: string; sfx: string[]; voicedSfx?: string[] }[] }[] } };
      }
    ).film;
    const s5 = film.scope.scenes.flatMap((sc) => sc.shots).find((sh) => sh.id === "s5");
    expect(s5?.sfx).toContain(burst);
    s5!.voicedSfx = [burst];
    const patched = await db.current.repos.projects.createVersion(ctx, {
      projectId: project.id,
      ir,
      source: "patch",
      parentVersionId: board.version.id,
      advanceFrom: board.version.id,
      createdBy: actor,
    });
    await approveStoryboard(ctx, project.id, 2);
    world.requests.length = 0;
    const render = await enqueue(ctx, project.id, pack, { versionId: patched.id });

    expect(await world.runOnce(render.id)).toBe("succeeded");
    // Generated once, never probed; the other three effects were probed.
    expect(world.requests.filter((r) => r.prompt === burst)).toHaveLength(1);
    expect(world.heard.map((h) => h.prompt)).not.toContain(burst);
    expect(world.heard).toHaveLength(3);
    expect((world.rendered[0]?.audio ?? []).filter((t) => t.kind === "sfx")).toHaveLength(4);
  });

  it("still bills the first take when the second take fails with a plain error", async () => {
    const wind = "soft wind over a rooftop";
    const world = createWorld({
      voiced: (prompt, take) => prompt === wind && take === 1,
      refuse: (r) => r.prompt === wind && r.idempotencyKey.endsWith(":r1"),
    });
    const { ctx, render } = await queueRender(world, `film-${pack}-second-take-fails`);

    expect(await world.runOnce(render.id)).toBe("failed");
    const firstTake = world.requests.find((r) => r.prompt === wind && !r.idempotencyKey.endsWith(":r1"));
    expect(firstTake).toBeDefined();
    const usage = (await world.repos.usage.list(ctx, { jobId: render.id, limit: 200 })).items;
    const paid = usage.filter((u) => u.kind === USAGE_KINDS.mediaGeneration);
    // Every call the provider answered is in the ledger; the refused second take cost nothing and has no line.
    expect(paid).toHaveLength(world.requests.length - 1);
  });

  it("bills the clips it paid for when storing a scene fails afterwards", async () => {
    const world = createWorld({ refusePut: (key) => key.includes("/scenes/") });
    const { ctx, render } = await queueRender(world, `film-${pack}-scene-put-fails`);

    const before = world.requests.length;
    expect(await world.runOnce(render.id)).toBe("failed");
    const paidRequests = world.requests.slice(before);
    expect(paidRequests.some((r) => r.kind === "video")).toBe(true);
    const usage = (await world.repos.usage.list(ctx, { jobId: render.id, limit: 200 })).items;
    expect(usage.filter((u) => u.kind === USAGE_KINDS.mediaGeneration)).toHaveLength(paidRequests.length);
  });

  it("does not probe effects when the worker has no speech probe", async () => {
    const world = createWorld();
    const { render } = await queueRender(world, `film-${pack}-no-probe`);
    expect(await world.runOnce(render.id)).toBe("succeeded");
    expect(world.requests.filter((r) => r.kind === "sfx")).toHaveLength(4);
    expect(world.heard).toEqual([]);
  });
  it("caps each line at the price of the voice model it names, not of the default model", async () => {
    const voiceModel = "openrouter:google/gemini-3.8-flash-tts";
    const world = createWorld({ modelCents: { [voiceModel]: 30 } });
    const { render } = await renderJobOnApprovedBoard(world, `film-${pack}-voice-cap`, pack);
    expect(await world.runOnce(render.id)).toBe("succeeded");
    const lines = world.requests.filter((r) => r.kind === "voice");
    expect(lines).toHaveLength(3);
    // Twice the named model's estimate; the default model's 5 cents would have capped every line at 10.
    expect(lines.map((r) => [r.model, r.maxCostCents])).toEqual(lines.map(() => [voiceModel, 60]));
  });

  it.each([
    {
      stage: "dialogue",
      refuse: (r: MediaGenerationRequest) => r.kind === "voice" && r.prompt === "Vừa kịp lúc.",
      paid: ["s2-l1-vo", "s3-l1-vo"],
    },
    {
      stage: "motion",
      refuse: (r: MediaGenerationRequest) => r.idempotencyKey.endsWith(":s4-clip"),
      paid: ["s2-clip", "s3-clip"],
    },
  ])(
    "bills the $stage items already paid for when another item of the batch fails",
    async ({ stage, refuse, paid }) => {
      const world = createWorld({ refuse });
      const { ctx, render } = await renderJobOnApprovedBoard(world, `film-${pack}-${stage}-partial`, pack);
      expect(await world.runOnce(render.id)).toBe("failed");
      expect(await world.repos.jobs.get(ctx, render.id)).toMatchObject({ error: { code: "PROVIDER_ERROR" } });

      const usage = (await world.repos.usage.list(ctx, { jobId: render.id, limit: 200 })).items;
      const billed = usage
        .filter((u) => u.metadata?.stage === n[stage as keyof typeof n] && u.costCents > 0)
        .map((u) => u.metadata?.assetId)
        .sort();
      expect(billed).toEqual(paid);
      const spent = usage.reduce((sum, u) => sum + u.costCents, 0);
      expect(spent).toBeGreaterThan(0);
      expect(await world.repos.jobs.get(ctx, render.id)).toMatchObject({ spentCents: spent });
    },
  );

  it("fails the job and spends nothing on designs when the reviewer rejects G0", async () => {
    const world = createWorld();
    const { ctx, project } = await newFilm(`film-${pack}-reject`, pack);
    const job = await enqueue(ctx, project.id, pack);
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    const g0 = await world.repos.approvals.findLatest(
      ctx,
      { type: "job", id: job.id },
      "creative.gate",
      "gate:G0",
    );
    await world.repos.approvals.decide(ctx, g0!.id, {
      status: "rejected",
      decidedBy: reviewer,
      decidedAt: new Date(),
    });
    expect(await world.queue.resumeDecidedApprovals()).toBeGreaterThanOrEqual(1);
    expect(await world.runOnce(job.id)).toBe("failed");
    expect(await world.repos.jobs.get(ctx, job.id)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(world.requests).toHaveLength(0);
  });
});
