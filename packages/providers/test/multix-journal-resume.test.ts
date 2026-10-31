import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MediaGenerationRequest, MediaJobRecord } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryMediaJobJournal,
  MultixProvider,
  type MultixRunner,
  type MultixRunOptions,
  type MultixRunResult,
} from "../src/index.ts";

/**
 * A retried workflow stage hands the provider its durable stage journal. When that journal already holds a
 * `submitted` record, the provider must collect the paid upstream job and never submit it again.
 */

const ctx = testTenant();
const KEY = "stage-1:image";
const MODEL = "sume:nano-banana-2.1";

interface Reply {
  exitCode?: number;
  envelope?: Record<string, unknown>;
  stoppedBy?: MultixRunResult["stoppedBy"];
  files?: Record<string, string>;
}

/** Scripted multix CLI: answers each argv and records every call, as the real child process would be run. */
function scriptedCli(handler: (argv: readonly string[]) => Reply) {
  const calls: { argv: readonly string[]; options: MultixRunOptions }[] = [];
  const runner: MultixRunner = async (argv, options) => {
    calls.push({ argv: [...argv], options });
    const reply = handler(argv);
    for (const [path, content] of Object.entries(reply.files ?? {})) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    const stdout = reply.envelope
      ? `${JSON.stringify({ schema: "multix.result/v1", ok: (reply.exitCode ?? 0) === 0, ...reply.envelope })}\n`
      : "";
    return {
      exitCode: reply.exitCode ?? 0,
      stdout,
      ...(reply.stoppedBy ? { stoppedBy: reply.stoppedBy } : {}),
    };
  };
  return { runner, calls, commands: () => calls.map((c) => c.argv.slice(0, 2).join(" ")) };
}

const flagValue = (argv: readonly string[], name: string) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** The journal a first attempt leaves behind after Sume accepted job_1 and the worker then lost it. */
function submittedRecord(): MediaJobRecord {
  const at = "2026-10-31T07:00:00.000Z";
  return {
    idempotencyKey: KEY,
    kind: "image",
    model: MODEL,
    job: { provider: "sume", id: "job_1" },
    attempt: 1,
    state: "submitted",
    estimatedCostCents: 4,
    submittedAt: at,
    updatedAt: at,
  };
}

/** Sume status: the finished job downloads one PNG and reports a 3 cent charge. */
function finishedStatus(argv: readonly string[]): Reply {
  const out = join(flagValue(argv, "output")!, "image-1.png");
  return {
    files: { [out]: "png-bytes" },
    envelope: {
      outputs: [{ path: out, mime: "image/png", width: 1344, height: 768 }],
      cost: { actual_usd: 0.03, actual_source: "provider" },
    },
  };
}

describe("MultixProvider resumes a submitted journal record", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), "studix-multix-resume-")));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const request = (journal: InMemoryMediaJobJournal): MediaGenerationRequest => ({
    kind: "image",
    prompt: "a lighthouse at dusk",
    idempotencyKey: KEY,
    maxCostCents: 100,
    workDir,
    params: { aspectRatio: "16:9" },
    journal,
  });

  it("collects the upstream job from the stage journal without submitting or paying again", async () => {
    const stageJournal = new InMemoryMediaJobJournal();
    await stageJournal.put(ctx, submittedRecord());
    const cli = scriptedCli((argv) => {
      if (argv[0] === "sume" && argv[1] === "status") return finishedStatus(argv);
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    // A fresh worker: its own journal is empty, so only the stage journal knows about job_1.
    const worker = new MultixProvider({ bin: "multix", runner: cli.runner });

    const result = await worker.generate(ctx, request(stageJournal));

    expect(cli.commands()).toEqual(["sume status"]);
    expect(cli.calls.some((c) => c.argv.includes("--estimate") || c.argv[1] === "image")).toBe(false);
    expect(result).toMatchObject({
      model: MODEL,
      costCents: 3,
      costSource: "receipt",
      job: { provider: "sume", id: "job_1" },
    });
    expect(await stageJournal.get(ctx, KEY)).toMatchObject({
      state: "completed",
      attempt: 1,
      job: { id: "job_1" },
      receiptCents: 3,
    });
  });

  it("keeps the submitted record while the upstream is still running, then collects it on the next retry", async () => {
    const stageJournal = new InMemoryMediaJobJournal();
    await stageJournal.put(ctx, submittedRecord());
    let statusCalls = 0;
    const cli = scriptedCli((argv) => {
      if (argv[0] === "sume" && argv[1] === "status") {
        statusCalls += 1;
        return statusCalls === 1 ? { stoppedBy: "timeout", exitCode: 143 } : finishedStatus(argv);
      }
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    const worker = new MultixProvider({ bin: "multix", runner: cli.runner });

    const error = await worker.generate(ctx, request(stageJournal)).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: "TIMEOUT", details: { job: { provider: "sume", id: "job_1" } } });
    expect(await stageJournal.get(ctx, KEY)).toMatchObject({ state: "submitted", job: { id: "job_1" } });

    const result = await worker.generate(ctx, request(stageJournal));
    expect(result).toMatchObject({ job: { id: "job_1" }, costCents: 3, costSource: "receipt" });
    expect(cli.commands()).toEqual(["sume status", "sume status"]);
    expect(await stageJournal.get(ctx, KEY)).toMatchObject({ state: "completed", receiptCents: 3 });
  });
});
