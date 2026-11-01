import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TenantContext } from "@studix/core";
import { InMemoryMediaJobJournal, MultixProvider, type MultixRunner } from "@studix/providers";
import type { StageContext } from "@studix/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateStoredMedia, type StoredMediaRequest } from "../src/stored-media.ts";

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studix-stored-media-journal-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const flag = (argv: readonly string[], name: string) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** A worker whose Multix CLI is scripted; wiping `root` models a restarted pod losing its scratch disk. */
function worker() {
  const execs: string[][] = [];
  const runner: MultixRunner = async (argv) => {
    const envelope = (body: Record<string, unknown>) =>
      `${JSON.stringify({ schema: "multix.result/v1", ok: true, ...body })}\n`;
    if (argv.includes("--estimate")) {
      return { exitCode: 0, stdout: envelope({ estimate: { status: "estimated", high_usd: 0.002 } }) };
    }
    execs.push([...argv]);
    const out = flag(argv, "output") as string;
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, "mp3");
    return { exitCode: 0, stdout: envelope({ outputs: [{ path: out }], history_id: "h_1" }) };
  };
  const objects = new Map<string, string>();
  const storage = {
    put: async (_c: TenantContext, key: string, body: { filePath: string }) => {
      const sha256 = createHash("sha256")
        .update(await readFile(body.filePath))
        .digest("hex");
      objects.set(key, sha256);
      return { key, sha256, bytes: 3 };
    },
    head: async (_c: TenantContext, key: string) => {
      const sha256 = objects.get(key);
      return sha256 ? { key, sha256, bytes: 3, contentType: "" } : undefined;
    },
  };
  const media = new MultixProvider({ bin: "multix", runner });
  const journal = new InMemoryMediaJobJournal();
  const stage = (): StageContext =>
    ({
      ctx,
      job: { id: "job_1" },
      attempt: 1,
      signal: new AbortController().signal,
      mediaJournal: journal,
      services: { media, storage, workRoot: root },
    }) as unknown as StageContext;
  return { stage, execs, objects };
}

const voice = (over: Partial<StoredMediaRequest> = {}): StoredMediaRequest => ({
  assetId: "l1-vo",
  kind: "voice",
  prompt: "Xin chào Studix",
  keyPrefix: "generated/job_1/dialogue/l1",
  maxCostCents: 10,
  ...over,
});

describe("synchronous audio after the scratch directory is lost", () => {
  it("does not call the upstream a second time when the stored output is still in storage", async () => {
    const w = worker();
    const first = await generateStoredMedia(w.stage(), "dialogue", voice());
    expect(w.execs).toHaveLength(1);

    await rm(root, { recursive: true, force: true });
    const again = await generateStoredMedia(w.stage(), "dialogue", voice());

    expect(w.execs).toHaveLength(1);
    expect(again.asset).toEqual(first.asset);
    expect(again.filePath).toBeUndefined();
    // Same upstream job and cost, so the ledger keeps one usage line for the one paid call.
    expect(again.usage).toEqual(first.usage);
  });

  it("pays again when the request changed", async () => {
    const w = worker();
    await generateStoredMedia(w.stage(), "dialogue", voice());
    await rm(root, { recursive: true, force: true });
    await generateStoredMedia(w.stage(), "dialogue", voice({ prompt: "Một câu khác" }));
    expect(w.execs).toHaveLength(2);
  });

  it("pays again when the stored object is gone or no longer matches", async () => {
    const w = worker();
    await generateStoredMedia(w.stage(), "dialogue", voice());
    await rm(root, { recursive: true, force: true });
    w.objects.set("generated/job_1/dialogue/l1.mp3", "0".repeat(64));
    await generateStoredMedia(w.stage(), "dialogue", voice());
    expect(w.execs).toHaveLength(2);
  });
});

describe("with the cross-job output cache enabled", () => {
  it("bills the retry through the journal, not as a free cache hit", async () => {
    const w = worker();
    const entries = new Map<string, { asset: unknown; jobId: string }>();
    const stage = (): StageContext => {
      const s = w.stage() as unknown as Record<string, unknown>;
      return {
        ...s,
        mediaOutputs: {
          get: async (k: string) => entries.get(k),
          put: async (k: string, asset: unknown) => {
            entries.set(k, { asset, jobId: "job_1" });
          },
        },
      } as unknown as StageContext;
    };
    const first = await generateStoredMedia(stage(), "dialogue", voice({ reuse: {} }));
    await rm(root, { recursive: true, force: true });
    const again = await generateStoredMedia(stage(), "dialogue", voice({ reuse: {} }));
    expect(w.execs).toHaveLength(1);
    expect(again.usage).toEqual(first.usage);
    expect(again.usage.costCents).toBeGreaterThan(0);
  });
});

describe("a call whose own job already cached an output", () => {
  const cachedStage = (
    w: ReturnType<typeof worker>,
    entries: Map<string, { asset: unknown; jobId: string }>,
  ) =>
    ({
      ...(w.stage() as unknown as Record<string, unknown>),
      mediaOutputs: {
        get: async (k: string) => entries.get(k),
        put: async (k: string, asset: unknown) => {
          entries.set(k, { asset, jobId: "job_1" });
        },
      },
    }) as unknown as StageContext;

  it("pays the first attempt instead of serving it the regeneration's output as a free hit", async () => {
    const w = worker();
    const entries = new Map<string, { asset: unknown; jobId: string }>();
    // The regeneration is stored under the same content key; the first attempt's own record is gone.
    const regenerated = await generateStoredMedia(
      cachedStage(w, entries),
      "dialogue",
      voice({ reuse: {}, retry: 1 }),
    );
    expect(regenerated.usage.item).toBe("media-l1-vo-r1");

    const first = await generateStoredMedia(cachedStage(w, entries), "dialogue", voice({ reuse: {} }));

    expect(w.execs).toHaveLength(2);
    expect(first.reusedFrom).toBeUndefined();
    expect(first.usage.item).toBe("media-l1-vo");
    expect(first.usage.costCents).toBeGreaterThan(0);
  });
});

describe("a file left on disk by an earlier request under the same key", () => {
  it("is not returned for a request whose prompt changed", async () => {
    const w = worker();
    const old = await generateStoredMedia(w.stage(), "dialogue", voice());
    const changed = await generateStoredMedia(w.stage(), "dialogue", voice({ prompt: "Một câu khác" }));
    expect(w.execs).toHaveLength(2);
    expect(changed.filePath).not.toBe(old.filePath);
  });
});

describe("two assets of one job with identical content", () => {
  it("still share one paid call", async () => {
    const w = worker();
    const entries = new Map<string, { asset: unknown; jobId: string }>();
    const stage = () =>
      ({
        ...(w.stage() as unknown as Record<string, unknown>),
        mediaOutputs: {
          get: async (k: string) => entries.get(k),
          put: async (k: string, asset: unknown) => {
            entries.set(k, { asset, jobId: "job_1" });
          },
        },
      }) as unknown as StageContext;
    await generateStoredMedia(stage(), "dialogue", voice({ reuse: {}, assetId: "a" }));
    const second = await generateStoredMedia(stage(), "dialogue", voice({ reuse: {}, assetId: "b" }));
    expect(w.execs).toHaveLength(1);
    expect(second.reusedFrom).toEqual({ jobId: "job_1" });
  });
});
