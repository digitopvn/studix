import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCompositionService,
  type JobQueue,
  loadCompositionManifest,
  mergeManifest,
  type TenantContext,
} from "@studix/core";
import { createLogger } from "@studix/shared";
import { InMemoryStorageAdapter } from "@studix/storage";
import { describe, expect, it } from "vitest";
import { compositionCheckProblems, createCompositionRunner } from "../src/composition-runner.ts";
import type { SkillSandbox } from "../src/skill-sandbox.ts";

const file = (path: string) => ({ path, bytes: 1, sha256: "x", contentType: "text/plain" });

describe("composition runs", () => {
  it("lists every way a render misses its output check", () => {
    const check = {
      path: "out/v.mp4",
      width: 1920,
      height: 1080,
      durationMs: 10_000,
      durationToleranceMs: 500,
    };
    expect(
      compositionCheckProblems(check, { width: 1920, height: 1080, durationMs: 10_200 }, undefined),
    ).toEqual([]);
    const problems = compositionCheckProblems(
      { ...check, loudnessLufs: -16 },
      { width: 1280, height: 720, durationMs: 12_000, audioCodec: "aac" },
      { integratedLufs: -23, truePeakDbtp: 0 } as never,
    );
    expect(problems).toHaveLength(5);
  });

  it("merges run output into the manifest, keeping files written meanwhile", () => {
    const manifest = { id: "cmp_1", files: [file("index.html"), file("old.png")] } as never;
    const merged = mergeManifest(manifest, [file("out/video.mp4")], ["old.png"]);
    expect(merged.files.map((f) => f.path).sort()).toEqual(["index.html", "out/video.mp4"]);
  });
});

/** A sandbox over a map of files, answering the few calls the runner makes (copy in, stamp, exec, find, copy out). */
function fakeSandbox(
  commands: Record<string, (fs: Map<string, { bytes: Buffer; t: number }>, t: () => number) => void>,
) {
  let clock = 0;
  const tick = () => ++clock;
  let stamp = 0;
  const fs = new Map<string, { bytes: Buffer; t: number }>();
  const session = {
    async run(argv: readonly string[], options?: { stdin?: Buffer | string }) {
      if (argv[0] === "find") {
        const listed = [...fs].filter(([, f]) => f.t > stamp).map(([path]) => path.slice("/work/c/".length));
        return Buffer.from(listed.map((p) => `${p}\n`).join(""));
      }
      const script = argv[2] ?? "";
      if (script.includes("touch")) stamp = tick();
      else fs.set(argv[4] as string, { bytes: Buffer.from(options?.stdin ?? ""), t: tick() });
      return Buffer.alloc(0);
    },
    async exec(command: string) {
      commands[command]?.(fs, tick);
      return { exitCode: 0 };
    },
    async copyOut(containerPath: string, hostPath: string) {
      await writeFile(hostPath, fs.get(containerPath)?.bytes ?? Buffer.alloc(0));
    },
  };
  const sandbox = {
    forStage: () => ({ open: async () => ({ sandbox: session, close: async () => undefined }) }),
    status: () => ({}),
  } as unknown as SkillSandbox;
  return { sandbox, fs };
}

describe("files kept between composition runs", () => {
  it("stores what a run adds, skips installs, caches and hidden files, and shows it to the next run", async () => {
    const ctx: TenantContext = {
      organizationId: "org_1",
      workspaceId: "wsp_1",
      actor: { type: "user", id: "usr_1", role: "editor" },
    };
    const storage = new InMemoryStorageAdapter();
    const service = createCompositionService({
      storage,
      queue: {} as JobQueue,
      audit: { append: async () => undefined } as never,
      defaults: { jobBudgetCents: 0 },
    });
    const { id } = await service.write(ctx, { files: [{ path: "index.html", text: "<html></html>" }] });
    const put = (fs: Map<string, { bytes: Buffer; t: number }>, t: () => number, path: string) =>
      fs.set(`/work/c/${path}`, { bytes: Buffer.from(path), t: t() });
    const { sandbox, fs } = fakeSandbox({
      init: (files, t) => {
        for (const path of [
          "my-video/package.json",
          "my-video/src/index.html",
          "my-video/node_modules/dep/index.js",
          "my-video/.cache/x",
          ".env",
          "bad name.txt",
        ]) {
          put(files, t, path);
        }
      },
      "cat my-video/package.json": () => undefined,
    });
    const workDir = mkdtempSync(join(tmpdir(), "studix-cmp-"));
    try {
      const runner = createCompositionRunner({
        sandbox,
        storage,
        workDir,
        logger: createLogger({}, { level: "error", write: () => {} }),
      });
      const stage = { ctx, job: { id: "job_1" }, attempt: 1, signal: new AbortController().signal } as never;
      const request = (command: string) => ({ compositionId: id, command, timeoutSeconds: 60 });

      const first = await runner.run(stage, request("init"));
      // Only what the command wrote is `changed`: the file written beforehand is stored already and untouched.
      expect(first.changed.map((f) => f.path).sort()).toEqual([
        "my-video/package.json",
        "my-video/src/index.html",
      ]);
      expect((await loadCompositionManifest(storage, ctx, id)).files.map((f) => f.path)).toEqual([
        "index.html",
        "my-video/package.json",
        "my-video/src/index.html",
      ]);

      // A fresh sandbox for the second run: nothing survives in it except the stored files.
      fs.clear();
      const second = await runner.run(stage, request("cat my-video/package.json"));
      expect(second.changed).toEqual([]);
      expect([...fs.keys()].sort()).toEqual([
        "/work/c/index.html",
        "/work/c/my-video/package.json",
        "/work/c/my-video/src/index.html",
      ]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
