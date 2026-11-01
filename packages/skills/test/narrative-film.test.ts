import { readFileSync } from "node:fs";
import { validateVideoIR } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import {
  animePack,
  animeRules,
  bibleBoardIr,
  characterSheetPrompt,
  FilmScope,
  type FilmScopeInput,
  filmOf,
  filmStageNames,
  keyframePrompt,
  longFormFilmPack,
  longFormFilmRules,
  motionPrompt,
  packPipelines,
  packRegistry,
  productionFromScope,
  scopeDurationMs,
  scopeIssues,
  storyboardIr,
  tempCaptions,
} from "../src/index.ts";

const fixture: FilmScopeInput = JSON.parse(
  readFileSync(new URL("./fixtures/anime-scope-vi.json", import.meta.url), "utf8"),
);
const scope = FilmScope.parse(fixture);

/** A copy of the fixture with `edit` applied to its shots. */
function withShots(edit: (shots: FilmScopeInput["scenes"][number]["shots"]) => void): FilmScope {
  const copy = structuredClone(fixture);
  edit(copy.scenes[0]!.shots);
  return FilmScope.parse(copy);
}

const codes = (s: FilmScope, rules = animeRules) =>
  scopeIssues(s, { durationMs: 15_000, rules }).map((i) => i.code);

describe("film scope", () => {
  it("accepts the fixture under the shared, anime and long-form rules", () => {
    expect(scopeDurationMs(scope)).toBe(15_000);
    expect(scopeIssues(scope, { durationMs: 15_000, rules: animeRules })).toEqual([]);
    expect(scopeIssues(scope, { durationMs: 15_000, rules: longFormFilmRules })).toEqual([]);
  });

  it("routes a visible speaker through one dedicated pass on a video-tier shot", () => {
    expect(
      codes(
        withShots((s) => {
          s[1]!.tier = "T1";
        }),
        [],
      ),
    ).toContain("lipsync");
    expect(
      codes(
        withShots((s) => {
          s[1]!.lipsync = "native";
        }),
        [],
      ),
    ).toContain("lipsync");
    expect(
      codes(
        withShots((s) => void s[1]!.lines.push({ characterId: "mai", text: "Đi nào." })),
        [],
      ),
    ).toContain("lipsync");
    // A speaker on screen without lipsync is a production issue too.
    expect(
      codes(
        withShots((s) => {
          s[1]!.lipsync = "none";
        }),
        [],
      ),
    ).toContain("lipsync");
  });

  it("refuses an SFX cue written in the film's language, which the effect model would read aloud", () => {
    const spoken = withShots((s) => {
      s[2]!.sfx = ["tiếng thở hổn hển"];
      s[4]!.sfx = ["fireworks bursting overhead", "pháo hoa nổ vang"];
    });
    expect(scopeIssues(spoken, { durationMs: 15_000 })).toEqual([
      expect.objectContaining({ code: "schema", path: "/scenes/0/shots/2/sfx/0" }),
      expect.objectContaining({ code: "schema", path: "/scenes/0/shots/4/sfx/1" }),
    ]);
  });

  it("accepts a voiced cue only when it is one of the shot's own sfx cues", () => {
    const marked = withShots((s) => {
      s[4]!.sfx = ["cheering crowd far away"];
      s[4]!.voicedSfx = ["cheering crowd far away"];
    });
    expect(scopeIssues(marked, { durationMs: 15_000 })).toEqual([]);
    const stray = withShots((s) => {
      s[4]!.sfx = ["fireworks bursting overhead"];
      s[4]!.voicedSfx = ["laughing crowd"];
    });
    expect(scopeIssues(stray, { durationMs: 15_000 })).toEqual([
      expect.objectContaining({ code: "unknown_reference", path: "/scenes/0/shots/4/voicedSfx/0" }),
    ]);
  });

  it("keeps lines within three words a second, the brief's length and the audio track bound", () => {
    const wordy = withShots((s) => {
      s[3]!.lines = [{ characterId: "mai", text: "một hai ba bốn năm sáu bảy tám chín mười" }];
    });
    expect(
      scopeIssues(wordy, { durationMs: 15_000 })
        .map((i) => i.message)
        .join(),
    ).toMatch(/10 spoken words/);
    expect(scopeIssues(scope, { durationMs: 30_000 })).toEqual([
      expect.objectContaining({ code: "timeline", path: "/scenes" }),
    ]);
    const noisy = withShots((s) => {
      for (const shot of s) shot.sfx = ["a", "b", "c"];
    });
    expect(
      scopeIssues(noisy)
        .map((i) => i.message)
        .join(),
    ).toMatch(/need 19 audio tracks/);
  });

  it("flags an undeclared left-right flip along the continuity chain", () => {
    const flipped = withShots((s) => {
      s[3]!.state = { ...s[3]!.state, "position.mai": "right", "position.tun": "left" };
    });
    expect(codes(flipped, [])).toEqual(["continuity", "continuity"]);
  });

  it("anime: render class follows the tier, one T3 per scene, T3 at most 4 s, dialogue scenes move", () => {
    expect(
      codes(
        withShots((s) => {
          s[1]!.renderClass = "STANDARD";
        }),
      ),
    ).toContain("schema");
    expect(
      codes(
        withShots((s) => {
          s[1]!.tier = "T3";
          s[1]!.renderClass = "HERO";
        }),
      ),
    ).toEqual(["out_of_bounds"]);
    expect(
      codes(
        withShots((s) => {
          s[3]!.durationMs = 5_000;
          s[4]!.durationMs = 1_000;
          s[0]!.durationMs = 1_000;
        }),
      ),
    ).toEqual(["out_of_bounds"]);
    const still = withShots((s) => {
      for (const i of [2, 3]) {
        s[i]!.tier = "T1";
        s[i]!.renderClass = "STANDARD";
        s[i]!.visibleSpeakers = [];
        s[i]!.lipsync = "none";
      }
    });
    expect(scopeIssues(still, { rules: animeRules }).map((i) => i.message)).toEqual([
      expect.stringMatching(/at least 60% of its runtime; this one 27%/),
    ]);
  });

  it("long-form: cheap classes never take video, lip-sync is critical or hero, continuity is chained", () => {
    expect(
      codes(
        withShots((s) => {
          s[3]!.renderClass = "CHEAP_BROLL";
        }),
        longFormFilmRules,
      ),
    ).toEqual(["schema"]);
    expect(
      codes(
        withShots((s) => {
          s[1]!.renderClass = "STANDARD";
        }),
        longFormFilmRules,
      ),
    ).toEqual(["lipsync"]);
    expect(
      codes(
        withShots((s) => void delete s[2]!.continuityFrom),
        longFormFilmRules,
      ),
    ).toEqual(["continuity"]);
  });
});

