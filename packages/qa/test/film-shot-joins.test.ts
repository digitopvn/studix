import { readFileSync } from "node:fs";
import { FilmScope, productionFromScope, storyboardIr } from "@studix/skills";
import { describe, expect, it } from "vitest";
import { filmShotJoins, QA_TOOLS } from "../src/index.ts";

const scope = FilmScope.parse(
  JSON.parse(
    readFileSync(new URL("../../skills/test/fixtures/anime-scope-vi.json", import.meta.url), "utf8"),
  ),
);

const image = (id: string) => ({
  id,
  kind: "image" as const,
  storageKey: `k/${id}.png`,
  sha256: "b".repeat(64),
  mime: "image/png",
  provenance: { source: "generated" as const },
});

describe("film shot joins", () => {
  it("lists every cut at its render time with the second shot's boundary mode", () => {
    const production = productionFromScope(scope);
    production.shots[2]!.boundary = "camera-transition";
    const keys = new Map(scope.scenes[0]!.shots.map((s) => [s.id, image(`${s.id}-key`)]));
    const ir = storyboardIr(scope, keys, [], { pack: "anime", scope, production });
    const joins = filmShotJoins(ir);
    expect(joins).toEqual([
      { a: "s1", b: "s2", atS: 2, mode: "intentional-cut" },
      { a: "s2", b: "s3", atS: 6, mode: "camera-transition" },
      { a: "s3", b: "s4", atS: 10, mode: "intentional-cut" },
      { a: "s4", b: "s5", atS: 13, mode: "intentional-cut" },
    ]);
    expect(QA_TOOLS.shotBoundaries.input.safeParse({ media: "film", joins }).success).toBe(true);
  });

  it("rejects a join with an unknown boundary mode", () => {
    const bad = { media: "film", joins: [{ a: "s1", b: "s2", atS: 1, mode: "dissolve" }] };
    expect(QA_TOOLS.shotBoundaries.input.safeParse(bad).success).toBe(false);
    expect(QA_TOOLS.shotBoundaries.mediaRefs({ media: "film", joins: [] } as never)).toEqual(["film"]);
  });
});
