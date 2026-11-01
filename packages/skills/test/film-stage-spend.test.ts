import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantContext } from "@studix/core";
import { FakeMediaProvider } from "@studix/providers";
import { StudixError } from "@studix/shared";
import type { AssetRef } from "@studix/video-ir";
import { type StageContext, StageFailedAfterSpend } from "@studix/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  animePack,
  FilmScope,
  type FilmScopeInput,
  productionFromScope,
  storyboardIr,
} from "../src/index.ts";

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};

const fixture: FilmScopeInput = JSON.parse(
  await readFile(new URL("./fixtures/anime-scope-vi.json", import.meta.url), "utf8"),
);

const KEY_SHA = "a".repeat(64);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studix-film-stage-spend-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("film stage spend when the work after the paid batch fails", () => {
  it("motion: the clips' cost reaches the ledger even if storing a scene plate throws", async () => {
    const stage = animePack.stages?.find((st) => st.name === "anime.motion");
    expect(stage).toBeDefined();
    const scope = FilmScope.parse(fixture);
    const film = { pack: "anime" as const, scope, production: productionFromScope(scope) };
    const keyframes = new Map<string, AssetRef>(
      scope.scenes.flatMap((sc) =>
        sc.shots.map((shot): [string, AssetRef] => [
          shot.id,
          {
            id: `${shot.id}-key`,
            kind: "image",
            storageKey: `generated/job_0/keyframes/${shot.id}.png`,
            sha256: KEY_SHA,
            mime: "image/png",
            bytes: 1,
            assetVersionId: `asv_${shot.id}`,
            provenance: { source: "generated", provider: "fake" },
          },
        ]),
      ),
    );
    const ir = storyboardIr(scope, keyframes, [], film);
    const media = new FakeMediaProvider({ pricing: { estimateCents: () => 2 } });
    const storage = {
      download: async (_c: TenantContext, key: string, filePath: string) => {
        await writeFile(filePath, key);
        return { sha256: KEY_SHA, bytes: key.length };
      },
      put: async (_c: TenantContext, key: string, _b: unknown, opts: { sha256?: string }) => {
        if (key.includes("/scenes/"))
          throw new StudixError("UNAVAILABLE", "storage is down", { retryable: true });
        return { key, sha256: opts.sha256 ?? "", bytes: 1 };
      },
    };
    const s = {
      ctx,
      job: { id: "job_1", payload: { projectId: "prj_1", workflowTemplate: "anime", input: {} } },
      attempt: 1,
      signal: new AbortController().signal,
      mediaJournal: undefined,
      outputs: { "anime.keyframes": { ir } },
      services: { media, storage, workRoot: root },
      reportProgress: () => {},
      commit: async () => {},
    } as unknown as StageContext;

    const failure = await stage?.run(s).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(StageFailedAfterSpend);
    const spent = failure as StageFailedAfterSpend;
    expect(spent.usage.length).toBeGreaterThan(0);
    expect(spent.error.code).toBe("UNAVAILABLE");
  });
});
