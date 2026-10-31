import { StudixError } from "@studix/shared";
import { validateVideoIR } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import {
  captionCues,
  chunkCaption,
  framePrompt,
  HOOK_MAX_MS,
  irVariants,
  MAX_CAPTION_WORDS,
  marketingScript,
  marketingVideoTemplate,
  motionGraphicTemplate,
  packPipelines,
  packRegistry,
  resolveMotionStyle,
  variantIr,
  voiceoverWordBudget,
  wordCount,
} from "../src/index.ts";

const brief = {
  prompt: "Ba quảng cáo dọc cho tiệm trà Lá Mây",
  title: "Lá Mây",
  durationMs: 20_000,
  brand: {
    name: "Lá Mây",
    palette: { primary: "#2f6b4f", background: "#f4efe6", foreground: "#1d2a24" },
    fonts: { heading: "Be Vietnam Pro", body: "Be Vietnam Pro" },
  },
  directions: [
    {
      id: "sang-som",
      name: "Buổi sáng",
      concept: "Tách trà nóng mở đầu ngày mới.",
      hook: "Sáng nay bạn uống trà chưa?",
    },
    {
      id: "ban-be",
      name: "Bạn bè",
      concept: "Nhóm bạn bên ấm trà chiều.",
      keyMessages: ["Yên tĩnh giữa phố"],
    },
  ],
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof StudixError ? e.code : "NOT_STUDIX";
  }
  return undefined;
}

describe("caption chunks", () => {
  it("keeps every chunk within the word limit and prefers clause boundaries", () => {
    const text = "Trà hái tay mỗi sớm, ủ chậm trong bình gốm, rót ra thơm dịu cả căn phòng nhỏ";
    const chunks = chunkCaption(text);
    expect(chunks.every((c) => wordCount(c) <= MAX_CAPTION_WORDS)).toBe(true);
    expect(chunks[0]).toBe("Trà hái tay mỗi sớm,");
    expect(chunks.join(" ")).toBe(text.normalize("NFC"));
  });

  it("times cues in proportion to their words inside the span", () => {
    const cues = captionCues("một hai ba bốn năm sáu bảy tám chín mười", 1000, 2000, 5);
    expect(cues).toEqual([
      { startMs: 1000, endMs: 2000, text: "một hai ba bốn năm" },
      { startMs: 2000, endMs: 3000, text: "sáu bảy tám chín mười" },
    ]);
    expect(captionCues("", 0, 1000)).toEqual([]);
  });
});

describe("marketing script", () => {
  it("makes one ad per direction with a hook of at most three seconds and beats that fill the length", () => {
    const script = marketingScript(brief);
    expect(script).toMatchObject({ aspectRatio: "9:16", durationMs: 20_000, language: "vi" });
    expect(script.ads.map((a) => a.id)).toEqual(["ad-1-sang-som", "ad-2-ban-be"]);
    for (const ad of script.ads) {
      expect(ad.beats[0]?.durationMs).toBeLessThanOrEqual(HOOK_MAX_MS);
      const last = ad.beats.at(-1);
      expect((last?.startMs ?? 0) + (last?.durationMs ?? 0)).toBe(20_000);
      expect(ad.voiceoverWords).toBeLessThanOrEqual(voiceoverWordBudget(20_000));
    }
    // Derived closing frames carry the ad's own concept, so variants never share one prompt.
    const closing = script.ads.map((a) => a.beats.at(-1)?.visual);
    expect(new Set(closing).size).toBe(closing.length);
  });

  it("clamps the length and rejects a brief without directions or with an overlong voice-over", () => {
    expect(marketingScript({ ...brief, durationMs: 2_000 }).durationMs).toBe(10_000);
    expect(codeOf(() => marketingScript({ ...brief, directions: undefined }))).toBe("VALIDATION");
    const long = Array.from({ length: voiceoverWordBudget(20_000) + 1 }, () => "trà").join(" ");
    const over = {
      ...brief,
      directions: [{ ...brief.directions[0], beats: [{ visual: "a", voiceover: long }, { visual: "b" }] }],
    };
    expect(codeOf(() => marketingScript(over))).toBe("VALIDATION");
  });

  it("derives visuals that describe the scene, never the words the overlay sets", () => {
    const script = marketingScript(brief);
    for (const ad of script.ads) {
      const visuals = ad.beats.map((b) => b.visual);
      expect(new Set(visuals).size).toBe(visuals.length);
      for (const beat of ad.beats) {
        expect(beat.visual).not.toContain("Lá Mây");
        if (beat.onScreen) expect(beat.visual).not.toContain(beat.onScreen);
      }
    }
  });
});

