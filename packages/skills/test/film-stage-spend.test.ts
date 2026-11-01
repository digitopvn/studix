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
  filmStageNames,
  longFormFilmPack,
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
    const spent = failure as StageFailedAfterSpend;
    expect(spent.usage.length).toBeGreaterThan(0);
    expect(spent.error.code).toBe("UNAVAILABLE");
  });

  it.each([animePack, longFormFilmPack])(
    "$id keyframes: the batch's cost reaches the ledger even if the continuity check fails",
    async (pack) => {
      const n = filmStageNames(pack.id);
      const stage = pack.stages?.find((st) => st.name === n.keyframes);
      expect(stage).toBeDefined();
      const scope = FilmScope.parse(fixture);
      // No character has a signed sheet in this production, so the drawn storyboard cannot pass the design phase.
      const production = productionFromScope(scope);
      expect(production.characters.every((c) => c.references.length === 0)).toBe(true);
      const ir = bibleBoardIr(scope, { film: { pack: pack.id, scope, production } });
      const boards = scope.scenes.flatMap((sc) =>
        sc.shots.map((shot) => ({ shotId: shot.id, frame: `Panel of ${shot.id}`, motion: "Slow push" })),
      );
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
        job: { id: "job_1", payload: { projectId: "prj_1", workflowTemplate: pack.id, input: {} } },
        attempt: 1,
        signal: new AbortController().signal,
        mediaJournal: undefined,
        outputs: {
          [n.bible]: { ir },
          [n.g1]: { approved: true },
          [n.storyboard]: { boards },
        },
        services: { media, storage, workRoot: root },
        reportProgress: () => {},
        commit: async () => {},
      } as unknown as StageContext;

      const failure = await stage!.run(s).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(failure).toBeInstanceOf(StageFailedAfterSpend);
      const spent = failure as StageFailedAfterSpend;
      expect(spent.usage).toHaveLength(boards.length);
      expect(spent.error.code).toBe("VALIDATION");
      expect(spent.error.message).toContain("The storyboard breaks continuity");
    },
  );
});
