import { mkdtempSync, rmSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPOSITION_LIMITS,
  compositionFileKey,
  createCompositionService,
  loadCompositionManifest,
  type TenantContext,
} from "@studix/core";
import { createLogger } from "@studix/shared";
import { InMemoryStorageAdapter } from "@studix/storage";
import type { StageContext } from "@studix/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCompositionRunner } from "../src/composition-runner.ts";
import type { SkillSandbox } from "../src/skill-sandbox.ts";

/*
 * Each composition.run opens a fresh sandbox: the only thing that survives from one run to the next is the
 * composition's stored files. This pins that contract with a fake sandbox that keeps /work/c in memory and
 * is thrown away when the run closes.
 */

const ROOT = "/work/c/";

type Script = (fs: FakeFs) => void;

/** An in-memory /work/c: every write gets a version so "newer than the stamp" works without clocks. */
class FakeFs {
  files = new Map<string, { bytes: Buffer; version: number }>();
  version = 0;
  stamp = 0;
  write(path: string, content: string | Buffer) {
    this.files.set(path, { bytes: Buffer.from(content), version: ++this.version });
  }
}

function fakeSandbox(scripts: Map<string, Script>): SkillSandbox {
  return {
    status: () => ({}) as never,
    forStage: () =>
      ({
        async open() {
          const fs = new FakeFs();
          const sandbox = {
            async run(argv: readonly string[], options?: { stdin?: Buffer | string }) {
              if (argv[0] === "find") {
                const listed = [...fs.files]
                  .filter(([, f]) => f.version > fs.stamp)
                  .map(([p, f]) => `${f.bytes.length} ${p.slice(ROOT.length)}`);
                return Buffer.from(listed.map((line) => `${line}\n`).join(""));
              }
              const text = argv.join(" ");
              if (text.includes("touch")) fs.stamp = fs.version;
              else if (text.includes("cat >")) fs.write(argv[4] as string, options?.stdin ?? "");
              return Buffer.alloc(0);
            },
            async exec(command: string, options?: { onData?: (chunk: Buffer) => void }) {
              const script = scripts.get(command);
              if (!script) throw new Error(`no script for ${command}`);
              script(fs);
              options?.onData?.(Buffer.from([...fs.files.keys()].join("\n")));
              return { exitCode: 0 };
            },
            async copyOut(containerPath: string, hostPath: string) {
              const file = fs.files.get(containerPath);
              if (!file) throw new Error(`no such file ${containerPath}`);
              await writeFile(hostPath, file.bytes);
            },
            copyIn: async (from: string, to: string) => copyFile(from, to),
            close: async () => undefined,
            id: "fake",
          };
          return { sandbox, close: async () => undefined };
        },
      }) as never,
  };
}

describe("files that persist between composition runs", () => {
  const ctx: TenantContext = {
    organizationId: "org_cmp",
    workspaceId: "wsp_cmp",
    actor: { type: "user", id: "usr_cmp", role: "editor" },
  };
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "studix-cmp-"));
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  it("keeps what a run wrote (but not dependency folders) for the next run (the fake opens a new sandbox per run)", async () => {
    const storage = new InMemoryStorageAdapter();
    const service = createCompositionService({
      storage,
      queue: {} as never,
      audit: { append: async () => undefined } as never,
      defaults: { jobBudgetCents: 0 },
    });
    const written = await service.write(ctx, { files: [{ path: "index.html", text: "<html></html>" }] });
    const id = written.id;

    const scripts = new Map<string, Script>([
      [
        "init",
        (fs) => {
          fs.write(`${ROOT}my-video/index.html`, "<h1>generated</h1>");
          fs.write(`${ROOT}node_modules/dep/index.js`, "module.exports = 1");
          fs.write(`${ROOT}sub/node_modules/x/y.js`, "nested dependency");
          fs.write(`${ROOT}sub/${"__py"}cache__/x.pyc`, "bytecode");
          fs.write(`${ROOT}.hidden/blob`, "hidden");
          fs.write(`${ROOT}scratch/with space.txt`, "unstorable name");
        },
      ],
      ["read-only", () => undefined],
      [
        "remove",
        (fs) => {
          fs.files.delete(`${ROOT}index.html`);
        },
      ],
    ]);
    const runner = createCompositionRunner({
      sandbox: fakeSandbox(scripts),
      storage,
      workDir,
      logger: createLogger({}, { level: "error", write: () => {} }),
    });
    const stage = { ctx, job: { id: "job_cmp" }, signal: new AbortController().signal } as StageContext;
    const request = (command: string) => ({ compositionId: id, command, timeoutSeconds: 60 });

    // Run 1: only the generated project comes back; the written file was copied in and is unchanged.
    const first = await runner.run(stage, request("init"));
    expect(first.changed.map((f) => f.path)).toEqual(["my-video/index.html"]);
    const afterFirst = await loadCompositionManifest(storage, ctx, id);
    expect(afterFirst.files.map((f) => f.path)).toEqual(["index.html", "my-video/index.html"]);

    // Run 2: a new sandbox. Both stored files are there again, the dependency and cache folders are not,
    // and a run that changes nothing stores nothing.
    const seen: string[] = [];
    scripts.set("read-only", (fs) => seen.push(...[...fs.files.keys()].map((p) => p.slice(ROOT.length))));
    const second = await runner.run(stage, request("read-only"));
    expect(seen.sort()).toEqual(["index.html", "my-video/index.html"]);
    expect(second.changed).toEqual([]);
    const body = await storage.get(ctx, compositionFileKey(id, "my-video/index.html"));
    expect(await new Response(body.body).text()).toBe("<h1>generated</h1>");

    // Run 3: deleting a file inside a run does not delete it from the composition.
    await runner.run(stage, request("remove"));
    const afterRemove = await loadCompositionManifest(storage, ctx, id);
    expect(afterRemove.files.map((f) => f.path)).toContain("index.html");
  });

  it("fails a run that would pass the file cap without touching stored files", async () => {
    const storage = new InMemoryStorageAdapter();
    const service = createCompositionService({
      storage,
      queue: {} as never,
      audit: { append: async () => undefined } as never,
      defaults: { jobBudgetCents: 0 },
    });
    const { id } = await service.write(ctx, {
      files: Array.from({ length: COMPOSITION_LIMITS.files }, (_, i) => ({ path: `f${i}.txt`, text: "old" })),
    });
    const scripts = new Map<string, Script>([
      [
        "overflow",
        (fs) => {
          fs.write(`${ROOT}f0.txt`, "new");
          fs.write(`${ROOT}extra.txt`, "extra");
        },
      ],
    ]);
    const runner = createCompositionRunner({
      sandbox: fakeSandbox(scripts),
      storage,
      workDir,
      logger: createLogger({}, { level: "error", write: () => {} }),
    });
    const stage = { ctx, job: { id: "job_cap" }, signal: new AbortController().signal } as StageContext;
    await expect(
      runner.run(stage, { compositionId: id, command: "overflow", timeoutSeconds: 60 }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const kept = await storage.get(ctx, compositionFileKey(id, "f0.txt"));
    expect(await new Response(kept.body).text()).toBe("old");
    expect((await loadCompositionManifest(storage, ctx, id)).files).toHaveLength(COMPOSITION_LIMITS.files);
  });
});
