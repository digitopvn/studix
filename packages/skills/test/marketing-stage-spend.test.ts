import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantContext } from "@studix/core";
import { FakeMediaProvider } from "@studix/providers";
import { StudixError } from "@studix/shared";
import type { AssetRef, VideoIR } from "@studix/video-ir";
import { type StageContext, StageFailedAfterSpend } from "@studix/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { marketingScript } from "../src/marketing-video/marketing-script.ts";
import { MV_STAGES, marketingReframeStage } from "../src/marketing-video/marketing-video-pack.ts";
import { beatKey, marketingVideoIr } from "../src/marketing-video/marketing-video-template.ts";

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studix-marketing-stage-spend-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const script = marketingScript({
  prompt: "Ads cho tiệm trà",
  language: "vi",
  durationMs: 20_000,
  directions: [
    {
      id: "morning",
      name: "Buổi sáng",
      concept: "Một tách trà buổi sáng",
      beats: [
        { visual: "ấm trà", voiceover: "Sáng nay bạn uống trà chưa?" },
        { visual: "lá trà", voiceover: "Trà hái tay mỗi sớm." },
        { visual: "tiệm", voiceover: "Ghé Lá Mây hôm nay." },
      ],
    },
  ],
});

const frames = Object.fromEntries(
  (script.ads[0]?.beats ?? []).map((b) => {
    const key = beatKey(script.ads[0]?.id ?? "", b.id);
    const frame: AssetRef = {
      id: `${key}-frame`,
      kind: "image",
      storageKey: `generated/job/${key}`,
      sha256: "a".repeat(64),
      mime: "image/png",
      provenance: { source: "generated" },
    };
    return [key, frame];
  }),
);

describe("marketing stage spend when the work after the paid batch fails", () => {
  it("reframe: the frames' cost reaches the ledger when a newer version makes the commit throw CONFLICT", async () => {
    const parentIr: VideoIR = marketingVideoIr(script, undefined, "Lá Mây", { frames });
    // The feedback patch rewrote the first shot's description: that frame is stale.
    const patched: VideoIR = structuredClone(parentIr);
    const first = patched.scenes[0]?.shots.find((sh) => sh.type === "image");
    if (first?.type !== "image") throw new Error("fixture has no image shot");
    first.alt = "ấm trà bên cửa sổ";

    const media = new FakeMediaProvider({ pricing: { estimateCents: () => 2 } });
    const storage = {
      put: async (_c: TenantContext, key: string, _b: unknown, opts: { sha256?: string }) => ({
        key,
        sha256: opts.sha256 ?? "",
        bytes: 1,
      }),
    };
    const versions: Record<string, { parentVersionId?: string; ir: VideoIR }> = {
      pver_patched: { parentVersionId: "pver_parent", ir: patched },
      pver_parent: { ir: parentIr },
    };
    const repos = {
      projects: {
        getVersion: async (_c: TenantContext, id: string) => versions[id],
        createVersion: async () => {
          throw new StudixError("CONFLICT", "the project moved on to a newer version", { retryable: false });
        },
      },
    };
    const s = {
      ctx,
      job: { id: "job_1" },
      attempt: 1,
      signal: new AbortController().signal,
      mediaJournal: undefined,
      input: {
        payload: { projectId: "prj_1", versionId: "pver_patched" },
        outputs: { brief: { brief: { title: "Lá Mây" } }, plan: { ir: patched, versionId: "pver_patched" } },
      },
      services: { media, storage, workRoot: root },
      reportProgress: () => {},
      commit: async (fn: (r: unknown, c: TenantContext) => Promise<unknown>) => fn(repos, ctx),
    } as unknown as StageContext;

    const failure = await marketingReframeStage.run(s).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(MV_STAGES.reframe).toBe(marketingReframeStage.name);
    expect(failure).toBeInstanceOf(StageFailedAfterSpend);
    const spent = failure as StageFailedAfterSpend;
    expect(spent.usage).toHaveLength(1);
    expect(spent.error.code).toBe("CONFLICT");
  });
});
