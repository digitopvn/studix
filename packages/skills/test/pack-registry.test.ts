import { validateVideoIR } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import {
  BRAND_INTRO_COMPOSE_STAGE,
  brandIntroPack,
  brandIntroSkill,
  createPackRegistry,
  type WorkflowPack,
} from "../src/index.ts";

const extraPack = (id: string, templateId = id): WorkflowPack => ({
  id,
  title: id,
  version: 1,
  templates: [{ ...brandIntroSkill, id: templateId }],
});

describe("pack registry", () => {
  it("serves templates and stages of every registered pack, tagged with their pack", () => {
    const registry = createPackRegistry([brandIntroPack]);
    registry.register(extraPack("anime-short"));
    expect(registry.templates().map((t) => [t.pack, t.id])).toEqual([
      ["brand-intro", "brand-intro"],
      ["anime-short", "anime-short"],
    ]);
    expect(registry.template("anime-short").pack).toBe("anime-short");
    expect(registry.stage(BRAND_INTRO_COMPOSE_STAGE)?.name).toBe(BRAND_INTRO_COMPOSE_STAGE);
    expect(registry.stage("nope")).toBeUndefined();
  });

  it("refuses duplicate packs, templates and stages, and malformed ids", () => {
    const registry = createPackRegistry([brandIntroPack]);
    expect(() => registry.register(brandIntroPack)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => registry.register(extraPack("other", "brand-intro"))).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    expect(() => registry.register({ ...extraPack("again"), stages: brandIntroPack.stages })).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    expect(() => registry.register(extraPack("Bad Pack"))).toThrow(
      expect.objectContaining({ code: "VALIDATION" }),
    );
    // A refused pack leaves nothing behind.
    expect(registry.packs().map((p) => p.id)).toEqual(["brand-intro"]);
  });

  it("unregister removes the pack and frees its ids", () => {
    const registry = createPackRegistry();
    const unregister = registry.register(extraPack("promo"));
    unregister();
    expect(registry.templates()).toEqual([]);
    expect(() => registry.template("promo")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => registry.register(extraPack("promo"))).not.toThrow();
  });
});

describe("brand-intro compose stage", () => {
  const stage = brandIntroPack.stages![0]!;
  const source = { payload: { brief: { prompt: "Giới thiệu quán phở", title: "Phở Thìn" } }, outputs: {} };

  it("parses its input, composes a valid VideoIR and keys the cache by template version and brief", async () => {
    const input = stage.inputSchema!.parse(source);
    const sctx = { input } as Parameters<NonNullable<typeof stage.cacheKey>>[0];
    const { output } = await stage.run(sctx);
    expect(stage.outputSchema!.safeParse(output).success).toBe(true);
    expect(validateVideoIR((output as { ir: unknown }).ir).ok).toBe(true);

    const key = await stage.cacheKey!(sctx);
    expect(key).toMatch(new RegExp(`^${BRAND_INTRO_COMPOSE_STAGE}@\\d+:[0-9a-f]{64}$`));
    const other = stage.inputSchema!.parse({ ...source, payload: { brief: { prompt: "Quán bún chả" } } });
    expect(await stage.cacheKey!({ input: other } as typeof sctx)).not.toBe(key);
  });

  it("rejects a payload without a brief", () => {
    expect(stage.inputSchema!.safeParse({ payload: {}, outputs: {} }).success).toBe(false);
  });
});
