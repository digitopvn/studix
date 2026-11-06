import { readFile } from "node:fs/promises";
import type { TenantContext } from "@studix/core";
import type { StageContext } from "@studix/workflow";
import { describe, expect, it } from "vitest";
import {
  animePack,
  bibleBoardIr,
  FilmScope,
  type FilmScopeInput,
  filmStageNames,
  keyframePrompt,
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
const n = filmStageNames(animePack.id);

/** Records every request a stage estimates, so its params can be checked without generating anything. */
function recorder() {
  const seen: Array<{ kind: string; prompt: string; params?: Record<string, unknown> }> = [];
  const media = {
    id: "fake",
    estimateCostCents: async (r: (typeof seen)[number]) => {
      seen.push(r);
      return 1;
    },
  };
  return { seen, media };
}

function stageContext(media: unknown, outputs: Record<string, unknown>): StageContext {
  return {
    ctx,
    job: { id: "job_1", payload: { projectId: "prj_1", workflowTemplate: "anime", input: {} } },
    attempt: 1,
    signal: new AbortController().signal,
    mediaJournal: undefined,
    outputs,
    services: { media },
    reportProgress: () => {},
    commit: async () => {},
  } as unknown as StageContext;
}

function portraitScope() {
  return FilmScope.parse({ ...fixture, aspectRatio: "9:16" });
}

/** A board whose characters each have a candidate sheet of `width`x`height`. */
function boardWithSheets(scope: FilmScope, width: number, height: number) {
  const production = productionFromScope(scope);
  production.characters = production.characters.map((c) => ({
    ...c,
    references: [
      {
        id: `${c.characterId}-ref-1`,
        assetId: `${c.characterId}-sheet-v1`,
        view: "turnaround" as const,
        status: "candidate" as const,
        version: c.identityVersion,
      },
    ],
  }));
  const ir = bibleBoardIr(scope, { film: { pack: "anime", scope, production } });
  ir.assets.push(
    ...scope.characters.map((c) => ({
      id: `${c.id}-sheet-v1`,
      kind: "image" as const,
      storageKey: `k/${c.id}-sheet-v1.png`,
      sha256: "a".repeat(64),
      mime: "image/png",
      width,
      height,
      provenance: { source: "generated" as const, provider: "fake" },
    })),
  );
  const boards = scope.scenes.flatMap((sc) =>
    sc.shots.map((shot) => ({ shotId: shot.id, frame: `Panel of ${shot.id}`, motion: "Slow push" })),
  );
  return { [n.bible]: { ir }, [n.g1]: { approved: true }, [n.storyboard]: { boards } };
}

describe("narrative-film frames for non-16:9 films", () => {
  it("draws character sheets in the film's frame", async () => {
    const scope = portraitScope();
    const { seen, media } = recorder();
    const ir = bibleBoardIr(scope, {
      film: { pack: "anime", scope, production: productionFromScope(scope) },
    });
    const stage = animePack.stages?.find((st) => st.name === n.designs);
    await stage!.estimateCostCents!(stageContext(media, { [n.bible]: { ir } }));
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) expect(r.params?.aspectRatio).toBe("9:16");
  });

  it("never pairs a reference with an aspect ratio: a sheet in the film's frame is sent without one", async () => {
    const scope = portraitScope();
    const { seen, media } = recorder();
    const stage = animePack.stages?.find((st) => st.name === n.keyframes);
    await stage!.estimateCostCents!(stageContext(media, boardWithSheets(scope, 720, 1280)));
    const withCast = scope.scenes.flatMap((sc) => sc.shots).filter((s) => s.characters.length > 0);
    expect(withCast.length).toBeGreaterThan(0);
    // The reference itself is attached at run time; at estimate time the frame decision shows in params.
    const unframed = new Set(seen.filter((r) => r.params?.aspectRatio === undefined).map((r) => r.prompt));
    expect(unframed.size).toBe(withCast.length);
  });

  it("draws from the prompt in the film's frame when the only sheet is in another frame", async () => {
    const scope = portraitScope();
    const { seen, media } = recorder();
    const stage = animePack.stages?.find((st) => st.name === n.keyframes);
    await stage!.estimateCostCents!(stageContext(media, boardWithSheets(scope, 1280, 720)));
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) expect(r.params?.aspectRatio).toBe("9:16");
  });
});

describe("narrative-film costume continuity", () => {
  it("names every anchor and the shot's declared wardrobe of each character in frame", () => {
    const base = FilmScope.parse(fixture);
    const tung = base.characters[1]!;
    const scope = FilmScope.parse({
      ...fixture,
      characters: fixture.characters.map((c, i) =>
        i === 1 ? { ...c, anchors: [...c.anchors, "black trousers", "long sleeves"] } : c,
      ),
    });
    const shot = {
      ...scope.scenes[0]!.shots[3]!,
      state: { ...scope.scenes[0]!.shots[3]!.state, [`wardrobe.${tung.id}`]: "long-sleeved white shirt" },
    };
    const prompt = keyframePrompt(scope, "san-thuong", shot, "backs to camera");
    expect(prompt).toContain("black trousers");
    expect(prompt).toContain("long sleeves");
    expect(prompt).toContain("wearing long-sleeved white shirt");
  });
});