describe("film prompts", () => {
  const shots = scope.scenes[0]!.shots;

  it("compiles the bible into every prompt: style, cast anchors, framing and no text", () => {
    const sheet = characterSheetPrompt(scope, scope.characters[0]!);
    expect(sheet).toMatch(/^2D cel-shaded anime/);
    expect(sheet).toContain("yellow hair bow on the left");
    expect(sheet).toContain("right-handed");
    expect(sheet).toContain("keep 8% margin");
    expect(sheet).toContain("Avoid: photorealistic, 3D render, extra fingers, long hair, glasses, no text");

    const key = keyframePrompt(scope, "san-thuong", shots[3]!, "Mai left, Tùng right, backs to camera");
    expect(key).toContain("Cast, each exactly once and no one else: Mai (");
    expect(key).toContain("Tùng (messy short brown hair, white shirt tucked in, blue backpack, left-handed)");
    // A film frame fills the picture: an edge margin made image models draw borders and side bars.
    expect(key).not.toContain("margin");
    expect(key).toContain("full-bleed picture that fills the whole frame edge to edge, no border");
    expect(key).toContain("Set: school rooftop");
    expect(key).not.toContain("Reviewer's correction");
    const redraw = keyframePrompt(scope, "san-thuong", shots[3]!, "backs to camera", "Tùng in long sleeves");
    expect(redraw).toContain("Reviewer's correction, apply it exactly: Tùng in long sleeves");
    // A board that still asks for an edge margin in its frame text loses it; the rest of the frame stays.
    const boardMargin = keyframePrompt(
      scope,
      "san-thuong",
      shots[0]!,
      "Empty rooftop, ground plane toward the horizon, 8% margin at every edge. No people.",
    );
    expect(boardMargin).not.toMatch(/margin/i);
    expect(boardMargin).toContain("Empty rooftop, ground plane toward the horizon. No people.");
    expect(
      keyframePrompt(scope, "san-thuong", shots[0]!, "Rooftop; keep a 5% margin on the frame edges"),
    ).not.toMatch(/margin/i);
    expect(keyframePrompt(scope, "san-thuong", shots[0]!, "empty rooftop")).toContain(
      "No characters in frame",
    );
  });

  it("keeps mouths closed on silent shots and lets the one speaker talk", () => {
    expect(motionPrompt(scope, shots[3]!, "they look up")).toContain("mouths closed, nobody talks");
    expect(motionPrompt(scope, shots[1]!, "Mai turns and speaks")).toContain("the speaker talks naturally");
  });
});

