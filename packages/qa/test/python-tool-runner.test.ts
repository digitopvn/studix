import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudixError } from "@studix/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ProbeInput,
  QA_TOOLS,
  type QaTool,
  type QaToolchain,
  runPythonTool,
  runQaTool,
} from "../src/index.ts";

const fake: QaToolchain = {
  python: process.execPath,
  args: [join(import.meta.dirname, "fixtures", "fake-qa-tool.mjs")],
};

let dir: string;
let media: string;
let sandboxRoot: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "studix-qa-runner-"));
  media = join(dir, "clip.mp4");
  await writeFile(media, "media");
  sandboxRoot = join(dir, "sandboxes");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = (tool: string, extra: Partial<Parameters<typeof runPythonTool>[2]> = {}) =>
  runPythonTool(tool, { x: 1 }, { toolchain: fake, timeoutMs: 10_000, sandboxRoot, ...extra });

async function rejection(promise: Promise<unknown>): Promise<StudixError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StudixError);
  return err as StudixError;
}

describe("runPythonTool sandbox", () => {
  it("passes the request on stdin and runs in a private, removed sandbox with a scrubbed environment", async () => {
    process.env.STUDIX_TEST_SECRET = "s3cret";
    process.env.DATABASE_URL_TEST = "postgres://secret";
    try {
      const { result } = await run("echo", {
        media: { clip: media },
        ffmpegPath: "/opt/ffmpeg",
        extraEnv: { STUDIX_QA_DEPTH_MODEL: "/models/depth" },
      });
      const r = result as {
        request: { input: unknown; media: Record<string, string>; timeoutS: number };
        cwd: string;
        env: Record<string, string>;
        out: string;
      };
      expect(r.request.input).toEqual({ x: 1 });
      expect(r.request.timeoutS).toBe(10);
      expect(Object.keys(r.request.media)).toEqual(["clip"]);
      expect(r.cwd.startsWith(sandboxRoot)).toBe(true);
      expect(r.env.HOME).toBe(r.cwd);
      expect(r.env.TMPDIR).toBe(r.cwd);
      expect(r.env.FFMPEG_PATH).toBe("/opt/ffmpeg");
      expect(r.env.STUDIX_QA_DEPTH_MODEL).toBe("/models/depth");
      expect(r.env.HF_HUB_OFFLINE).toBe("1");
      expect(r.env.STUDIX_TEST_SECRET).toBeUndefined();
      expect(r.env.DATABASE_URL_TEST).toBeUndefined();
      expect(existsSync(r.cwd)).toBe(false);
      expect(await readdir(sandboxRoot)).toEqual([]);
    } finally {
      delete process.env.STUDIX_TEST_SECRET;
      delete process.env.DATABASE_URL_TEST;
    }
  });

  it("refuses extra env that could carry a secret", async () => {
    const err = await rejection(run("echo", { extraEnv: { ANTHROPIC_API_KEY: "x" } }));
    expect(err.code).toBe("VALIDATION");
  });

  it("validates grants: absolute, existing, regular files with safe ids", async () => {
    expect((await rejection(run("echo", { media: { clip: "clip.mp4" } }))).code).toBe("VALIDATION");
    expect((await rejection(run("echo", { media: { clip: join(dir, "missing.mp4") } }))).code).toBe("NOT_FOUND");
    expect((await rejection(run("echo", { media: { clip: dir } }))).code).toBe("VALIDATION");
    expect((await rejection(run("echo", { media: { "../x": media } }))).code).toBe("VALIDATION");
  });

  it("kills a tool past its deadline and still removes the sandbox", async () => {
    const started = Date.now();
    const err = await rejection(run("sleep", { timeoutMs: 200, killGraceMs: 100 }));
    expect(err.code).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await readdir(sandboxRoot)).toEqual([]);
  });

  it("stops on abort with CANCELLED", async () => {
    const controller = new AbortController();
    const pending = run("sleep", { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    expect((await rejection(pending)).code).toBe("CANCELLED");
  });

  it("maps tool errors and rejects answers that are not the JSON envelope", async () => {
    const failed = await rejection(run("fail"));
    expect(failed.code).toBe("NOT_FOUND");
    expect(failed.details).toMatchObject({ tool: "fail", media: "a" });
    expect((await rejection(run("odd-code"))).code).toBe("INTERNAL");
    expect((await rejection(run("garbage"))).code).toBe("INTERNAL");
    expect((await rejection(run("huge", { maxStdoutBytes: 1024 }))).code).toBe("INTERNAL");
  });

  it("copies tool outputs to outputDir, and discards them without one", async () => {
    const outputDir = join(dir, "maps");
    const { outputs } = await run("write", { outputDir });
    expect(outputs).toEqual([join(outputDir, "a.depth.png")]);
    expect(await readFile(outputs[0]!, "utf8")).toBe("png");
    expect((await run("write")).outputs).toEqual([]);
  });

  it("reports a missing interpreter as UNAVAILABLE", async () => {
    const err = await rejection(
      runPythonTool("probe", {}, { toolchain: { python: join(dir, "no-python"), args: [] }, timeoutMs: 1000 }),
    );
    expect(err.code).toBe("UNAVAILABLE");
  });
});

describe("runQaTool contracts", () => {
  it("rejects invalid input before starting anything", async () => {
    await mkdir(sandboxRoot, { recursive: true });
    const err = await rejection(
      runQaTool(QA_TOOLS.loudness, { media: "../etc" } as never, { toolchain: fake, sandboxRoot }),
    );
    expect(err.code).toBe("VALIDATION");
  });

  it("requires a grant for every referenced media id", async () => {
    const err = await rejection(runQaTool(QA_TOOLS.probe, { media: "clip" }, { toolchain: fake, sandboxRoot }));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("without a grant");
  });

  it("treats an answer outside the output schema as a broken contract", async () => {
    const err = await rejection(
      runQaTool(QA_TOOLS.probe, { media: "clip" }, { toolchain: fake, sandboxRoot, media: { clip: media } }),
    );
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toContain("output contract");
  });

  it("grants a tool only the media its input references", async () => {
    const other = join(dir, "other.wav");
    await writeFile(other, "x");
    // The echo fake answers with the request it received.
    const echo: QaTool<typeof ProbeInput, z.ZodType<{ request: { media: Record<string, string> } }>> = {
      ...QA_TOOLS.probe,
      name: "echo",
      output: z.looseObject({ request: z.looseObject({ media: z.record(z.string(), z.string()) }) }),
    };
    const { result } = await runQaTool(
      echo,
      { media: "clip" },
      { toolchain: fake, sandboxRoot, media: { clip: media, other } },
    );
    expect(Object.keys(result.request.media)).toEqual(["clip"]);
  });
});
