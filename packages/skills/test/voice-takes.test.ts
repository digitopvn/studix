import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MediaChargedError,
  type MediaGenerationRequest,
  type MediaProvider,
  type TenantContext,
} from "@studix/core";
import { InMemoryMediaJobJournal } from "@studix/providers";
import { StudixError } from "@studix/shared";
import type { AssetRef } from "@studix/video-ir";
import { type MediaOutputCache, type StageContext, StageFailedAfterSpend } from "@studix/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mediaOutputKey, type StoredMediaRequest } from "../src/stored-media.ts";
import { MAX_VOICE_DIRECTION_CHARS, MAX_VOICE_SPEEDUP, type VoiceLine } from "../src/voice-lines.ts";
import {
  generateVoiceTake,
  type MeasuredTake,
  measureVoiceTake,
  takeVoiceLine,
  VOICE_FIT_SCOPE,
  type VoiceTakeMeasure,
  voiceFitScope,
} from "../src/voice-takes.ts";

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};

/** The line that failed on production: 1800 ms of room for "Brief vào. Video ra.". */
const line: VoiceLine = {
  text: "Brief vào. Video ra.",
  startMs: 300,
  roomMs: 1800,
  part: "hook",
  instructions: "Line 1 of 3 of a short Vietnamese ad voice-over. Say it in under 1.8 seconds.",
};

const request: StoredMediaRequest = {
  assetId: "voiceover-1",
  kind: "voice",
  prompt: line.text,
  params: { language: "vi", instructions: line.instructions },
  keyPrefix: "generated/job_1/voiceover-1",
  maxCostCents: 10,
  reuse: { scope: VOICE_FIT_SCOPE },
};

/** A 2116 ms take with 200 ms of silence before the speech and 150 ms after it. */
const padded: MeasuredTake = { durationMs: 2116, startMs: 200, endMs: 1966 };
/** A take whose speech alone needs more than `MAX_VOICE_SPEEDUP` to fit 1800 ms. */
const tooLong: MeasuredTake = { durationMs: 2300, startMs: 0, endMs: 2300 };

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studix-voice-takes-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A stage whose speech provider returns `takes` in order (an error entry is thrown, after charging). Each
 * take file holds its index, which the measurer maps back to the take's measurement. Completed calls are
 * journaled like a synchronous provider does, so a second run on the same harness is a stage retry.
 */
function stage(takes: Array<MeasuredTake | MediaChargedError>, outputs?: MediaOutputCache) {
  const calls: MediaGenerationRequest[] = [];
  const journal = new InMemoryMediaJobJournal();
  const controller = new AbortController();
  const media: MediaProvider = {
    id: "multix",
    capabilities: async () => [],
    estimateCostCents: async () => 3,
    async generate(c, req) {
      const index = calls.push(req) - 1;
      const take = takes[index];
      if (!take) throw new Error(`unexpected take ${index + 1}`);
      if (take instanceof MediaChargedError) throw take;
      const filePath = join(req.workDir ?? root, `take-${index}.mp3`);
      await writeFile(filePath, String(index));
      const at = new Date().toISOString();
      await journal.put(c, {
        idempotencyKey: req.idempotencyKey,
        kind: req.kind,
        model: "elevenlabs:eleven_v3",
        attempt: 1,
        state: "completed",
        estimatedCostCents: 3,
        receiptCents: 3,
        submittedAt: at,
        updatedAt: at,
      });
      return {
        outputs: [{ filePath, mime: "audio/mpeg", durationMs: take.durationMs }],
        provider: "multix",
        model: "elevenlabs:eleven_v3",
        costCents: 3,
        latencyMs: 10,
      };
    },
  };
  const objects = new Map<string, Buffer>();
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const storage = {
    async put(_c: TenantContext, key: string, body: { filePath: string }) {
      const bytes = await readFile(body.filePath);
      objects.set(key, bytes);
      return { key, sha256: sha(bytes), bytes: bytes.length };
    },
    async head(_c: TenantContext, key: string) {
      const bytes = objects.get(key);
      return bytes ? { key, sha256: sha(bytes), bytes: bytes.length, contentType: "audio/mpeg" } : undefined;
    },
    async download(_c: TenantContext, key: string, filePath: string) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error(`no object ${key}`);
      await writeFile(filePath, bytes);
      return { sha256: sha(bytes), bytes: bytes.length };
    },
  };
  const measured: string[] = [];
  const hooks: { onMeasure?: (index: number) => void } = {};
  const measure: VoiceTakeMeasure = async (filePath) => {
    measured.push(filePath);
    const index = Number(await readFile(filePath, "utf8"));
    hooks.onMeasure?.(index);
    const take = takes[index];
    return take instanceof MediaChargedError ? undefined : take;
  };
  const s = {
    ctx,
    job: { id: "job_1" },
    attempt: 1,
    signal: controller.signal,
    mediaJournal: journal,
    ...(outputs ? { mediaOutputs: outputs } : {}),
    services: { media, storage, workRoot: root },
  } as unknown as StageContext;
  return { s, calls, objects, measure, measured, controller, hooks };
}