describe("film boards", () => {
  it("lays the G0 bible board out as cards, then every shot at its own length", () => {
    const ir = bibleBoardIr(scope, {
      film: { pack: "anime", scope, production: productionFromScope(scope) },
    });
    expect(validateVideoIR(ir).ok).toBe(true);
    expect(ir.scenes.map((s) => s.id)).toEqual(["board-bible", "canh-1"]);
    expect(ir.scenes[0]?.shots.map((s) => s.id)).toEqual([
      "board-title",
      "board-world",
      "board-mai",
      "board-tun",
    ]);
    expect(ir.scenes[1]?.shots.map((s) => s.durationMs)).toEqual([2000, 4000, 4000, 3000, 2000]);
    expect(ir.scenes[1]?.shots[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Mai: “Cậu lại"),
    });
    expect(filmOf(ir).scope.title).toBe("Hẹn trên sân thượng");
    expect(ir.format).toMatchObject({ fps: 24, width: 1920, height: 1080, durationMs: 12_000 + 15_000 });
  });

  it("refuses an IR without a film record", () => {
    expect(() => filmOf(bibleBoardIr(scope))).toThrow(/metadata\.film/);
  });

  it("builds the storyboard under the scope's shot ids with temp captions per line", () => {
    const asset = (id: string) => ({
      id,
      kind: "image" as const,
      storageKey: `k/${id}.png`,
      sha256: "a".repeat(64),
      mime: "image/png",
      provenance: { source: "generated" as const, provider: "fake" },
    });
    const keys = new Map(scope.scenes[0]!.shots.map((s) => [s.id, asset(`${s.id}-key`)]));
    const ir = storyboardIr(scope, keys, [asset("mai-sheet-v1")], {
      pack: "anime",
      scope,
      production: productionFromScope(scope),
    });
    expect(ir.scenes[0]?.shots.map((s) => [s.id, s.type, s.startMs])).toEqual([
      ["s1", "image", 0],
      ["s2", "image", 2000],
      ["s3", "image", 6000],
      ["s4", "image", 10000],
      ["s5", "image", 13000],
    ]);
    expect(ir.assets.map((a) => a.id)).toContain("mai-sheet-v1");
    expect(tempCaptions(scope)?.cues.map((c) => c.text)).toEqual([
      "Cậu lại đến muộn rồi.",
      "Xin lỗi, tàu điện bị trễ.",
      "Vừa kịp lúc.",
    ]);
    expect(ir.captions?.cues[0]).toMatchObject({ startMs: 2150 });
  });
});

describe("narrative packs", () => {
  it("registers anime and long-form-film with unique prefixed stages and a pipeline each", () => {
    expect(packRegistry.template("anime")?.id).toBe("anime");
    expect(packRegistry.template("long-form-film")?.id).toBe("long-form-film");
    const pipelines = packPipelines(packRegistry);
    for (const pack of [animePack, longFormFilmPack]) {
      const n = filmStageNames(pack.id);
      expect(pack.stages?.map((s) => s.name)).toContain(n.g0);
      expect(pack.stages?.every((s) => s.name.startsWith(`${pack.id}.`))).toBe(true);
      expect(pipelines(pack.id)).toBe(pack.pipeline);
    }
  });

  it("orders a new film brief -> scope -> bible -> G0 -> designs -> G1 -> storyboard -> keyframes", () => {
    const e = Object.fromEntries(
      ["brief", "plan", "validate_ir", "render", "upload", "finalize", "storyboard_ready"].map((name) => [
        name,
        { name, run: async () => ({ output: {} }) },
      ]),
    );
    const engine = {
      brief: e.brief!,
      plan: e.plan!,
      validateIr: e.validate_ir!,
      render: e.render!,
      upload: e.upload!,
      finalize: e.finalize!,
      storyboardReady: e.storyboard_ready!,
    };
    const names = (fromVersion: boolean) =>
      animePack.pipeline?.stages({ fromVersion } as never, engine as never).map((s) => s.name);
    expect(names(false)).toEqual([
      "brief",
      "anime.scope",
      "anime.bible",
      "anime.gate-g0",
      "anime.designs",
      "anime.gate-g1",
      "anime.storyboard",
      "anime.keyframes",
      "validate_ir",
      "storyboard_ready",
    ]);
    expect(names(true)).toEqual([
      "plan",
      "validate_ir",
      "anime.dialogue",
      "anime.motion",
      "anime.lipsync",
      "anime.score",
      "anime.continuity",
      "render",
      "anime.qa",
      "upload",
      "finalize",
    ]);
    const paid = animePack.stages?.filter((s) => s.requiresApprovedStoryboard).map((s) => s.name);
    expect(paid).toEqual(["anime.dialogue", "anime.motion", "anime.lipsync", "anime.score"]);
  });

  it("turns a host-written scope into the G0 board and rejects one that breaks the rules", async () => {
    const template = packRegistry.template("anime")!;
    expect(template.inputSchema).toMatchObject({ type: "object" });
    const ir = await template.run(fixture);
    expect(ir.scenes[0]?.id).toBe("board-bible");
    const broken = structuredClone(fixture);
    broken.scenes[0]!.shots[1]!.tier = "T1";
    expect(() => template.run(broken)).toThrow(/production rules/);
  });
});
