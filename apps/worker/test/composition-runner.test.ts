import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCompositionFits,
  COMPOSITION_LIMITS,
  compositionCountAfter,
  compositionFileKey,
  compositionManifestKey,
  mergeManifest,
} from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { describe, expect, it } from "vitest";
import { compositionCheckProblems, createCompositionRunner } from "../src/composition-runner.ts";

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

describe("composition run limits", () => {
  const ctx = testTenant();
  const id = "cmp_limit01";

  function setup(existing: string[], produced: string[]) {
    const store = new Map<string, Uint8Array>();
    const puts: string[] = [];
    const manifest = {
      id,
      files: existing.map((p) => ({ ...file(p), sha256: "old" })),
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    store.set(compositionManifestKey(id), new TextEncoder().encode(JSON.stringify(manifest)));
    for (const p of existing) store.set(compositionFileKey(id, p), new TextEncoder().encode("old"));
    const storage = {
      async put(_c: unknown, key: string, body: unknown) {
        puts.push(key);
        const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode("new");
        store.set(key, bytes);
        return {} as never;
      },
      async get(_c: unknown, key: string) {
        const bytes = store.get(key) as Uint8Array;
        return {
          body: new Response(bytes as BlobPart).body as ReadableStream<Uint8Array>,
          contentType: "x",
          bytes: bytes.length,
        };
      },
      async head(_c: unknown, key: string) {
        return store.has(key) ? ({} as never) : undefined;
      },
    };
    const box = {
      async run(argv: string[]) {
        if (argv[0] === "find")
          return Buffer.from(
            produced.map((p) => `${p.startsWith("big/") ? 2_000_000_000 : 3} ${p}\n`).join(""),
          );
        return Buffer.alloc(0);
      },
      async exec() {
        return { exitCode: 0 };
      },
      async copyOut(_from: string, to: string) {
        await writeFile(to, "new");
      },
    };
    const sandbox = {
      forStage: () => ({ open: async () => ({ sandbox: box, close: async () => undefined }) }),
    };
    const runner = createCompositionRunner({
      sandbox: sandbox as never,
      storage: storage as never,
      workDir: join(tmpdir(), `studix-cmp-${process.pid}`),
      logger: { child: () => ({ info() {} }) } as never,
    });
    const stage = { ctx, job: { id: "job_x" }, signal: new AbortController().signal } as never;
    return { runner, stage, store, puts };
  }

  it("leaves the composition untouched when the run would exceed the file cap", async () => {
    const existing = Array.from({ length: COMPOSITION_LIMITS.files - 1 }, (_, i) => `f${i}.txt`);
    const { runner, stage, store, puts } = setup(existing, ["f0.txt", "new-a.txt", "new-b.txt"]);
    const before = new TextDecoder().decode(store.get(compositionManifestKey(id)));
    await expect(
      runner.run(stage, { compositionId: id, command: "true", timeoutSeconds: 60 } as never),
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(puts).toEqual([]);
    expect(new TextDecoder().decode(store.get(compositionFileKey(id, "f0.txt")))).toBe("old");
    expect(new TextDecoder().decode(store.get(compositionManifestKey(id)))).toBe(before);
  });

  it("stores the run when it fits, counting overwritten paths once", async () => {
    const existing = Array.from({ length: COMPOSITION_LIMITS.files - 1 }, (_, i) => `f${i}.txt`);
    const { runner, stage, puts } = setup(existing, ["f0.txt", "new-a.txt"]);
    const result = await runner.run(stage, {
      compositionId: id,
      command: "true",
      timeoutSeconds: 60,
    } as never);
    expect(result.changed.map((c) => c.path)).toEqual(["f0.txt", "new-a.txt"]);
    expect(puts).toContain(compositionFileKey(id, "new-a.txt"));
    expect(result.log).not.toContain("not stored");
  });

  it("names files it does not store and keeps the log when a run is refused", async () => {
    const { runner, stage, puts } = setup(
      Array.from({ length: COMPOSITION_LIMITS.files }, (_, i) => `f${i}.txt`),
      ["big/movie.mp4", "new-a.txt"],
    );
    const err = await runner
      .run(stage, { compositionId: id, command: "true", timeoutSeconds: 60 } as never)
      .catch((e) => e);
    expect(err).toMatchObject({ code: "VALIDATION" });
    expect(err.message).toContain("stored none");
    expect(JSON.stringify(err.details)).toContain("big/movie.mp4");
    expect(puts).toEqual([]);
  });
});

describe("composition file cap", () => {
  it("counts an overwritten path once and refuses past the cap", () => {
    const files = [file("a.txt"), file("b.txt")];
    expect(compositionCountAfter({ files }, ["a.txt", "c.txt"])).toBe(3);
    expect(() => assertCompositionFits(COMPOSITION_LIMITS.files)).not.toThrow();
    expect(() => assertCompositionFits(COMPOSITION_LIMITS.files + 1)).toThrow(/at most/);
  });
});
