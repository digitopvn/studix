import type { VideoIR } from "@studix/video-ir";
import brandIntro from "@studix/video-ir/fixtures/brand-intro-9x16.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { storyboardStatus } from "../src/index.ts";
import { createInMemoryStudio, testTenant, withActor } from "../src/testing/index.ts";

const brief = { prompt: "Video giới thiệu thương hiệu cà phê Sương Mai, 15 giây, dọc", language: "vi" };

async function setup() {
  const env = createInMemoryStudio();
  const ctx = testTenant();
  const created = await env.studio.createVideoProject(ctx, { brief, spec: brandIntro as VideoIR });
  return { ...env, ctx, projectId: created.project.id };
}

const replaceText = (path: string, value: string) => ({ ops: [{ op: "replace" as const, path, value }] });

describe("project review", () => {
  it("shows the storyboard of the current version in draft, with script, timeline and nothing rendered", async () => {
    const { studio, ctx, projectId } = await setup();
    const review = await studio.getProjectReview(ctx, projectId);
    expect(review.workflowTemplate).toBe("brand-intro");
    expect(review.storyboard?.approval.status).toBe("draft");
    expect(review.storyboard?.stored).toBe(false);
    expect(review.storyboard?.scenes.map((s) => s.id)).toEqual(["hook", "intro", "feature", "cta"]);
    const feature2 = review.storyboard?.scenes[2]?.shots[1];
    expect(feature2).toMatchObject({
      id: "feature-2",
      startMs: 9300,
      endMs: 11500,
      pointer: "/scenes/2/shots/1",
      render: "not_rendered",
      approval: { status: "draft" },
    });
    expect(review.script.lines.length).toBeGreaterThan(0);
    expect(review.timeline).toMatchObject({ durationMs: 15000, aspectRatio: "9:16" });
    expect(review.storyboard?.pendingShots).toBe(6);
  });

  it("feedback with a patch on one shot stores a new version, invalidates only that shot and its scene", async () => {
    const { studio, ctx, projectId, repos } = await setup();
    const out = await studio.submitFeedback(ctx, {
      projectId,
      shotId: "feature-1",
      comment: "Nhấn mạnh tốc độ giao hàng",
      patch: replaceText("/scenes/2/shots/0/text", "Giao hàng trong 2 giờ"),
    });
    expect(out.versionId).toEqual(expect.any(String));
    expect(out.version).toBe(2);
    expect(out.invalidated.sort()).toEqual(["scene:feature", "shot:feature-1"]);
    expect(out.job?.status).toBe("queued");
    expect(out.next[0]?.tool).toBe("studix_get_job");
    const job = await repos.jobs.get(ctx, out.job!.id);
    expect(job?.payload).toMatchObject({
      versionId: out.versionId,
      workflowTemplate: "brand-intro",
      makeCurrent: false,
    });

    const review = await studio.getProjectReview(ctx, projectId);
    expect(review.currentVersion?.id).toBe(out.versionId);
    expect(review.invalidated.sort()).toEqual(["scene:feature", "shot:feature-1"]);
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({ targetId: "shot:feature-1", versionId: out.baseVersionId });
    const shot = review.storyboard?.scenes[2]?.shots[0];
    expect(shot).toMatchObject({ changed: true, revision: 2, comments: 1 });
    expect(review.storyboard?.scenes[0]?.shots[0]).toMatchObject({ changed: false, revision: 1 });
  });

  describe("comment without a patch and an idempotencyKey", () => {
    const comment = (projectId: string, extra: Record<string, unknown> = {}) => ({
      projectId,
      shotId: "feature-1",
      comment: "Cần nhịp nhanh hơn",
      idempotencyKey: "cmt-1",
      ...extra,
    });

    it("returns the stored comment on retry instead of creating another", async () => {
      const { studio, ctx, projectId } = await setup();
      const first = await studio.submitFeedback(ctx, comment(projectId));
      const again = await studio.submitFeedback(ctx, comment(projectId));
      expect(first.replayed).toBe(false);
      expect(again).toMatchObject({
        replayed: true,
        feedbackId: first.feedbackId,
        baseVersionId: first.baseVersionId,
      });
      expect(again.versionId).toBeUndefined();
      expect((await studio.getProjectReview(ctx, projectId)).comments).toHaveLength(1);
    });

    it("stores one comment when two retries arrive at once", async () => {
      const { studio, ctx, projectId } = await setup();
      const [a, b] = await Promise.all([
        studio.submitFeedback(ctx, comment(projectId)),
        studio.submitFeedback(ctx, comment(projectId)),
      ]);
      expect(a.feedbackId).toBe(b.feedbackId);
      expect((await studio.getProjectReview(ctx, projectId)).comments).toHaveLength(1);
    });

    it("refuses the key for a different comment or for a patch", async () => {
      const { studio, ctx, projectId } = await setup();
      await studio.submitFeedback(ctx, comment(projectId));
      await expect(
        studio.submitFeedback(ctx, comment(projectId, { comment: "Nội dung khác" })),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        studio.submitFeedback(
          ctx,
          comment(projectId, { patch: replaceText("/scenes/2/shots/0/text", "Mới") }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect((await studio.getProjectReview(ctx, projectId)).comments).toHaveLength(1);
    });

    it("refuses the key for the same comment aimed at another target", async () => {
      const { studio, ctx, projectId } = await setup();
      await studio.submitFeedback(ctx, comment(projectId));
      await expect(
        studio.submitFeedback(ctx, comment(projectId, { shotId: undefined, sceneId: "hook" })),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("refuses a comment that reuses the key of a patch", async () => {
      const { studio, ctx, projectId } = await setup();
      await studio.submitFeedback(
        ctx,
        comment(projectId, { patch: replaceText("/scenes/2/shots/0/text", "Mới") }),
      );
      await expect(studio.submitFeedback(ctx, comment(projectId))).rejects.toMatchObject({
        code: "CONFLICT",
      });
    });

    it("does not expose the key on the review page", async () => {
      const { studio, ctx, projectId } = await setup();
      await studio.submitFeedback(ctx, comment(projectId));
      const page = await studio.getProjectReview(ctx, projectId);
      expect(page.comments[0]).not.toHaveProperty("idempotencyKey");
    });

    it("keeps the same key usable on another project", async () => {
      const { studio, ctx, projectId } = await setup();
      const other = await studio.createVideoProject(ctx, { brief, spec: brandIntro as VideoIR });
      await studio.submitFeedback(ctx, comment(projectId));
      const out = await studio.submitFeedback(ctx, comment(other.project.id));
      expect(out.replayed).toBe(false);
    });
  });

  it("two patches sent at once on the same base: one wins, the other gets CONFLICT and leaves nothing behind", async () => {
    const { studio, ctx, projectId, repos } = await setup();
    const review = await studio.getProjectReview(ctx, projectId);
    const baseVersionId = review.currentVersion?.id;
    const send = (text: string) =>
      studio.submitFeedback(ctx, {
        projectId,
        shotId: "feature-1",
        comment: `đổi thành ${text}`,
        baseVersionId,
        patch: replaceText("/scenes/2/shots/0/text", text),
      });
    const results = await Promise.allSettled([send("Một"), send("Hai")]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.reason).toMatchObject({
      code: "CONFLICT",
      details: { currentVersionId: expect.any(String) },
    });

    const after = await studio.getProjectReview(ctx, projectId);
    expect(after.versions).toHaveLength(2);
    expect(after.comments).toHaveLength(1);
    const versions = await repos.projects.listVersions(ctx, projectId);
    expect(versions.items.filter((v) => v.parentVersionId === baseVersionId)).toHaveLength(1);
    expect(after.currentVersion?.id).toBe(
      (won[0] as PromiseFulfilledResult<{ versionId?: string }>).value.versionId,
    );
  });

  describe("a feedback request that stopped after its version was stored", () => {
    async function failOnce(env: Awaited<ReturnType<typeof setup>>, step: "recordVersion" | "enqueue") {
      const target = step === "recordVersion" ? env.repos.revisions : env.repos.queue;
      const name = step === "recordVersion" ? "recordVersion" : "enqueue";
      const record = target as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = record[name] as (...args: unknown[]) => Promise<unknown>;
      let armed = true;
      record[name] = async (...args) => {
        if (armed) {
          armed = false;
          throw new Error(`${step} failed`);
        }
        return original.apply(target, args);
      };
    }
    const request = (env: Awaited<ReturnType<typeof setup>>, baseVersionId?: string) => ({
      projectId: env.projectId,
      shotId: "feature-1",
      comment: "đổi tiêu đề",
      idempotencyKey: "fb-1",
      baseVersionId,
      patch: replaceText("/scenes/2/shots/0/text", "Mới"),
    });

    for (const step of ["recordVersion", "enqueue"] as const) {
      it(`is completed by a retry with the same key and base version (${step} failed)`, async () => {
        const env = await setup();
        const baseVersionId = (await env.studio.getProjectReview(env.ctx, env.projectId)).currentVersion?.id;
        await failOnce(env, step);
        await expect(env.studio.submitFeedback(env.ctx, request(env, baseVersionId))).rejects.toThrow(
          `${step} failed`,
        );

        const out = await env.studio.submitFeedback(env.ctx, request(env, baseVersionId));
        expect(out.job).toBeDefined();
        expect(out.versionId).toBeDefined();
        const review = await env.studio.getProjectReview(env.ctx, env.projectId);
        expect(review.versions).toHaveLength(2);
        expect(review.comments).toHaveLength(1);
        expect(review.currentVersion?.id).toBe(out.versionId);

        const again = await env.studio.submitFeedback(env.ctx, request(env, baseVersionId));
        expect(again).toMatchObject({ replayed: true, versionId: out.versionId, feedbackId: out.feedbackId });
        expect((await env.studio.getProjectReview(env.ctx, env.projectId)).versions).toHaveLength(2);
      });
    }

    it("a retry without a base version does not patch the orphan version a second time", async () => {
      const env = await setup();
      await failOnce(env, "enqueue");
      await expect(env.studio.submitFeedback(env.ctx, request(env))).rejects.toThrow("enqueue failed");
      const out = await env.studio.submitFeedback(env.ctx, request(env));
      const review = await env.studio.getProjectReview(env.ctx, env.projectId);
      expect(review.versions).toHaveLength(2);
      expect(review.currentVersion?.id).toBe(out.versionId);
      expect(review.comments).toHaveLength(1);
    });

    it("does not complete a version that a newer patch has superseded", async () => {
      const env = await setup();
      await failOnce(env, "enqueue");
      await expect(env.studio.submitFeedback(env.ctx, request(env))).rejects.toThrow("enqueue failed");
      await env.studio.submitFeedback(env.ctx, {
        projectId: env.projectId,
        shotId: "feature-1",
        comment: "sửa tiếp",
        patch: replaceText("/scenes/2/shots/0/text", "Khác"),
      });
      await expect(env.studio.submitFeedback(env.ctx, request(env))).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect((await env.studio.getProjectReview(env.ctx, env.projectId)).versions).toHaveLength(3);
    });

    it("refuses a reused key for a different request, and a reviewer cannot complete it", async () => {
      const env = await setup();
      await failOnce(env, "enqueue");
      await expect(env.studio.submitFeedback(env.ctx, request(env))).rejects.toThrow("enqueue failed");
      await expect(
        env.studio.submitFeedback(env.ctx, {
          ...request(env),
          patch: replaceText("/scenes/2/shots/0/text", "Không phải"),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const reviewer = withActor(env.ctx, { type: "user", id: "usr_rev", role: "reviewer" });
      await expect(
        env.studio.submitFeedback(reviewer, {
          projectId: env.projectId,
          shotId: "feature-1",
          comment: "x",
          idempotencyKey: "fb-1",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(env.studio.submitFeedback(env.ctx, request(env))).resolves.toMatchObject({
        replayed: false,
      });
    });

    it("two retries sent at once with the same key end in one version, one comment and one job", async () => {
      const env = await setup();
      const baseVersionId = (await env.studio.getProjectReview(env.ctx, env.projectId)).currentVersion?.id;
      const [a, b] = await Promise.all([
        env.studio.submitFeedback(env.ctx, request(env, baseVersionId)),
        env.studio.submitFeedback(env.ctx, request(env, baseVersionId)),
      ]);
      expect(a.versionId).toBe(b.versionId);
      expect(a.feedbackId).toBe(b.feedbackId);
      expect(a.job?.id).toBe(b.job?.id);
      expect([a.replayed, b.replayed].filter(Boolean)).toHaveLength(1);
      const review = await env.studio.getProjectReview(env.ctx, env.projectId);
      expect(review.versions).toHaveLength(2);
      expect(review.comments).toHaveLength(1);
    });
  });

  it("refuses a patch that reaches outside the feedback target, and stores nothing", async () => {
    const { studio, ctx, projectId } = await setup();
    await expect(
      studio.submitFeedback(ctx, {
        projectId,
        shotId: "feature-1",
        comment: "đổi luôn câu mở đầu",
        patch: replaceText("/scenes/0/shots/0/text", "Khác"),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", details: { allowedPaths: ["/scenes/2/shots/0"] } });
    const review = await studio.getProjectReview(ctx, projectId);
    expect(review.comments).toHaveLength(0);
    expect(review.versions).toHaveLength(1);
  });

  it("refuses a patch that removes the targeted shot so a later op lands on its neighbour", async () => {
    const { studio, ctx, projectId } = await setup();
    const neighbour = (brandIntro as VideoIR).scenes[2]!.shots[1]!;
    expect(neighbour.id).toBe("feature-2");
    await expect(
      studio.submitFeedback(ctx, {
        projectId,
        shotId: "feature-1",
        comment: "làm lại cảnh này",
        patch: {
          ops: [
            { op: "remove", path: "/scenes/2/shots/0" },
            { op: "replace", path: "/scenes/2/shots/0", value: { ...neighbour, text: "Đã bị sửa" } },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", details: { shifting: ["/scenes/2/shots/0"] } });
    // Inserting before the target shifts it as well.
    await expect(
      studio.submitFeedback(ctx, {
        projectId,
        shotId: "feature-1",
        comment: "chèn thêm",
        patch: { ops: [{ op: "add", path: "/scenes/2/shots/0", value: { ...neighbour, id: "feature-0" } }] },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", details: { shifting: ["/scenes/2/shots/0"] } });
    const review = await studio.getProjectReview(ctx, projectId);
    expect(review.versions).toHaveLength(1);
    expect(review.comments).toHaveLength(0);
    expect(review.storyboard?.scenes[2]?.shots.map((s) => s.id)).toEqual(["feature-1", "feature-2"]);

    // Replacing the whole targeted shot keeps every neighbour in place and stays allowed.
    const target = (brandIntro as VideoIR).scenes[2]!.shots[0]!;
    await expect(
      studio.submitFeedback(ctx, {
        projectId,
        shotId: "feature-1",
        comment: "viết lại",
        patch: { ops: [{ op: "replace", path: "/scenes/2/shots/0", value: { ...target, text: "Mới" } }] },
      }),
    ).resolves.toMatchObject({ version: 2 });
  });

  it("feedback on a time range is a comment about the overlapping shots with the paths a patch may touch", async () => {
    const { studio, ctx, projectId } = await setup();
    const out = await studio.submitFeedback(ctx, {
      projectId,
      startMs: 2500,
      endMs: 3500,
      comment: "Cắt nhanh hơn",
    });
    expect(out.job).toBeUndefined();
    expect(out.shots).toEqual(["hook-title", "intro-logo"]);
    expect(out.allowedPaths).toEqual(["/scenes/0/shots/0", "/scenes/1/shots/0"]);
    expect(out.next[0]).toMatchObject({ tool: "studix_feedback" });
    const [comment] = (await studio.getProjectReview(ctx, projectId)).comments;
    expect(comment).toMatchObject({ atMs: 2500, endMs: 3500 });
    expect(comment?.targetId).toBeUndefined();
  });

  it("rejects unknown targets, ambiguous targets and stale base versions", async () => {
    const { studio, ctx, projectId } = await setup();
    await expect(
      studio.submitFeedback(ctx, { projectId, shotId: "nope", comment: "x" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      studio.submitFeedback(ctx, { projectId, assetId: "logo", comment: "x" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      studio.submitFeedback(ctx, { projectId, shotId: "hook-title", sceneId: "hook", comment: "x" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      studio.submitFeedback(ctx, {
        projectId,
        shotId: "hook-title",
        comment: "x",
        baseVersionId: "pver_old",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  describe("feedback on a film character's voice", () => {
    const cast = {
      schemaVersion: 1,
      characters: [
        { characterId: "mai", voice: { direction: "warm, teasing" } },
        { characterId: "tung", voice: { direction: "out of breath" } },
      ],
      shots: [],
      dialogue: [
        {
          id: "feature-1-l1",
          shotId: "feature-1",
          characterId: "mai",
          text: "Lại muộn rồi.",
          status: "temp",
        },
        { id: "cta-button-l1", shotId: "cta-button", characterId: "tung", text: "Xin lỗi.", status: "temp" },
        { id: "feature-2-l1", shotId: "feature-2", characterId: "mai", text: "Vừa kịp.", status: "temp" },
      ],
    };

    async function filmSetup() {
      const env = createInMemoryStudio();
      const ctx = testTenant();
      const spec = { ...(brandIntro as VideoIR), metadata: { film: { production: cast } } };
      const created = await env.studio.createVideoProject(ctx, { brief, spec });
      return { ...env, ctx, projectId: created.project.id };
    }

    const castVoice = (index: number, voiceRef: string) => ({
      ops: [
        {
          op: "add" as const,
          path: `/metadata/film/production/characters/${index}/voice/voiceRef`,
          value: voiceRef,
        },
      ],
    });

    it("re-casts one character's voice, about the shots they speak in, keeping the approved storyboard", async () => {
      const { studio, ctx, projectId, repos } = await filmSetup();
      await studio.decideStoryboard(ctx, { projectId, target: "storyboard", decision: "approved" });
      expect(await storyboardStatus(repos, ctx, projectId)).toBe("approved");

      const out = await studio.submitFeedback(ctx, {
        projectId,
        characterId: "mai",
        comment: "Giọng Mai: Leda",
        patch: castVoice(0, "openrouter:google/gemini-tts@Leda"),
      });
      expect(out.allowedPaths).toEqual(["/metadata/film/production/characters/0/voice"]);
      expect(out.shots).toEqual(["feature-1", "feature-2"]);
      expect(out.invalidated.filter((k) => k.startsWith("shot:") || k.startsWith("scene:"))).toEqual([]);
      expect(out.job?.status).toBe("queued");

      const review = await studio.getProjectReview(ctx, projectId);
      expect(review.comments[0]).toMatchObject({ targetId: "character:mai", body: "Giọng Mai: Leda" });
      const current = await repos.projects.getVersion(ctx, out.versionId!);
      const film = current?.ir.metadata?.film as { production: typeof cast };
      expect(film.production.characters[0]?.voice).toEqual({
        direction: "warm, teasing",
        voiceRef: "openrouter:google/gemini-tts@Leda",
      });
      expect(film.production.characters[1]?.voice).toEqual({ direction: "out of breath" });
      expect(await storyboardStatus(repos, ctx, projectId)).toBe("approved");
    });

    it("refuses a character patch outside that character's voice, and stores nothing", async () => {
      const { studio, ctx, projectId } = await filmSetup();
      for (const patch of [
        castVoice(1, "@Puck"),
        replaceText("/metadata/film/production/characters/0/characterId", "lan"),
        replaceText("/metadata/film/production/dialogue/0/text", "Câu khác"),
        replaceText("/scenes/2/shots/0/text", "Khác"),
      ]) {
        await expect(
          studio.submitFeedback(ctx, { projectId, characterId: "mai", comment: "đổi giọng", patch }),
        ).rejects.toMatchObject({
          code: "VALIDATION",
          details: { allowedPaths: ["/metadata/film/production/characters/0/voice"] },
        });
      }
      const review = await studio.getProjectReview(ctx, projectId);
      expect(review.comments).toHaveLength(0);
      expect(review.versions).toHaveLength(1);
    });

    it("rejects a character the version does not cast, and a character target on a video without a cast", async () => {
      const film = await filmSetup();
      await expect(
        film.studio.submitFeedback(film.ctx, { projectId: film.projectId, characterId: "lan", comment: "x" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const plain = await setup();
      await expect(
        plain.studio.submitFeedback(plain.ctx, {
          projectId: plain.projectId,
          characterId: "mai",
          comment: "x",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        plain.studio.submitFeedback(plain.ctx, {
          projectId: plain.projectId,
          characterId: "mai",
          shotId: "hook-title",
          comment: "x",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });
  });

  describe("feedback on a film shot's SFX cues", () => {
    const scope = {
      scenes: [
        { id: "sc-1", shots: [{ id: "feature-1", sfx: ["pháo hoa nổ"] }] },
        { id: "sc-2", shots: [{ id: "feature-2", sfx: ["tiếng gió"] }] },
      ],
    };

    async function filmSetup() {
      const env = createInMemoryStudio();
      const ctx = testTenant();
      const spec = { ...(brandIntro as VideoIR), metadata: { film: { scope } } };
      const created = await env.studio.createVideoProject(ctx, { brief, spec });
      return { ...env, ctx, projectId: created.project.id };
    }

    it("rewrites one shot's cues in the scope, keeping the approved storyboard", async () => {
      const { studio, ctx, projectId, repos } = await filmSetup();
      await studio.decideStoryboard(ctx, { projectId, target: "storyboard", decision: "approved" });
      const out = await studio.submitFeedback(ctx, {
        projectId,
        shotId: "feature-1",
        comment: "SFX phải là tiếng, không phải lời",
        patch: replaceText("/metadata/film/scope/scenes/0/shots/0/sfx/0", "fireworks bursting overhead"),
      });
      expect(out.allowedPaths).toEqual([
        expect.stringMatching(/^\/scenes\/\d+\/shots\/\d+$/),
        "/metadata/film/scope/scenes/0/shots/0/sfx",
      ]);
      expect(out.invalidated.filter((k) => k.startsWith("shot:") || k.startsWith("scene:"))).toEqual([]);
      const current = await repos.projects.getVersion(ctx, out.versionId!);
      const film = current?.ir.metadata?.film as { scope: typeof scope };
      expect(film.scope.scenes.map((sc) => sc.shots[0]?.sfx)).toEqual([
        ["fireworks bursting overhead"],
        ["tiếng gió"],
      ]);
      expect(await storyboardStatus(repos, ctx, projectId)).toBe("approved");
    });

    it("rewrites the cues of every shot a time range covers in one patch", async () => {
      const { studio, ctx, projectId, repos } = await filmSetup();
      const ir = (await repos.projects.getVersion(
        ctx,
        (await repos.projects.get(ctx, projectId))!.currentVersionId!,
      ))!.ir;
      const out = await studio.submitFeedback(ctx, {
        projectId,
        startMs: 0,
        endMs: ir.format.durationMs,
        comment: "SFX bằng tiếng Anh",
        patch: {
          ops: [
            {
              op: "replace",
              path: "/metadata/film/scope/scenes/0/shots/0/sfx/0",
              value: "fireworks bursting overhead",
            },
            {
              op: "replace",
              path: "/metadata/film/scope/scenes/1/shots/0/sfx/0",
              value: "soft wind over a rooftop",
            },
          ],
        },
      });
      expect(out.allowedPaths).toEqual(
        expect.arrayContaining([
          "/metadata/film/scope/scenes/0/shots/0/sfx",
          "/metadata/film/scope/scenes/1/shots/0/sfx",
        ]),
      );
      const film = (await repos.projects.getVersion(ctx, out.versionId!))?.ir.metadata?.film as {
        scope: typeof scope;
      };
      expect(film.scope.scenes.map((sc) => sc.shots[0]?.sfx)).toEqual([
        ["fireworks bursting overhead"],
        ["soft wind over a rooftop"],
      ]);
    });

    it("refuses another shot's cues, and offers no cue path on a video without a film scope", async () => {
      const { studio, ctx, projectId } = await filmSetup();
      await expect(
        studio.submitFeedback(ctx, {
          projectId,
          shotId: "feature-1",
          comment: "x",
          patch: replaceText("/metadata/film/scope/scenes/1/shots/0/sfx/0", "soft wind"),
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      const plain = await setup();
      const note = await plain.studio.submitFeedback(plain.ctx, {
        projectId: plain.projectId,
        shotId: "feature-1",
        comment: "x",
      });
      expect(note.allowedPaths).toHaveLength(1);
    });
  });

  it("a person approves the storyboard; the approval survives an unrelated patch only where nothing changed", async () => {
    const { studio, ctx, projectId, repos } = await setup();
    for (const id of ["hook-title", "feature-1"]) {
      await studio.decideStoryboard(ctx, { projectId, target: "shot", targetId: id, decision: "approved" });
    }
    const approved = await studio.decideStoryboard(ctx, {
      projectId,
      target: "storyboard",
      decision: "approved",
      expectedRevision: 2,
    });
    expect(approved.storyboard.revision).toBe(3);
    expect(await storyboardStatus(repos, ctx, projectId)).toBe("approved");

    await studio.submitFeedback(ctx, {
      projectId,
      shotId: "feature-1",
      comment: "Đổi câu",
      patch: replaceText("/scenes/2/shots/0/text", "Giao hàng trong 2 giờ"),
    });
    const review = await studio.getProjectReview(ctx, projectId);
    expect(review.storyboard?.approval.status).toBe("in_review");
    expect(review.storyboard?.scenes[0]?.shots[0]?.approval.status).toBe("approved");
    expect(review.storyboard?.scenes[2]?.shots[0]?.approval.status).toBe("in_review");
    expect(await storyboardStatus(repos, ctx, projectId)).toBe("in_review");
  });

  it("requesting changes stores the note as a comment and blocks approving the storyboard", async () => {
    const { studio, ctx, projectId } = await setup();
    const out = await studio.decideStoryboard(ctx, {
      projectId,
      target: "shot",
      targetId: "cta-button",
      decision: "changes_requested",
      note: "CTA chưa rõ",
    });
    expect(out.comment).toMatchObject({ targetId: "shot:cta-button", body: "CTA chưa rõ" });
    await expect(
      studio.decideStoryboard(ctx, { projectId, target: "storyboard", decision: "approved" }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { shots: ["cta-button"] } });
    await expect(
      studio.decideStoryboard(ctx, {
        projectId,
        target: "shot",
        targetId: "x",
        decision: "approved",
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("only signed-in reviewers decide; API keys and viewers cannot, and viewers cannot comment", async () => {
    const { studio, ctx, projectId } = await setup();
    const key = withActor(ctx, {
      type: "apiKey",
      id: "key_1",
      scopes: ["project:read", "project:write", "approval:decide"],
    });
    await expect(
      studio.decideStoryboard(key, { projectId, target: "storyboard", decision: "approved" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const viewer = withActor(ctx, { type: "user", id: "usr_viewer", role: "viewer" });
    await expect(
      studio.decideStoryboard(viewer, { projectId, target: "storyboard", decision: "approved" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      studio.submitFeedback(viewer, { projectId, shotId: "hook-title", comment: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const reviewer = withActor(ctx, { type: "user", id: "usr_reviewer", role: "reviewer" });
    await expect(
      studio.submitFeedback(reviewer, { projectId, shotId: "hook-title", comment: "ok" }),
    ).resolves.toBeDefined();
    await expect(
      studio.submitFeedback(reviewer, {
        projectId,
        shotId: "hook-title",
        comment: "x",
        patch: replaceText("/scenes/0/shots/0/text", "y"),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps projects of other tenants invisible", async () => {
    const { studio, projectId } = await setup();
    const other = testTenant();
    await expect(studio.getProjectReview(other, projectId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      studio.submitFeedback(other, { projectId, shotId: "hook-title", comment: "x" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(studio.renderVersion(other, { projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      studio.decideStoryboard(other, { projectId, target: "storyboard", decision: "approved" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("render queues a job for the current version and replays by idempotency key", async () => {
    const { studio, ctx, projectId, repos } = await setup();
    const first = await studio.renderVersion(ctx, {
      projectId,
      renderPreset: "final",
      idempotencyKey: "r-1",
    });
    expect(first).toMatchObject({ version: 1, replayed: false });
    expect((await repos.jobs.get(ctx, first.job.id))?.payload).toMatchObject({
      renderPreset: "final",
      makeCurrent: false,
    });
    const rollback = await studio.renderVersion(ctx, { projectId, versionId: first.versionId });
    expect((await repos.jobs.get(ctx, rollback.job.id))?.payload).toMatchObject({ makeCurrent: true });
    const again = await studio.renderVersion(ctx, { projectId, idempotencyKey: "r-1" });
    expect(again).toMatchObject({ replayed: true, versionId: first.versionId });
    expect(again.job.id).toBe(first.job.id);
    await expect(studio.renderVersion(ctx, { projectId, versionId: "pver_missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("render redraws the shots a reviewer asked to change instead of rendering", async () => {
    const { studio, ctx, projectId, repos } = await setup();
    await studio.decideStoryboard(ctx, {
      projectId,
      target: "shot",
      targetId: "cta-button",
      decision: "changes_requested",
      note: "CTA chưa rõ",
    });
    await studio.decideStoryboard(ctx, {
      projectId,
      target: "shot",
      targetId: "hook-title",
      decision: "changes_requested",
      note: "Chữ to hơn",
    });
    await studio.decideStoryboard(ctx, {
      projectId,
      target: "shot",
      targetId: "feature-1",
      decision: "approved",
    });
    const out = await studio.renderVersion(ctx, { projectId });
    expect(out.storyboardRedraw).toEqual(["hook-title", "cta-button"]);
    expect((await repos.jobs.get(ctx, out.job.id))?.payload).toMatchObject({
      makeCurrent: false,
      storyboardRedraw: [
        { shotId: "hook-title", note: "Chữ to hơn" },
        { shotId: "cta-button", note: "CTA chưa rõ" },
      ],
    });
  });

  it("render without requested changes queues a plain render", async () => {
    const { studio, ctx, projectId, repos } = await setup();
    const out = await studio.renderVersion(ctx, { projectId });
    expect(out.storyboardRedraw).toBeUndefined();
    expect((await repos.jobs.get(ctx, out.job.id))?.payload).not.toHaveProperty("storyboardRedraw");
  });
});
