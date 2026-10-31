import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MediaGenerationRequest } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { createManualClock } from "@studix/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMultixProviderFromConfig,
  InMemoryMediaJobJournal,
  MultixProvider,
  type MultixRunner,
  type MultixRunOptions,
  type MultixRunResult,
  parseCheckKeys,
} from "../src/index.ts";

/** One scripted CLI reply. `files` are written before the envelope is returned, as multix would. */
interface Reply {
  exitCode?: number;
  envelope?: Record<string, unknown>;
  stdout?: string;
  stoppedBy?: MultixRunResult["stoppedBy"];
  files?: Record<string, string>;
}

interface Call {
  argv: readonly string[];
  options: MultixRunOptions;
}

/** A fake multix CLI: `handler` answers each argv; every call is recorded. */
function scriptedCli(handler: (argv: readonly string[], options: MultixRunOptions) => Reply) {
  const calls: Call[] = [];
  const runner: MultixRunner = async (argv, options) => {
    calls.push({ argv: [...argv], options });
    const reply = handler(argv, options);
    for (const [path, content] of Object.entries(reply.files ?? {})) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    const stdout =
      reply.stdout ??
      (reply.envelope
        ? `${JSON.stringify({ schema: "multix.result/v1", ok: (reply.exitCode ?? 0) === 0, ...reply.envelope })}\n`
        : "");
    return {
      exitCode: reply.exitCode ?? 0,
      stdout,
      ...(reply.stoppedBy ? { stoppedBy: reply.stoppedBy } : {}),
    };
  };
  const commands = () => calls.map((c) => c.argv.slice(0, 2).join(" "));
  return { runner, calls, commands };
}

const flagValue = (argv: readonly string[], name: string) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const CHECK_TEXT = [
  "multix check",
  "  ✓ SUME_API_KEY found (sk-…abcd)",
  "  ✓ ELEVENLABS_API_KEY found (el-…wxyz)",
  "  ✗ ATLASCLOUD_API_KEY missing",
  "  ✗ FISH_API_KEY missing",
].join("\n");

const SUME_CATALOG = {
  source: "live",
  currency: "USD",
  models: [
    { id: "nano-banana-2.1", kind: "image", modes: ["text-to-image"] },
    { id: "z-image", kind: "image", modes: ["text-to-image"] },
    { id: "seedance-2-mini", kind: "video", modes: ["text-to-video", "image-to-video"] },
    { id: "topaz-video", kind: "video", modes: ["video-to-video"], capabilities: { video_tool: "upscale" } },
    { id: "sync-lipsync-2", kind: "lipsync", modes: ["lipsync"] },
    { id: "captioner", kind: "captions", modes: [] },
  ],
};

const ctx = testTenant();
let workDir: string;
beforeEach(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), "studix-multix-test-")));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const imageRequest = (overrides: Partial<MediaGenerationRequest> = {}): MediaGenerationRequest => ({
  kind: "image",
  prompt: "--a lighthouse at dusk",
  idempotencyKey: "stage-1:image",
  maxCostCents: 100,
  workDir,
  params: { aspectRatio: "16:9" },
  ...overrides,
});

/** Sume image happy path: estimate 4¢, submit job_1, status downloads one PNG with a 3¢ receipt. */
function sumeImageCli(statusReply?: (argv: readonly string[]) => Reply) {
  let submits = 0;
  const cli = scriptedCli((argv) => {
    if (argv.includes("--estimate")) {
      return {
        envelope: {
          estimate: { status: "estimated", high_usd: 0.04 },
          cost: { actual_source: "no_request" },
        },
      };
    }
    if (argv[0] === "sume" && argv[1] === "image") {
      submits += 1;
      return {
        envelope: { job: { provider: "sume", id: `job_${submits}` }, text: `Job submitted: job_${submits}` },
      };
    }
    if (argv[0] === "sume" && argv[1] === "status") {
      if (statusReply) return statusReply(argv);
      const out = join(flagValue(argv, "output")!, "image-1.png");
      return {
        files: { [out]: "png-bytes" },
        envelope: {
          outputs: [{ path: out, mime: "image/png", width: 1344, height: 768 }],
          cost: { actual_usd: 0.03, actual_source: "provider" },
        },
      };
    }
    throw new Error(`unexpected argv ${argv.join(" ")}`);
  });
  return cli;
}

