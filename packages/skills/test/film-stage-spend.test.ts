import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantContext } from "@studix/core";
import { FakeMediaProvider } from "@studix/providers";
import { StudixError } from "@studix/shared";
import { type StageContext, StageFailedAfterSpend } from "@studix/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  animePack,
  bibleBoardIr,
  FilmScope,
  type FilmScopeInput,
  productionFromScope,
} from "../src/index.ts";

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};

const fixture: FilmScopeInput = JSON.parse(
  await readFile(new URL("./fixtures/anime-scope-vi.json", import.meta.url), "utf8"),
);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studix-film-stage-spend-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("film stage spend when the work after the paid batch fails", () => {
  it("designs: the batch's cost reaches the ledger even if publishing the review version throws", async () => {
    const stage = animePack.stages?.find((st) => st.name === "anime.designs");
    expect(stage).toBeDefined();
    const scope = FilmScope.parse(fixture);
    const ir = bibleBoardIr(scope, {
      film: { pack: "anime", scope, production: productionFromScope(scope) },
    });
    const media = new FakeMediaProvider({ pricing: { estimateCents: () => 2 } });
    const storage = {
      put: async (_c: TenantContext, key: string, _b: unknown, opts: { sha256?: string }) => ({
        key,
        sha256: opts.sha256 ?? "",
        bytes: 1,
      }),
    };
    const s = {
      ctx,
      job: {
        id: "job_1",
        payload: { projectId: "prj_1", workflowTemplate: "anime", input: {} },
      },
      attempt: 1,
      signal: new AbortController().signal,
      mediaJournal: undefined,
      outputs: { "anime.bible": { ir } },
      services: { media, storage, workRoot: root },
      reportProgress: () => {},
      commit: async () => {
        throw new StudixError("UNAVAILABLE", "database is down", { retryable: true });
      },
    } as unknown as StageContext;

    const failure = await stage!.run(s).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(StageFailedAfterSpend);
    expect((failure as StageFailedAfterSpend).usage.length).toBeGreaterThan(0);
  });
});
