import { readFileSync } from "node:fs";
import type { StageContext } from "@studix/workflow";
import { describe, expect, it } from "vitest";
import { FilmScope, type FilmScopeInput, productionFromScope } from "../src/narrative-film/film-scope.ts";
import { filmVoiceCast, lineDirection, parseVoiceRef } from "../src/narrative-film/film-voices.ts";
import { mediaRequest } from "../src/stored-media.ts";

const fixture: FilmScopeInput = JSON.parse(
  readFileSync(new URL("./fixtures/anime-scope-vi.json", import.meta.url), "utf8"),
);
const scope = FilmScope.parse(fixture);
const GEMINI = "openrouter:google/gemini-3.8-flash-tts";

/** The fixture's production with each character's voiceRef replaced (undefined removes it). */
function castAs(refs: Record<string, string | undefined>) {
  const production = productionFromScope(scope);
  return {
    ...production,
    characters: production.characters.map((c) => {
      const { voiceRef: _, ...voice } = c.voice ?? {};
      const ref = refs[c.characterId];
      return { ...c, voice: { ...voice, ...(ref ? { voiceRef: ref } : {}) } };
    }),
  };
}

describe("film voice casting", () => {
  it("reads a voice, a model, or a model with a voice", () => {
    expect(parseVoiceRef("Leda", "mai")).toEqual({ voice: "Leda" });
    expect(parseVoiceRef("openrouter:fish-audio/drama-3", "mai")).toEqual({
      model: "openrouter:fish-audio/drama-3",
    });
    expect(parseVoiceRef(`${GEMINI}@Puck`, "tun")).toEqual({ model: GEMINI, voice: "Puck" });
    for (const bad of ["", "a b", `${GEMINI}@`, "@Leda", `${GEMINI}@Le da`]) {
      expect(() => parseVoiceRef(bad, "mai")).toThrow(/must read/);
    }
  });

  it("keeps the bible's cast from the scope and gives every speaker its own voice", () => {
    expect([...filmVoiceCast(productionFromScope(scope))]).toEqual([
      ["mai", { model: GEMINI, voice: "Leda" }],
      ["tun", { model: GEMINI, voice: "Puck" }],
    ]);
    // A model without a voice list is cast by model: two models are two voices.
    expect(
      filmVoiceCast(castAs({ mai: "openrouter:fish-audio/drama-3", tun: `${GEMINI}@Puck` })).get("mai"),
    ).toEqual({ model: "openrouter:fish-audio/drama-3" });
  });

  it("refuses two speakers who would sound the same, before any line is recorded", () => {
    for (const refs of [
      { mai: undefined, tun: undefined },
      { mai: `${GEMINI}@Leda`, tun: `${GEMINI}@Leda` },
      { mai: "openrouter:fish-audio/drama-3", tun: "openrouter:fish-audio/drama-3" },
    ]) {
      expect(() => filmVoiceCast(castAs(refs))).toThrow(
        expect.objectContaining({
          code: "VALIDATION",
          message: "mai and tun would speak with the same voice",
          suggestedAction: expect.stringContaining("voice.voiceRef"),
        }),
      );
    }
  });
});

describe("film line direction", () => {
  it("joins the character's voice, the line's delivery, the shot and the tone", () => {
    const production = productionFromScope(scope);
    const [first, second] = production.dialogue;
    const direction = lineDirection(scope, production, first!);
    expect(direction).toMatch(/^Mai speaks one line in a Vietnamese animated film/);
    expect(direction).toContain("Character voice: giọng nữ trẻ, nhẹ, hơi trách yêu.");
    expect(direction).toContain("Read this line: trách yêu.");
    expect(direction).toContain(`Film tone: ${scope.tone}.`);
    expect(lineDirection(scope, production, second!)).toContain("Read this line: hụt hơi.");
    // Pure: the same input gives the same direction (it is part of a cached stage input).
    expect(lineDirection(scope, production, first!)).toBe(direction);
  });

  it("stays plain text within the speech routes' limit", () => {
    const production = productionFromScope(scope);
    // Past the schema's own limits on purpose: the direction must hold even so.
    const noisy: FilmScope = { ...scope, tone: `ấm áp\u0007${"x".repeat(1200)}` };
    const direction = lineDirection(noisy, production, production.dialogue[0]!);
    expect(direction.length).toBeLessThanOrEqual(1000);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none are left.
    expect(direction).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});

describe("stored media requests", () => {
  // mediaRequest reads only the job id, signal and journal of the stage context.
  const stage = { job: { id: "job_1" } } as unknown as StageContext;

  it("names a model only when the request does, so other packs keep their provider's routing", () => {
    const base = { assetId: "a", kind: "voice" as const, prompt: "x", keyPrefix: "k", maxCostCents: 5 };
    expect(mediaRequest(stage, "dialogue", base, "/w")).not.toHaveProperty("model");
    expect(mediaRequest(stage, "dialogue", { ...base, model: GEMINI }, "/w")).toMatchObject({
      model: GEMINI,
      idempotencyKey: "job_1:dialogue:a",
    });
  });
});