describe("storyboard frame prompt", () => {
  const prompt = (visual: string, aspectRatio = "9:16") =>
    framePrompt(
      visual,
      "warm film grain",
      { ...brief, brand: { ...brief.brand, tagline: "Trà ngon mỗi sớm" } },
      aspectRatio,
    );

  it("keeps brand words and poster framing out of the image prompt", () => {
    const text = prompt("A cup of Lá Mây tea on a windowsill, LÁ MÂY steam rising. Trà ngon mỗi sớm");
    expect(text).not.toMatch(/lá mây/i);
    expect(text).not.toContain("Trà ngon mỗi sớm");
    expect(text).toContain("A cup of tea on a windowsill, steam rising.");
    expect(text).not.toMatch(/advertis|poster|frame/i);
    expect(text).toContain("tall portrait composition");
    expect(text).toContain("no text or lettering anywhere");
    expect(text).toContain("#2f6b4f");
  });

  it("only removes whole brand words and frames other ratios as a full-bleed scene", () => {
    expect(prompt("Lá Mâyer leaves")).toContain("Lá Mâyer leaves");
    expect(prompt("A tea field", "16:9")).toContain("wide landscape composition, full-bleed photograph");
    expect(prompt("A tea field", "3:2")).toContain("3:2 composition, full-bleed photograph");
  });
});

describe("marketing-video IR and variants", () => {
  it("builds a valid back-to-back IR whose variants each stand alone", () => {
    const ir = marketingVideoTemplate(brief);
    expect(validateVideoIR(ir).ok).toBe(true);
    expect(ir.format.durationMs).toBe(40_000);
    const variants = irVariants(ir);
    expect(variants.map((v) => v.startMs)).toEqual([0, 20_000]);
    const second = variantIr(ir, variants[1] as (typeof variants)[number]);
    expect(validateVideoIR(second).ok).toBe(true);
    expect(second.scenes).toHaveLength(1);
    expect(second.format.durationMs).toBe(20_000);
    expect(second.captions?.cues.every((c) => c.startMs >= 0 && c.endMs <= 20_000)).toBe(true);
    expect(second.captions?.cues.length).toBeGreaterThan(0);
  });

  it("rejects an IR that carries no variants", () => {
    const ir = motionGraphicTemplate({ prompt: "Lá Mây", keyMessages: ["Trà ngon"] });
    expect(codeOf(() => irVariants(ir))).toBe("VALIDATION");
  });
});

describe("motion graphic", () => {
  it("resolves a named profile, a matching one, or kinetic typography", () => {
    expect(
      resolveMotionStyle({
        prompt: "x",
        directions: [{ id: "a", name: "a", concept: "a", visualStyle: "kinetic-typography" }],
      }).id,
    ).toBe("kinetic-typography");
    expect(resolveMotionStyle({ prompt: "zzzz qqqq" }).id).toBe("kinetic-typography");
    const style = resolveMotionStyle({ prompt: "x", tone: ["editorial"] });
    expect(style.id).toEqual(expect.any(String));
  });

  it("builds a valid captioned IR with its voice-over script and rejects one that cannot fit", () => {
    const ir = motionGraphicTemplate({
      prompt: "Lá Mây",
      durationMs: 12_000,
      keyMessages: ["Trà hái tay mỗi sớm"],
    });
    expect(validateVideoIR(ir).ok).toBe(true);
    expect(ir.format.durationMs).toBe(12_000);
    expect(ir.metadata?.voiceover).toEqual(expect.any(String));
    expect(ir.captions?.cues.every((c) => wordCount(c.text) <= MAX_CAPTION_WORDS)).toBe(true);
    expect(ir.scenes.at(-1)?.role).toBe("cta");
    const long = Array.from({ length: 60 }, () => "trà").join(" ");
    expect(codeOf(() => motionGraphicTemplate({ prompt: "x", durationMs: 6_000, keyMessages: [long] }))).toBe(
      "VALIDATION",
    );
  });
});

describe("pack pipelines", () => {
  it("resolves both packs and rejects an unknown template", () => {
    const resolve = packPipelines(packRegistry);
    expect(resolve(undefined)).toBeUndefined();
    expect(resolve("marketing-video")?.renderer).toBe("hyperframes");
    expect(resolve("motion-graphic")?.renderer).toBe("hyperframes");
    expect(codeOf(() => resolve("nope"))).toBe("VALIDATION");
  });

  it("gates every image-to-video and audio stage of marketing-video on an approved storyboard", () => {
    const pipeline = packPipelines(packRegistry)("marketing-video");
    const engine = new Proxy({}, { get: (_t, name) => ({ name: `engine.${String(name)}` }) });
    const stages = pipeline?.stages({ fromVersion: true }, engine as never) ?? [];
    const paid = stages.filter((s) => s.name === "marketing-video.i2v" || s.name === "marketing-video.audio");
    expect(paid).toHaveLength(2);
    expect(paid.every((s) => s.requiresApprovedStoryboard === true)).toBe(true);
    const mg =
      packPipelines(packRegistry)("motion-graphic")?.stages({ fromVersion: false }, engine as never) ?? [];
    expect(mg.some((s) => s.name.includes("i2v"))).toBe(false);
  });
});