describe("parseCheckKeys", () => {
  it("reads key names only and ignores missing keys", () => {
    expect([...parseCheckKeys(CHECK_TEXT)].sort()).toEqual(["ELEVENLABS_API_KEY", "SUME_API_KEY"]);
    expect(parseCheckKeys(undefined).size).toBe(0);
  });
});

describe("MultixProvider capabilities", () => {
  it("advertises the kinds whose keys multix check reports, with live catalog models", async () => {
    const cli = scriptedCli((argv) => {
      if (argv[0] === "check") return { envelope: { text: CHECK_TEXT } };
      if (argv[0] === "sume" && argv[1] === "models") return { envelope: { data: SUME_CATALOG } };
      if (argv[0] === "models" && argv.includes("--task=speech")) {
        return {
          envelope: {
            data: [
              {
                provider: "elevenlabs",
                command: "elevenlabs tts",
                default_model: "eleven_multilingual_v2",
                models: ["eleven_v3"],
              },
              { provider: "fish", command: "fish tts", default_model: "s1" },
              { provider: "openai", command: "openai tts", default_model: "tts-1" },
            ],
          },
        };
      }
      if (argv[0] === "models") return { envelope: { data: [] } };
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    const multix = new MultixProvider({ bin: "multix", runner: cli.runner });
    const caps = await multix.capabilities();
    const byKind = Object.fromEntries(caps.map((c) => [c.kind, c.models]));
    expect(Object.keys(byKind).sort()).toEqual(["image", "music", "sfx", "upscale", "video", "voice"]);
    expect(byKind.image).toEqual(["sume:nano-banana-2.1", "sume:z-image"]);
    expect(byKind.video).toEqual(["sume:seedance-2-mini", "sume:sync-lipsync-2"]);
    // Atlas has no key, so only the Sume video upscaler is offered.
    expect(byKind.upscale).toEqual(["sume:topaz-video"]);
    // Fish has no key and OpenAI is not an audio route, so neither is offered.
    expect(byKind.voice).toEqual(["elevenlabs:eleven_multilingual_v2", "elevenlabs:eleven_v3"]);
    expect(byKind.sfx).toEqual(["elevenlabs:sound-effects"]);
    expect(await multix.readiness()).toEqual({
      sume: true,
      atlas: false,
      elevenlabs: true,
      fish: false,
      minimax: false,
    });
    // Probes are cached.
    await multix.capabilities();
    expect(cli.commands().filter((c) => c.startsWith("check"))).toHaveLength(1);
  });

  it("advertises nothing when multix check fails", async () => {
    const cli = scriptedCli(() => ({
      exitCode: 3,
      envelope: { error: { code: "CONFIG", message: "no keys" } },
    }));
    const multix = new MultixProvider({ bin: "multix", runner: cli.runner });
    expect(await multix.capabilities()).toEqual([]);
  });

  it("is disabled without MULTIX_BIN", async () => {
    const multix = createMultixProviderFromConfig({
      MULTIX_BIN: undefined,
      MULTIX_ALLOW_HOME_ENV: false,
      MULTIX_WAIT_TIMEOUT_SECONDS: 900,
    });
    expect(multix.status()).toMatchObject({ enabled: false, reason: "MULTIX_BIN is not set" });
    expect(await multix.capabilities()).toEqual([]);
    await expect(multix.generate(ctx, imageRequest())).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("MultixProvider models", () => {
  it("takes default models from config and rejects routes outside the allowed vendors", () => {
    const multix = createMultixProviderFromConfig({
      MULTIX_BIN: "multix",
      MULTIX_IMAGE_MODEL: "sume:z-image",
      MULTIX_VOICE_MODEL: "fish:s1",
      MULTIX_ALLOW_HOME_ENV: false,
      MULTIX_WAIT_TIMEOUT_SECONDS: 900,
    });
    expect(multix.resolveModel({ kind: "image" })).toBe("sume:z-image");
    expect(multix.resolveModel({ kind: "voice" })).toBe("fish:s1");
    expect(multix.resolveModel({ kind: "video", params: { audio: "a.mp3" } })).toBe("sume:sync-lipsync-2");
    expect(multix.resolveModel({ kind: "upscale", params: { image: "a.png" } })).toBe(
      "atlas:atlascloud/image-upscaler",
    );
    expect(multix.resolveModel({ kind: "upscale", params: { video: "a.mp4" } })).toBe("sume:topaz-video");
    expect(() => new MultixProvider({ bin: "multix", models: { image: "elevenlabs:x" } })).toThrow(
      expect.objectContaining({ code: "VALIDATION" }),
    );
    expect(() => multix.resolveModel({ kind: "audio" })).toThrow(
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  });
});

describe("MultixProvider async jobs", () => {
  it("estimates, submits with a cap and an idempotency key, then collects the receipt", async () => {
    const cli = sumeImageCli();
    const multix = new MultixProvider({
      bin: "multix",
      runner: cli.runner,
      env: {
        PATH: "/usr/bin",
        SUME_API_KEY: "secret",
        DATABASE_URL: "postgres://x",
        AWS_SECRET_ACCESS_KEY: "s",
      },
      clock: createManualClock(0),
    });
    const result = await multix.generate(ctx, imageRequest());

    expect(cli.commands()).toEqual(["sume image", "sume image", "sume status"]);
    const [estimate, submit, status] = cli.calls.map((c) => c.argv);
    expect(estimate).toEqual([
      "sume",
      "image",
      "--model=nano-banana-2.1",
      "--aspect-ratio=16:9",
      "--estimate",
      "--json",
      "--",
      "--a lighthouse at dusk",
    ]);
    // The prompt is an operand after "--", so a prompt that looks like a flag stays a prompt.
    expect(submit!.slice(-2)).toEqual(["--", "--a lighthouse at dusk"]);
    expect(flagValue(submit!, "idempotency-key")).toMatch(/^studix-[0-9a-f]{40}$/);
    expect(flagValue(submit!, "max-cost")).toBe("1.00");
    expect(submit).toContain("--cost-policy=strict");
    expect(status!.slice(0, 5)).toEqual(["sume", "status", "job_1", "--wait", "--download"]);

    expect(result).toMatchObject({
      provider: "multix",
      model: "sume:nano-banana-2.1",
      costCents: 3,
      costSource: "receipt",
      job: { provider: "sume", id: "job_1" },
    });
    expect(result.outputs).toEqual([
      {
        filePath: join(workDir, "multix-sume-job_1", "image-1.png"),
        mime: "image/png",
        width: 1344,
        height: 768,
      },
    ]);

    // The child sees only the passthrough variables and provider keys, never the worker's other secrets.
    for (const { options } of cli.calls) {
      expect(options.env).toMatchObject({
        PATH: "/usr/bin",
        SUME_API_KEY: "secret",
        MULTIX_DISABLE_HOME_ENV: "1",
      });
      expect(options.env).not.toHaveProperty("DATABASE_URL");
      expect(options.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
      expect(options.env.MULTIX_OUTPUT_DIR).toContain(".multix-cache-");
    }
  });

  it("refuses before submitting when the estimate exceeds the cap", async () => {
    const cli = sumeImageCli();
    const multix = new MultixProvider({ bin: "multix", runner: cli.runner });
    await expect(multix.generate(ctx, imageRequest({ maxCostCents: 3 }))).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
    expect(cli.commands()).toEqual(["sume image"]);
  });

  it("resumes the journaled job after the worker lost it, without paying again", async () => {
    let statusCalls = 0;
    const cli = sumeImageCli((argv) => {
      statusCalls += 1;
      if (statusCalls === 1) return { stoppedBy: "timeout", exitCode: 143 };
      const out = join(flagValue(argv, "output")!, "image-1.png");
      return { files: { [out]: "png" }, envelope: { outputs: [{ path: out }], usage: { cost_usd: 0.03 } } };
    });
    const journal = new InMemoryMediaJobJournal();
    const first = new MultixProvider({ bin: "multix", runner: cli.runner, journal });
    const error = await first.generate(ctx, imageRequest()).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: "TIMEOUT", details: { job: { provider: "sume", id: "job_1" } } });
    expect(await journal.get(ctx, "stage-1:image")).toMatchObject({
      state: "submitted",
      job: { id: "job_1" },
    });

    // A new worker with the same journal retries the stage: it collects job_1 instead of submitting.
    const second = new MultixProvider({ bin: "multix", runner: cli.runner, journal });
    const result = await second.generate(ctx, imageRequest());
    expect(result).toMatchObject({ job: { id: "job_1" }, costCents: 3, costSource: "receipt" });
    expect(cli.commands()).toEqual(["sume image", "sume image", "sume status", "sume status"]);
    expect(await journal.get(ctx, "stage-1:image")).toMatchObject({ state: "completed", receiptCents: 3 });

    // Retrying a completed stage collects again and still never submits.
    await second.generate(ctx, imageRequest());
    expect(cli.commands().filter((c) => c === "sume image")).toHaveLength(2);
  });

  it("resumes by provider job id alone", async () => {
    const cli = sumeImageCli((argv) => {
      const out = join(flagValue(argv, "output")!, "video.mp4");
      return { files: { [out]: "mp4" }, envelope: { outputs: [{ path: out, duration_s: 5.04 }] } };
    });
    const multix = new MultixProvider({ bin: "multix", runner: cli.runner });
    const result = await multix.resume(ctx, {
      kind: "video",
      job: { provider: "sume", id: "job_42" },
      model: "sume:seedance-2-mini",
      workDir,
      estimatedCostCents: 25,
    });
    expect(cli.commands()).toEqual(["sume status"]);
    expect(result).toMatchObject({
      model: "sume:seedance-2-mini",
      costCents: 25,
      costSource: "estimate",
      job: { provider: "sume", id: "job_42" },
      outputs: [{ mime: "video/mp4", durationMs: 5040 }],
    });

    await expect(
      multix.resume(ctx, { kind: "video", job: { provider: "sume", id: "../../etc" }, workDir }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      multix.resume(ctx, { kind: "video", job: { provider: "openai", id: "job_1" }, workDir }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("submits a new attempt with a new idempotency key after the upstream rejected the job", async () => {
    let statusCalls = 0;
    const cli = sumeImageCli((argv) => {
      statusCalls += 1;
      if (statusCalls === 1) {
        return { exitCode: 5, envelope: { error: { code: "REJECTED", message: "content policy" } } };
      }
      const out = join(flagValue(argv, "output")!, "image-1.png");
      return { files: { [out]: "png" }, envelope: { outputs: [{ path: out }], usage: { cost_usd: 0.03 } } };
    });
    const journal = new InMemoryMediaJobJournal();
    const multix = new MultixProvider({ bin: "multix", runner: cli.runner, journal });
    await expect(multix.generate(ctx, imageRequest())).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      retryable: false,
    });
    expect(await journal.get(ctx, "stage-1:image")).toMatchObject({ state: "failed", attempt: 1 });

    const result = await multix.generate(ctx, imageRequest());
    expect(result.job).toEqual({ provider: "sume", id: "job_2" });
    const submits = cli.calls.filter((c) => c.argv[1] === "image" && !c.argv.includes("--estimate"));
    expect(submits).toHaveLength(2);
    expect(flagValue(submits[0]!.argv, "idempotency-key")).not.toBe(
      flagValue(submits[1]!.argv, "idempotency-key"),
    );
    expect(await journal.get(ctx, "stage-1:image")).toMatchObject({ state: "completed", attempt: 2 });
  });

  it("refuses an idempotency key reused for a different request", async () => {
    const cli = sumeImageCli();
    const multix = new MultixProvider({ bin: "multix", runner: cli.runner });
    await multix.generate(ctx, imageRequest());
    await expect(multix.generate(ctx, imageRequest({ model: "sume:z-image" }))).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("does not trust outputs multix flags as broken", async () => {
    const cli = sumeImageCli((argv) => {
      const out = join(flagValue(argv, "output")!, "image-1.png");
      return {
        files: { [out]: "png" },
        envelope: { outputs: [{ path: out }], warnings: [{ code: "EMPTY_OUTPUT" }] },
      };
    });
    const multix = new MultixProvider({ bin: "multix", runner: cli.runner });
    await expect(multix.generate(ctx, imageRequest())).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      details: { warnings: ["EMPTY_OUTPUT"] },
    });
  });

  it("drops reported outputs outside the job directory", async () => {
    const outside = join(workDir, "elsewhere.png");
    const cli = sumeImageCli(() => ({
      files: { [outside]: "png" },
      envelope: { outputs: [{ path: outside }] },
    }));
    const multix = new MultixProvider({ bin: "multix", runner: cli.runner });
    await expect(multix.generate(ctx, imageRequest())).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("without outputs"),
    });
  });

  it("upscales a local image on Atlas Cloud: upload, async run, then download", async () => {
    const input = join(workDir, "frame.png");
    await writeFile(input, "png");
    const cli = scriptedCli((argv) => {
      if (argv[1] === "upload") return { envelope: { text: "https://cdn.atlascloud.ai/u/frame.png" } };
      if (argv[1] === "run")
        return { envelope: { job: { provider: "atlas", id: "pred_9" }, text: "pred_9" } };
      if (argv[1] === "status") {
        const out = join(flagValue(argv, "output")!, "output-1.png");
        return { files: { [out]: "big-png" }, envelope: { outputs: [{ path: out, mime: "image/png" }] } };
      }
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    const multix = new MultixProvider({ bin: "multix", runner: cli.runner });
    await expect(
      multix.estimateCostCents({
        kind: "upscale",
        prompt: "upscale",
        maxCostCents: 5,
        params: { image: input },
      }),
    ).resolves.toBe(1);
    expect(cli.calls).toHaveLength(0);

    const result = await multix.generate(ctx, {
      kind: "upscale",
      prompt: "upscale",
      idempotencyKey: "stage-2:upscale",
      maxCostCents: 5,
      workDir,
      params: { image: input, scale: 4 },
    });
    expect(cli.commands()).toEqual(["atlas upload", "atlas run", "atlas status"]);
    expect(cli.calls[0]!.argv).toEqual(["atlas", "upload", input, "--json"]);
    const run = cli.calls[1]!.argv;
    expect(run.slice(0, 3)).toEqual(["atlas", "run", "atlascloud/image-upscaler"]);
    expect(JSON.parse(flagValue(run, "input")!)).toEqual({
      outscale: 4,
      output_format: "png",
      image: "https://cdn.atlascloud.ai/u/frame.png",
    });
    expect(run).toContain("--async");
    expect(result).toMatchObject({
      costCents: 1,
      costSource: "estimate",
      job: { provider: "atlas", id: "pred_9" },
    });
  });

  describe("Atlas submission without an idempotency key", () => {
    const upscaleRequest = (input: string): MediaGenerationRequest => ({
      kind: "upscale",
      prompt: "upscale",
      idempotencyKey: "stage-2:upscale",
      maxCostCents: 5,
      workDir,
      params: { image: input },
    });
    const atlasCli = (onRun: () => Reply) =>
      scriptedCli((argv) => {
        if (argv[1] === "upload") return { envelope: { text: "https://cdn.atlascloud.ai/u/frame.png" } };
        if (argv[1] === "run") return onRun();
        if (argv[1] === "status") {
          const out = join(flagValue(argv, "output")!, "output-1.png");
          return { files: { [out]: "big-png" }, envelope: { outputs: [{ path: out, mime: "image/png" }] } };
        }
        throw new Error(`unexpected argv ${argv.join(" ")}`);
      });

    it("journals the intent before submitting and refuses to resubmit when the outcome is unknown", async () => {
      const input = join(workDir, "frame.png");
      await writeFile(input, "png");
      const journal = new InMemoryMediaJobJournal();
      let runs = 0;
      // The worker dies after Atlas accepted the run but before any job id reaches the journal.
      const cli = atlasCli(() => {
        runs += 1;
        throw new Error("worker crashed");
      });
      const multix = new MultixProvider({ bin: "multix", runner: cli.runner, journal });
      await expect(multix.generate(ctx, upscaleRequest(input))).rejects.toThrow("worker crashed");
      await expect(journal.get(ctx, "stage-2:upscale")).resolves.toMatchObject({ state: "submitting" });

      await expect(multix.generate(ctx, upscaleRequest(input))).rejects.toMatchObject({
        code: "PROVIDER_ERROR",
        retryable: false,
        message: expect.stringContaining("may already have been charged"),
      });
      expect(runs).toBe(1);
    });

    it("keeps a paid Atlas job resumable when collecting it fails permanently", async () => {
      const input = join(workDir, "frame.png");
      await writeFile(input, "png");
      const journal = new InMemoryMediaJobJournal();
      let runs = 0;
      const cli = scriptedCli((argv) => {
        if (argv[1] === "upload") return { envelope: { text: "https://cdn.atlascloud.ai/u/frame.png" } };
        if (argv[1] === "run") {
          runs += 1;
          return { envelope: { job: { provider: "atlas", id: "pred_9" }, text: "pred_9" } };
        }
        return { exitCode: 5, envelope: { error: { message: "rejected" } } };
      });
      const multix = new MultixProvider({ bin: "multix", runner: cli.runner, journal });
      await expect(multix.generate(ctx, upscaleRequest(input))).rejects.toMatchObject({
        code: "PROVIDER_ERROR",
      });
      await expect(journal.get(ctx, "stage-2:upscale")).resolves.toMatchObject({ state: "submitted" });
      await expect(multix.generate(ctx, upscaleRequest(input))).rejects.toMatchObject({
        code: "PROVIDER_ERROR",
      });
      expect(runs).toBe(1);
    });

    it("releases the key when atlas run exits 2 (rejected before any submission)", async () => {
      const input = join(workDir, "frame.png");
      await writeFile(input, "png");
      const journal = new InMemoryMediaJobJournal();
      let runs = 0;
      const cli = atlasCli(() => {
        runs += 1;
        return runs === 1
          ? { exitCode: 2, envelope: { error: { message: "bad input" } } }
          : { envelope: { job: { provider: "atlas", id: "pred_9" }, text: "pred_9" } };
      });
      const multix = new MultixProvider({ bin: "multix", runner: cli.runner, journal });
      await expect(multix.generate(ctx, upscaleRequest(input))).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(journal.get(ctx, "stage-2:upscale")).resolves.toMatchObject({
        state: "failed",
        attempt: 1,
      });
      await expect(multix.generate(ctx, upscaleRequest(input))).resolves.toMatchObject({
        job: { provider: "atlas", id: "pred_9" },
      });
      expect(runs).toBe(2);
      await expect(journal.get(ctx, "stage-2:upscale")).resolves.toMatchObject({ attempt: 2 });
    });

    it.each([
      ["TIMEOUT", { stoppedBy: "timeout" as const, exitCode: 143 }],
      ["CANCELLED", { stoppedBy: "abort" as const, exitCode: 143 }],
    ])("keeps the record blocked when atlas run ends %s with an unknown outcome", async (code, reply) => {
      const input = join(workDir, "frame.png");
      await writeFile(input, "png");
      const journal = new InMemoryMediaJobJournal();
      let runs = 0;
      const cli = atlasCli(() => {
        runs += 1;
        return reply;
      });
      const multix = new MultixProvider({ bin: "multix", runner: cli.runner, journal });
      await expect(multix.generate(ctx, upscaleRequest(input))).rejects.toMatchObject({ code });
      await expect(journal.get(ctx, "stage-2:upscale")).resolves.toMatchObject({ state: "submitting" });
      await expect(multix.generate(ctx, upscaleRequest(input))).rejects.toMatchObject({
        code: "PROVIDER_ERROR",
        retryable: false,
        message: expect.stringContaining("may already have been charged"),
      });
      expect(runs).toBe(1);
    });

    it("lets only one of two concurrent submissions of the same key reach atlas", async () => {
      const input = join(workDir, "frame.png");
      await writeFile(input, "png");
      const journal = new InMemoryMediaJobJournal();
      let runs = 0;
      const cli = atlasCli(() => {
        runs += 1;
        return { envelope: { job: { provider: "atlas", id: "pred_9" }, text: "pred_9" } };
      });
      const multix = new MultixProvider({ bin: "multix", runner: cli.runner, journal });
      const settled = await Promise.allSettled([
        multix.generate(ctx, upscaleRequest(input)),
        multix.generate(ctx, upscaleRequest(input)),
      ]);
      expect(runs).toBe(1);
      expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = settled.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: "CONFLICT", retryable: false });
    });

    it("lets an operator attach the prediction id to a submitting record", async () => {
      const input = join(workDir, "frame.png");
      await writeFile(input, "png");
      const journal = new InMemoryMediaJobJournal();
      let runs = 0;
      const cli = atlasCli(() => {
        runs += 1;
        throw new Error("worker crashed");
      });
      const multix = new MultixProvider({ bin: "multix", runner: cli.runner, journal });
      await expect(multix.generate(ctx, upscaleRequest(input))).rejects.toThrow("worker crashed");

      await expect(
        multix.recordSubmittedJob(ctx, {
          idempotencyKey: "stage-2:upscale",
          job: { provider: "sume", id: "x1" },
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(
        multix.recordSubmittedJob(ctx, {
          idempotencyKey: "stage-2:upscale",
          job: { provider: "atlas", id: "../x" },
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(
        multix.recordSubmittedJob(ctx, {
          idempotencyKey: "missing",
          job: { provider: "atlas", id: "pred_9" },
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      await multix.recordSubmittedJob(ctx, {
        idempotencyKey: "stage-2:upscale",
        job: { provider: "atlas", id: "pred_9" },
      });
      await expect(journal.get(ctx, "stage-2:upscale")).resolves.toMatchObject({
        state: "submitted",
        job: { provider: "atlas", id: "pred_9" },
      });
      // The next attempt collects the attached job and never submits again.
      await expect(multix.generate(ctx, upscaleRequest(input))).resolves.toMatchObject({
        job: { provider: "atlas", id: "pred_9" },
      });
      expect(runs).toBe(1);
      // A tracked record cannot be overwritten.
      await expect(
        multix.recordSubmittedJob(ctx, {
          idempotencyKey: "stage-2:upscale",
          job: { provider: "atlas", id: "pred_10" },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("lets a retry through when multix proves the run was never accepted", async () => {
      const input = join(workDir, "frame.png");
      await writeFile(input, "png");
      const journal = new InMemoryMediaJobJournal();
      let runs = 0;
      const cli = atlasCli(() => {
        runs += 1;
        return runs === 1
          ? { exitCode: 3, envelope: { error: { message: "ATLASCLOUD_API_KEY missing" } } }
          : { envelope: { job: { provider: "atlas", id: "pred_9" }, text: "pred_9" } };
      });
      const multix = new MultixProvider({ bin: "multix", runner: cli.runner, journal });
      await expect(multix.generate(ctx, upscaleRequest(input))).rejects.toMatchObject({
        code: "UNAVAILABLE",
      });
      await expect(journal.get(ctx, "stage-2:upscale")).resolves.toMatchObject({ state: "failed" });
      await expect(multix.generate(ctx, upscaleRequest(input))).resolves.toMatchObject({
        job: { provider: "atlas", id: "pred_9" },
      });
      expect(runs).toBe(2);
    });
  });

  it("rejects local inputs outside the work directory", async () => {
    const other = await realpath(await mkdtemp(join(tmpdir(), "studix-multix-other-")));
    try {
      const outside = join(other, "secret.png");
      await writeFile(outside, "png");
      const cli = scriptedCli(() => ({ envelope: {} }));
      const multix = new MultixProvider({ bin: "multix", runner: cli.runner });
      await expect(
        multix.generate(ctx, imageRequest({ kind: "upscale", params: { image: outside } })),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      expect(cli.calls).toHaveLength(0);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("MultixProvider synchronous audio", () => {
  const voiceRequest = (): MediaGenerationRequest => ({
    kind: "voice",
    prompt: "Xin chào Studix",
    idempotencyKey: "stage-3:voice",
    maxCostCents: 10,
    workDir,
  });

  it("runs TTS once and reuses the completed file on retry", async () => {
    const cli = scriptedCli((argv, options) => {
      if (argv.includes("--estimate"))
        return { envelope: { estimate: { status: "estimated", high_usd: 0.002 } } };
      const out = flagValue(argv, "output")!;
      const copy = join(options.env.MULTIX_OUTPUT_DIR!, "tts.mp3");
      return {
        files: { [out]: "mp3", [copy]: "mp3" },
        envelope: { outputs: [{ path: out }, { path: copy }], history_id: "h_1" },
      };
    });
    const journal = new InMemoryMediaJobJournal();
    const multix = new MultixProvider({ bin: "multix", runner: cli.runner, journal });
    const result = await multix.generate(ctx, voiceRequest());
    const tts = cli.calls[1]!.argv;
    expect(tts.slice(0, 4)).toEqual([
      "elevenlabs",
      "tts",
      "--text=Xin chào Studix",
      "--model=eleven_multilingual_v2",
    ]);
    expect(tts).toContain("--max-cost=0.10");
    expect(result).toMatchObject({
      model: "elevenlabs:eleven_multilingual_v2",
      costCents: 1,
      costSource: "estimate",
    });
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({ mime: "audio/mpeg" });
    expect(await readFile(result.outputs[0]!.filePath, "utf8")).toBe("mp3");
    // multix's duplicate copy is not kept.
    await expect(stat(cli.calls[1]!.options.env.MULTIX_OUTPUT_DIR!)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const again = await multix.generate(ctx, voiceRequest());
    expect(again.outputs).toEqual(result.outputs);
    expect(cli.calls).toHaveLength(2);
  });

  it("prices SFX from the assumed ceiling when multix has no estimator", async () => {
    const cli = scriptedCli(() => {
      throw new Error("no CLI call expected");
    });
    const multix = new MultixProvider({ bin: "multix", runner: cli.runner });
    await expect(
      multix.estimateCostCents({
        kind: "sfx",
        prompt: "door slam",
        maxCostCents: 10,
        params: { durationMs: 2000 },
      }),
    ).resolves.toBe(2);
    await expect(
      multix.estimateCostCents({ kind: "sfx", prompt: "door slam", maxCostCents: 50 }),
    ).resolves.toBe(30);
  });
});
