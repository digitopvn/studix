import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMediaExecService,
  type Job,
  type MediaExecResult,
  type RendererAdapter,
  type TenantContext,
} from "@studix/core";
import { insertTestUser, withTestDatabase } from "@studix/database/testing";
import { createLogger } from "@studix/shared";
import { InMemoryStorageAdapter } from "@studix/storage";
import type { Planner } from "@studix/workflow";
import { describe, expect, it } from "vitest";
import { createMediaExecRunner, loadMediaExecSettings } from "../src/media-exec-runner.ts";
import { loadSandboxSettings } from "../src/skill-sandbox.ts";
import { createWorkerRuntime } from "../src/wiring.ts";

/*
 * studix_media_exec end to end with real ffmpeg: service -> durable job -> worker -> docker sandbox
 * (--network none) -> outputs stored as workspace assets -> job result. Needs Postgres and the sandbox image
 * (`docker build -f docker/sandbox.Dockerfile -t studix-sandbox:local .`); skipped without the image.
 */

const IMAGE = process.env.STUDIX_SANDBOX_IMAGE ?? "studix-sandbox:local";
const hasImage = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;

const db = withTestDatabase();
const logger = createLogger({}, { level: "error", write: () => {} });

describe.skipIf(!hasImage)("media exec in the sandbox (real ffmpeg)", () => {
  it("transcodes, concatenates, extracts audio, makes a thumbnail and probes as JSON", async () => {
    const repos = db.current.repos;
    await insertTestUser(db.current, { id: "usr_mx", email: "mx@example.test" });
    const { organization, workspace } = await repos.directory.provisionWorkspace({
      organization: { name: "mx", slug: "mx" },
      workspace: { name: "Main", slug: "main" },
      ownerUserId: "usr_mx",
    });
    const ctx: TenantContext = {
      organizationId: organization.id,
      workspaceId: workspace.id,
      actor: { type: "user", id: "usr_mx", role: "editor" },
    };
    const storage = new InMemoryStorageAdapter();
    const workDir = mkdtempSync(join(tmpdir(), "studix-mx-"));
    const env = { STUDIX_SANDBOX: "docker", STUDIX_SANDBOX_IMAGE: IMAGE, STUDIX_SANDBOX_CPUS: "1" };
    const sandbox = loadSandboxSettings(env);
    if (!sandbox) throw new Error("sandbox settings");
    const settings = loadMediaExecSettings(env);
    const runtime = createWorkerRuntime({
      db: db.current.db,
      planner: {} as Planner,
      renderer: {} as RendererAdapter,
      storage,
      mediaExec: {
        runner: createMediaExecRunner({ sandbox, settings, workDir, storage, assets: repos.assets, logger }),
        centsPerMinute: 1,
      },
      settings: {
        workerId: "w-mx",
        concurrency: 2,
        leaseMs: 60_000,
        heartbeatIntervalMs: 5_000,
        pollIntervalMs: 100,
        workDir,
        approvalCostThresholdCents: 100_000,
        renderCentsPerSecond: 0,
      },
      logger,
    });
    const service = createMediaExecService({
      queue: repos.queue,
      assets: repos.assets,
      audit: repos.audit,
      defaults: { jobBudgetCents: 500 },
    });

    async function exec(request: Record<string, unknown>, idempotencyKey?: string): Promise<Job> {
      const { job } = await service.start(ctx, { request, ...(idempotencyKey ? { idempotencyKey } : {}) });
      for (let i = 0; i < 600; i++) {
        const current = await repos.jobs.get(ctx, job.id);
        if (current && ["succeeded", "failed", "cancelled"].includes(current.status)) return current;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`job ${job.id} did not finish`);
    }
    const resultOf = (job: Job) => job.result as unknown as MediaExecResult;
    const assetOf = (job: Job, name: string) => {
      const output = resultOf(job).outputs.find((o) => o.name === name);
      if (!output) throw new Error(`no output ${name}`);
      return { assetId: output.assetId };
    };

    runtime.start();
    try {
      // Two short sources from ffmpeg's own generators (lavfi), stored as assets.
      const sources = await exec({
        tool: "ffmpeg",
        args: [
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=320x240:rate=25:duration=1",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1",
          "-shortest",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "{out:a.mp4}",
        ],
        outputs: [{ name: "a.mp4" }],
      });
      expect(sources.status, JSON.stringify(sources.error)).toBe("succeeded");
      const a = assetOf(sources, "a.mp4");

      const transcode = await exec({
        tool: "ffmpeg",
        args: [
          "-i",
          "{in:a.mp4}",
          "-vf",
          "scale=iw/2:-2",
          "-c:v",
          "libx264",
          "-c:a",
          "copy",
          "{out:small.mp4}",
        ],
        inputs: { "a.mp4": a },
        outputs: [{ name: "small.mp4" }],
      });
      expect(transcode.status, JSON.stringify(transcode.error)).toBe("succeeded");
      const small = resultOf(transcode).outputs[0];
      expect(small?.contentType).toBe("video/mp4");
      expect(small?.bytes).toBeGreaterThan(0);
      const stored = await repos.assets.get(ctx, small?.assetId as string);
      expect(stored?.kind).toBe("video");
      expect((await storage.head(ctx, small?.storageKey as string))?.bytes).toBe(small?.bytes);

      const concat = await exec({
        tool: "ffmpeg",
        args: [
          "-i",
          "{in:one.mp4}",
          "-i",
          "{in:two.mp4}",
          "-filter_complex",
          "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]",
          "-map",
          "[v]",
          "-map",
          "[a]",
          "{out:joined.mp4}",
        ],
        inputs: { "one.mp4": a, "two.mp4": a },
        outputs: [{ name: "joined.mp4" }],
      });
      expect(concat.status, JSON.stringify(concat.error)).toBe("succeeded");

      const audio = await exec({
        tool: "ffmpeg",
        args: ["-i", "{in:v.mp4}", "-vn", "-c:a", "libmp3lame", "{out:audio.mp3}"],
        inputs: { "v.mp4": assetOf(concat, "joined.mp4") },
        outputs: [{ name: "audio.mp3" }],
      });
      expect(audio.status, JSON.stringify(audio.error)).toBe("succeeded");
      expect(resultOf(audio).outputs[0]?.contentType).toBe("audio/mpeg");

      const thumb = await exec({
        tool: "ffmpeg",
        args: ["-ss", "0.5", "-i", "{in:v.mp4}", "-frames:v", "1", "{out:thumb.png}"],
        inputs: { "v.mp4": a },
        outputs: [{ name: "thumb.png" }],
      });
      expect(thumb.status, JSON.stringify(thumb.error)).toBe("succeeded");
      expect(resultOf(thumb).outputs[0]?.contentType).toBe("image/png");

      const probe = await exec({
        tool: "ffprobe",
        args: ["-v", "error", "-of", "json", "-show_format", "-show_streams", "{in:joined.mp4}"],
        inputs: { "joined.mp4": assetOf(concat, "joined.mp4") },
      });
      expect(probe.status, JSON.stringify(probe.error)).toBe("succeeded");
      const json = resultOf(probe).json as { format: { duration: string }; streams: unknown[] };
      expect(Number(json.format.duration)).toBeGreaterThan(1.5);
      expect(json.streams).toHaveLength(2);

      // A failing command fails the job with its stderr tail and is still metered.
      const failed = await exec({
        tool: "ffmpeg",
        args: ["-i", "{in:a.mp4}", "-c:v", "no_such_codec", "{out:x.mp4}"],
        inputs: { "a.mp4": a },
        outputs: [{ name: "x.mp4" }],
      });
      expect(failed.status).toBe("failed");
      expect(failed.error?.message).toMatch(/exited with code \d+: .*no_such_codec/s);
      expect(failed.spentCents).toBeGreaterThan(0);

      // The sandbox has no network.
      const offline = await exec({
        tool: "ffmpeg",
        args: ["-f", "lavfi", "-i", "anullsrc", "-t", "0.1", "-metadata", "title=x", "{out:n.wav}"],
        outputs: [{ name: "n.wav" }],
      });
      expect(offline.status).toBe("succeeded");

      // The same idempotency key replays the earlier job.
      const first = await exec({ tool: "ffprobe", args: ["-version"] }, "probe-version");
      const again = await service.start(ctx, {
        request: { tool: "ffprobe", args: ["-version"] },
        idempotencyKey: "probe-version",
      });
      expect(again.replayed).toBe(true);
      expect(again.job.id).toBe(first.id);
      expect(resultOf(first).stdout).toMatch(/ffprobe version/);

      const audit = await repos.audit.list(ctx, { subjectType: "job", subjectId: transcode.id });
      const event = audit.items.find((e) => e.action === "media.exec_started");
      expect(event?.data).toMatchObject({ tool: "ffmpeg", inputs: [{ name: "a.mp4", source: "asset" }] });
      expect(JSON.stringify(event?.data)).not.toContain("scale=");
    } finally {
      await runtime.stop(5_000);
    }
  }, 300_000);
});