async function workDir(): Promise<string> {
  const dir = join(root, "work");
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("voicing a line", () => {
  it("lays a take whose silence makes it long, judged on its speech", async () => {
    const h = stage([padded]);
    const take = await generateVoiceTake(
      h.s,
      "voice",
      line,
      request,
      "vo-1-track",
      await workDir(),
      h.measure,
    );
    expect(h.calls).toHaveLength(1);
    // 200 ms of leading silence, less a 60 ms pad; 1826 ms of speech is read 1.015x into 1800 ms.
    expect(take.track).toMatchObject({
      assetId: "voiceover-1",
      startMs: 300,
      durationMs: 1800,
      trimStartMs: 140,
    });
    expect(take.track.playbackRate).toBeGreaterThan(1);
    expect(take.track.playbackRate).toBeLessThanOrEqual(MAX_VOICE_SPEEDUP);
    expect(take.usage.map((u) => u.item)).toEqual(["media-voiceover-1"]);
  });

  it("voices a line once more, brisker, when its take is too long, and bills both takes", async () => {
    const h = stage([tooLong, padded]);
    const take = await generateVoiceTake(
      h.s,
      "voice",
      line,
      request,
      "vo-1-track",
      await workDir(),
      h.measure,
    );
    expect(h.calls).toHaveLength(2);
    const [first, second] = h.calls;
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);
    expect(String(second?.params?.instructions)).toMatch(/^The previous read ran too long.*brisker/);
    expect(String(second?.params?.instructions)).toContain(line.instructions);
    // The turned-down take is never stored; the re-take has its own object.
    expect([...h.objects.keys()]).toEqual(["generated/job_1/voiceover-1-r1.mp3"]);
    expect(take.asset.storageKey).toBe("generated/job_1/voiceover-1-r1.mp3");
    expect(take.track.trimStartMs).toBe(140);
    expect(take.usage.map((u) => [u.item, u.costCents])).toEqual([
      ["media-voiceover-1", 3],
      ["media-voiceover-1-r1", 3],
    ]);
  });

  it("fails VALIDATION after a re-take that is still too long, billing both takes", async () => {
    const h = stage([tooLong, tooLong]);
    const err = await generateVoiceTake(h.s, "voice", line, request, "t", await workDir(), h.measure).catch(
      (e: unknown) => e,
    );
    expect(h.calls).toHaveLength(2);
    expect(err).toBeInstanceOf(StageFailedAfterSpend);
    const failed = err as StageFailedAfterSpend;
    expect(failed.error.code).toBe("VALIDATION");
    expect(failed.error.retryable).toBe(false);
    expect(failed.error.message).toMatch(/"Brief vào. Video ra." runs past its beat/);
    expect(failed.error.details).toMatchObject({ roomMs: 1800, durationMs: 2300, takes: 2 });
    expect(failed.usage.map((u) => u.item)).toEqual(["media-voiceover-1", "media-voiceover-1-r1"]);
    expect(h.objects.size).toBe(0);
  });

  it("measures a take served from storage, whose scratch file is gone, from the stored object", async () => {
    const stored: AssetRef = {
      id: "voiceover-1",
      kind: "audio",
      storageKey: "generated/job_0/voiceover-1.mp3",
      sha256: createHash("sha256").update("0").digest("hex"),
      mime: "audio/mpeg",
      durationMs: padded.durationMs,
      provenance: { source: "generated", provider: "multix" },
    };
    let key: string | undefined;
    const outputs: MediaOutputCache = {
      get: async (k) => (k === key ? { asset: stored, jobId: "job_0" } : undefined),
      put: async () => {},
    };
    const h = stage([padded], outputs);
    key = mediaOutputKey(h.s, request);
    h.objects.set(stored.storageKey as string, Buffer.from("0"));
    const dir = await workDir();
    const take = await generateVoiceTake(h.s, "voice", line, request, "t", dir, h.measure);
    expect(h.calls).toHaveLength(0);
    expect(h.measured).toEqual([join(dir, "voiceover-1-take.mp3")]);
    expect(take.track.trimStartMs).toBe(140);
    expect(take.usage.map((u) => u.costCents)).toEqual([0]);
  });

  it("starts a stage retry from the journaled re-take instead of paying for the first take again", async () => {
    const h = stage([tooLong, padded]);
    await generateVoiceTake(h.s, "voice", line, request, "t", await workDir(), h.measure);
    expect(h.calls).toHaveLength(2);
    // The retry's scratch file is gone: the re-take is measured from storage.
    await rm(join(root, "job_1"), { recursive: true, force: true });
    const again = await generateVoiceTake(h.s, "voice", line, request, "t", await workDir(), h.measure);
    expect(h.calls).toHaveLength(2);
    expect(again.asset.storageKey).toBe("generated/job_1/voiceover-1-r1.mp3");
    expect(again.track.trimStartMs).toBe(140);
    expect(again.usage.map((u) => [u.item, u.costCents])).toEqual([["media-voiceover-1-r1", 3]]);
  });

  it("retries from the kept first take, not a re-take stored after it, so a resumed attempt picks the same", async () => {
    // The first take (2.3 s) was kept for a re-timed graphic; the brisker re-take was paid for after it.
    const h = stage([tooLong, padded]);
    const room = { roomMs: 6000 };
    await takeVoiceLine(h.s, "voice", line, request, await workDir(), h.measure, room);
    await takeVoiceLine(h.s, "voice", line, request, await workDir(), h.measure, {
      ...room,
      briskerOnly: true,
    });
    expect(h.calls).toHaveLength(2);
    await rm(join(root, "job_1"), { recursive: true, force: true });
    const again = await takeVoiceLine(h.s, "voice", line, request, await workDir(), h.measure, room);
    expect(h.calls).toHaveLength(2);
    expect(again.asset.storageKey).toBe("generated/job_1/voiceover-1.mp3");
    expect(again.lengthMs).toBe(tooLong.durationMs);
  });

  it("starts from another job's stored re-take of the same line", async () => {
    const stored: AssetRef = {
      id: "voiceover-1",
      kind: "audio",
      storageKey: "generated/job_0/voiceover-1-r1.mp3",
      sha256: createHash("sha256").update("0").digest("hex"),
      mime: "audio/mpeg",
      durationMs: padded.durationMs,
      provenance: { source: "generated", provider: "multix" },
    };
    let firstKey: string | undefined;
    const outputs: MediaOutputCache = {
      // Only the re-take was ever stored: the first take was turned down.
      get: async (k) => (k !== firstKey ? { asset: stored, jobId: "job_0" } : undefined),
      put: async () => {},
    };
    const h = stage([padded], outputs);
    firstKey = mediaOutputKey(h.s, request);
    h.objects.set(stored.storageKey as string, Buffer.from("0"));
    const take = await generateVoiceTake(h.s, "voice", line, request, "t", await workDir(), h.measure);
    expect(h.calls).toHaveLength(0);
    expect(take.asset.storageKey).toBe(stored.storageKey);
    expect(take.usage.map((u) => u.costCents)).toEqual([0]);
  });

  it("bills both takes once when the re-take's provider call fails after charging", async () => {
    const charged = new MediaChargedError(
      new StudixError("PROVIDER_ERROR", "result lost", { retryable: false }),
      {
        provider: "multix",
        model: "elevenlabs:eleven_v3",
        costCents: 3,
        costSource: "receipt",
      },
    );
    const h = stage([tooLong, charged]);
    const err = await generateVoiceTake(h.s, "voice", line, request, "t", await workDir(), h.measure).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StageFailedAfterSpend);
    expect((err as StageFailedAfterSpend).error.code).toBe("PROVIDER_ERROR");
    expect((err as StageFailedAfterSpend).usage.map((u) => u.item)).toEqual([
      "media-voiceover-1",
      "media-voiceover-1-r1",
    ]);
  });

  it("bills both takes once when the job is cancelled while the re-take is measured", async () => {
    const h = stage([tooLong, padded]);
    h.hooks.onMeasure = (index) => {
      if (index !== 1) return;
      h.controller.abort();
      throw new StudixError("CANCELLED", "job cancelled");
    };
    const err = await generateVoiceTake(h.s, "voice", line, request, "t", await workDir(), h.measure).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StageFailedAfterSpend);
    expect((err as StageFailedAfterSpend).error.code).toBe("CANCELLED");
    expect((err as StageFailedAfterSpend).usage.map((u) => u.item)).toEqual([
      "media-voiceover-1",
      "media-voiceover-1-r1",
    ]);
  });

  it("turns down an unmeasured take on its reported length, so it is never stored as fitting", async () => {
    const h = stage([tooLong, { durationMs: 1900, startMs: 0, endMs: 1900 }]);
    const take = await generateVoiceTake(
      h.s,
      "voice",
      line,
      request,
      "t",
      await workDir(),
      async () => undefined,
    );
    expect(h.calls).toHaveLength(2);
    expect([...h.objects.keys()]).toEqual(["generated/job_1/voiceover-1-r1.mp3"]);
    // Within the breath of tolerance an unmeasured take has: cut at its room with a fade.
    expect(take.track).toMatchObject({ durationMs: 1800, fadeOutMs: 150 });
    expect(take.track.trimStartMs).toBeUndefined();
  });

  it("judges a stored take on its whole length when fetching it fails", async () => {
    const stored: AssetRef = {
      id: "voiceover-1",
      kind: "audio",
      storageKey: "generated/job_0/voiceover-1.mp3",
      sha256: createHash("sha256").update("0").digest("hex"),
      mime: "audio/mpeg",
      durationMs: 1700,
      provenance: { source: "generated", provider: "multix" },
    };
    const outputs: MediaOutputCache = {
      get: async () => ({ asset: stored, jobId: "job_0" }),
      put: async () => {},
    };
    const h = stage([], outputs);
    h.objects.set(stored.storageKey as string, Buffer.from("0"));
    const storage = (h.s.services as { storage: { download: unknown } }).storage;
    storage.download = async () => {
      throw new StudixError("UNAVAILABLE", "storage is down", { retryable: true });
    };
    // The re-take is looked up first; with every key a hit, it is the one served.
    const take = await generateVoiceTake(h.s, "voice", line, request, "t", await workDir(), h.measure);
    expect(h.measured).toEqual([]);
    expect(take.track).toMatchObject({ durationMs: 1700 });
    expect(take.track.trimStartMs).toBeUndefined();
  });

  it("keeps the brisker ask whole when the line's direction is at the limit", async () => {
    const long = {
      ...request,
      params: { ...request.params, instructions: "x".repeat(MAX_VOICE_DIRECTION_CHARS) },
    };
    const h = stage([tooLong, padded]);
    await generateVoiceTake(h.s, "voice", line, long, "t", await workDir(), h.measure);
    const direction = String(h.calls[1]?.params?.instructions);
    expect(direction).toMatch(/^The previous read ran too long.*say the brand name clearly\. x+$/);
    expect(direction.length).toBeLessThanOrEqual(MAX_VOICE_DIRECTION_CHARS);
  });

  it("judges a take FFmpeg cannot read on its whole length", async () => {
    const junk = join(root, "junk.mp3");
    await writeFile(junk, "not audio");
    expect(await measureVoiceTake(junk, new AbortController().signal)).toBeUndefined();
  });

  it("keys reuse by the exact room, so a take that fit a longer room is not served for a shorter one", () => {
    expect(voiceFitScope({ roomMs: 1849 })).not.toBe(voiceFitScope({ roomMs: 1750 }));
    expect(voiceFitScope({ roomMs: 1800 })).toBe(`${VOICE_FIT_SCOPE}:1800`);
  });
});
