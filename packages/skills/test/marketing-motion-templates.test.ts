import { StudixError } from "@studix/shared";
import { type VideoIR, validateVideoIR, withPromptFormat } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import {
  captionCues,
  chunkCaption,
  framePrompt,
  HOOK_MAX_MS,
  irVariants,
  MAX_CAPTION_WORDS,
  MotionStoryboard,
  marketingScript,
  marketingVideoTemplate,
  motionGraphicStoryboardStage,
  motionGraphicTemplate,
  packPipelines,
  packRegistry,
  resolveMotionStyle,
  spokenLength,
  variantIr,
  voiceoverWordBudget,
  wordCount,
} from "../src/index.ts";
import { VO_WORDS_PER_SECOND } from "../src/marketing-video/marketing-script.ts";
import { voiceLines } from "../src/voice-lines.ts";

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

  it("keeps a phone number in one cue", () => {
    const line = "Đặt hàng ngay hôm nay qua hotline 0901 234 567 để nhận quà tặng";
    for (const durationMs of [1500, 2500, 3650]) {
      expect(captionCues(line, 0, durationMs).map((c) => c.text)).toEqual([
        "Đặt hàng ngay hôm nay qua hotline",
        "0901 234 567 để nhận quà tặng",
      ]);
    }
    expect(chunkCaption("Gọi ngay 0901 234 567 hôm nay nhé bạn", 4)).toEqual([
      "Gọi ngay",
      "0901 234 567 hôm",
      "nay nhé bạn",
    ]);
  });

  it("never leaves a one-word or sub-600 ms cue: the remainder joins the cue before it", () => {
    const line = "Here is the one thing every founder should know about.";
    expect(chunkCaption(line)).toEqual([line]);
    const cues = captionCues(line, 32_000, 4500);
    expect(cues).toEqual([{ startMs: 32_000, endMs: 36_500, text: line }]);
    // A short clause folds into its neighbour while the two fit one cue; past that, they share the time.
    expect(captionCues("Xin chào, hôm nay", 0, 2000)).toEqual([
      { startMs: 0, endMs: 2000, text: "Xin chào, hôm nay" },
    ]);
    const busy = captionCues("Xin chào, hôm nay mình kể bạn nghe một chuyện nhỏ thôi.", 0, 3572);
    expect(busy.map((c) => c.text)).toEqual(["Xin chào,", "hôm nay mình kể bạn nghe một chuyện nhỏ thôi."]);
    expect(busy.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 600],
      [600, 3572],
    ]);
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
    expect(
      codeOf(() =>
        marketingScript({ ...brief, brand: undefined, keyMessages: undefined, directions: undefined }),
      ),
    ).toBe("VALIDATION");
    const long = Array.from({ length: voiceoverWordBudget(20_000) + 1 }, () => "trà").join(" ");
    const over = {
      ...brief,
      directions: [{ ...brief.directions[0], beats: [{ visual: "a", voiceover: long }, { visual: "b" }] }],
    };
    expect(codeOf(() => marketingScript(over))).toBe("VALIDATION");
  });

  it("draws one ad from the brief when it names no directions, never speaking the prompt", () => {
    const script = marketingScript({
      prompt: "Video quảng cáo dọc 15 giây cho quán cà phê Mây Rang",
      durationMs: 15_000,
      keyMessages: ["Cà phê rang tại chỗ", "View đồi thông", "Mua 1 tặng 1 cuối tuần"],
      callToAction: "Ghé Mây Rang cuối tuần này",
    });
    expect(script.ads).toHaveLength(1);
    const ad = script.ads[0];
    expect(ad?.id).toBe("ad-1-main");
    expect(ad?.beats.map((b) => b.voiceover)).toEqual([
      "Cà phê rang tại chỗ",
      "View đồi thông",
      "Mua 1 tặng 1 cuối tuần",
      "Ghé Mây Rang cuối tuần này",
    ]);
    expect(ad?.voiceover).not.toContain("Video quảng cáo");
    // Without key messages the brand name opens the ad.
    const branded = marketingScript({ ...brief, directions: undefined });
    expect(branded.ads[0]?.beats[0]?.voiceover).toBe("Lá Mây");
  });

  it("trims key messages, skips blank ones and never cuts a long first message short", () => {
    const script = marketingScript({
      prompt: "Quảng cáo trà",
      durationMs: 30_000,
      keyMessages: ["   ", "  Trà ngon mỗi sáng  ", "  Giao nhanh  "],
      callToAction: "",
    });
    const beats = script.ads[0]?.beats ?? [];
    expect(beats.map((b) => b.voiceover)).toEqual(["Trà ngon mỗi sáng", "Giao nhanh", "Tìm hiểu ngay"]);
    // A hook too long for its beat is refused whole, not spoken cut short.
    const hook = Array.from({ length: 30 }, () => "trà").join(" ");
    expect(() =>
      marketingScript({ prompt: "Quảng cáo trà", durationMs: 30_000, keyMessages: [hook, "Giao nhanh"] }),
    ).toThrow(/longer than its beat/);
    // A direction without messages of its own takes the brief's, cleaned the same way.
    const directed = marketingScript({
      ...brief,
      keyMessages: ["  ", "Trà\n\nngon"],
      directions: [{ id: "a", name: "A", concept: "Ấm trà buổi sáng." }],
    });
    expect(directed.ads[0]?.beats.map((b) => b.voiceover)).toContain("Trà ngon");
  });

  it("lets the marketing pack refuse an unscriptable brief before a job is queued", () => {
    const pack = packRegistry.packs().find((p) => p.id === "marketing-video");
    expect(codeOf(() => pack?.checkBrief?.({ prompt: "Quảng cáo trà", keyMessages: ["   "] }))).toBe(
      "VALIDATION",
    );
    expect(codeOf(() => pack?.checkBrief?.({ prompt: "Quảng cáo trà" }))).toBe("VALIDATION");
    expect(
      codeOf(() => pack?.checkBrief?.({ prompt: "Quảng cáo trà", keyMessages: ["Trà ngon"] })),
    ).toBeUndefined();
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
    // A caption the second ad's copy does not already show, so it survives into that ad.
    ir.captions?.cues.push({ startMs: 24_000, endMs: 25_000, text: "Một câu nói khác hẳn" });
    const second = variantIr(ir, variants[1] as (typeof variants)[number]);
    expect(validateVideoIR(second).ok).toBe(true);
    expect(second.scenes).toHaveLength(1);
    expect(second.format.durationMs).toBe(20_000);
    expect(second.captions?.cues.every((c) => c.startMs >= 0 && c.endMs <= 20_000)).toBe(true);
    expect(second.captions?.cues).toContainEqual({
      startMs: 4_000,
      endMs: 5_000,
      text: "Một câu nói khác hẳn",
    });
  });

  it("renders each ad's pictures full-bleed unless the IR names a region", () => {
    const ir = marketingVideoTemplate(brief);
    const scene = ir.scenes[0] as (typeof ir.scenes)[number];
    const frame = {
      id: "frame-a",
      kind: "image" as const,
      storageKey: "k/frame-a.png",
      sha256: "a".repeat(64),
      mime: "image/png",
      bytes: 1,
      provenance: { source: "generated" as const },
    };
    ir.assets.push(frame);
    scene.shots.unshift(
      {
        id: "pic-free",
        type: "image",
        startMs: 0,
        durationMs: 3000,
        assetId: frame.id,
        fit: "cover",
        alt: "Tea on a windowsill",
      },
      {
        id: "pic-top",
        type: "image",
        startMs: 3000,
        durationMs: 3000,
        assetId: frame.id,
        fit: "cover",
        alt: "Tea on a windowsill",
        style: { region: "top" },
      },
    );
    const one = variantIr(ir, irVariants(ir)[0] as ReturnType<typeof irVariants>[number]);
    expect(validateVideoIR(one).ok).toBe(true);
    const shots = Object.fromEntries((one.scenes[0]?.shots ?? []).map((s) => [s.id, s]));
    expect(shots["pic-free"]?.style?.region).toBe("full");
    expect(shots["pic-top"]?.style?.region).toBe("top");
    // Copy keeps its own layout and sits on a card over the footage.
    const copy = (one.scenes[0]?.shots ?? []).filter((s) =>
      ["title", "text", "logo", "cta"].includes(s.type),
    );
    expect(copy.length).toBeGreaterThan(2);
    for (const shot of copy) {
      expect(shot.style?.region).not.toBe("full");
      expect(shot.style?.background).toBe("background");
    }
  });

  it("leaves copy uncarded when an ad has no full-bleed picture", () => {
    const ir = marketingVideoTemplate(brief);
    const one = variantIr(ir, irVariants(ir)[0] as ReturnType<typeof irVariants>[number]);
    expect(one.scenes[0]?.shots.every((s) => s.style?.background === undefined)).toBe(true);
  });

  it("moves the CTA off the centred subject to the lower band only over footage", () => {
    const plain = marketingVideoTemplate(brief);
    const first = (ir: typeof plain) =>
      variantIr(ir, irVariants(ir)[0] as ReturnType<typeof irVariants>[number]);
    const ctaOf = (ir: typeof plain) => ir.scenes[0]?.shots.find((s) => s.type === "cta");
    expect(ctaOf(first(plain))?.style?.region).toBe("middle");
    const footage = marketingVideoTemplate(brief);
    const scene = footage.scenes[0] as (typeof footage.scenes)[number];
    footage.assets.push({
      id: "frame-a",
      kind: "image",
      storageKey: "k/frame-a.png",
      sha256: "a".repeat(64),
      mime: "image/png",
      provenance: { source: "generated" },
    });
    scene.shots.unshift({
      id: "pic",
      type: "image",
      startMs: 0,
      durationMs: 20_000,
      assetId: "frame-a",
      fit: "cover",
      alt: "Tea on a windowsill",
    });
    const cta = scene.shots.find((s) => s.type === "cta");
    if (!cta || !footage.captions) throw new Error("fixture has no CTA or captions");
    const withCta = (c: { startMs: number; endMs: number }) =>
      c.startMs < cta.startMs + cta.durationMs && c.endMs > cta.startMs;
    // No caption shows with the CTA: it takes the lower band, clear of the subject's face.
    footage.captions.cues = footage.captions.cues.filter((c) => !withCta(c));
    const one = first(footage);
    expect(validateVideoIR(one).ok).toBe(true);
    expect(ctaOf(one)?.style?.region).toBe("bottom");
    expect(one.scenes[0]?.shots.find((s) => s.type === "logo")?.style?.region).toBe("top");
    // Nothing else the copy shows sits in the middle of the frame either.
    const copy = one.scenes[0]?.shots.filter((s) => s.type !== "image" && s.type !== "video") ?? [];
    expect(copy.every((s) => s.style?.region !== "middle")).toBe(true);
    // A burned caption at the bottom while the CTA shows: the CTA goes to the top band instead of onto it.
    footage.captions.cues.push({
      startMs: cta.startMs + 1000,
      endMs: cta.startMs + 3000,
      text: "Một câu nói khác hẳn",
    });
    const captioned = first(footage);
    expect(captioned.captions?.cues.map((c) => c.text)).toContain("Một câu nói khác hẳn");
    expect(ctaOf(captioned)?.style?.region).toBe("top");
  });

  it("drops burned captions that only repeat the line on screen and keeps the rest", () => {
    const ir = marketingVideoTemplate(brief);
    const variant = irVariants(ir)[0] as ReturnType<typeof irVariants>[number];
    const own = (ir.captions?.cues ?? []).filter((c) => c.endMs <= variant.startMs + variant.durationMs);
    expect(own.length).toBeGreaterThan(0);
    ir.captions?.cues.push({ startMs: 4_000, endMs: 5_000, text: "Một câu nói khác hẳn" });
    const one = variantIr(ir, variant);
    const shots = one.scenes[0]?.shots ?? [];
    const words = (t: string) =>
      t
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    const onScreen = (startMs: number, endMs: number) =>
      shots
        .filter((s) => "text" in s && s.text && s.startMs < endMs && s.startMs + s.durationMs > startMs)
        .map((s) => words((s as { text: string }).text));
    const kept = one.captions?.cues ?? [];
    expect(kept.length).toBeLessThan(own.length + 1);
    for (const cue of kept) {
      expect(onScreen(cue.startMs, cue.endMs).some((line) => line.includes(words(cue.text)))).toBe(false);
    }
    expect(kept.map((c) => c.text)).toContain("Một câu nói khác hẳn");
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

  it("renders the length and frame shape the prompt states", () => {
    const prompt =
      "A 60-second 16:9 (1920x1080) English motion-graphic video about Lá Mây. Exactly 60 seconds.";
    const ir = motionGraphicTemplate(withPromptFormat({ prompt }));
    expect(ir.format).toMatchObject({ aspectRatio: "16:9", width: 1920, height: 1080, durationMs: 60_000 });
    // Landscape has room: every plain headline card is set at display size, not only the hook.
    const wide = motionGraphicTemplate({ prompt, aspectRatio: "16:9", keyMessages: ["Tea picked by hand"] });
    const message = wide.scenes
      .find((s) => s.id === "message-1")
      ?.shots.find((s) => s.id === "message-1-text");
    expect(message?.style?.textStyle).toBe("display");
  });

  it("keeps the style profile's name off screen when the brief has no brand or title", () => {
    const ir = motionGraphicTemplate({
      prompt: "Video giới thiệu Lá Mây",
      keyMessages: ["Trà hái tay mỗi sớm"],
      callToAction: "Ghé Lá Mây hôm nay",
    });
    expect(validateVideoIR(ir).ok).toBe(true);
    const cta = ir.scenes.find((s) => s.id === "cta");
    expect(cta?.shots.map((s) => s.id)).toEqual(["cta-text"]);
    // No title or direction: the hook is the prompt, and it names the graphic.
    expect(ir.title).toBe("Video giới thiệu Lá Mây");
    expect(ir.brand?.name).toBe("Video giới thiệu Lá Mây");
    const titled = motionGraphicTemplate({ prompt: "Video giới thiệu Lá Mây", title: "Lá Mây" });
    const logo = titled.scenes.find((s) => s.id === "cta")?.shots.find((s) => s.id === "cta-logo");
    expect(logo).toMatchObject({ text: "Lá Mây" });
  });

  it("sets every line in a colour that reads on its scene", () => {
    const ir = motionGraphicTemplate({
      prompt: "Lá Mây",
      keyMessages: ["Trà hái tay mỗi sớm", "Hộp trà giao tận nơi"],
      callToAction: "Ghé Lá Mây hôm nay",
      brand: { ...brief.brand, palette: { ...brief.brand.palette, accent: "#d98e3f" } },
      directions: [{ id: "a", name: "A", concept: "Trà", visualStyle: "kinetic-typography" }],
    });
    expect(validateVideoIR(ir).ok).toBe(true);
    const ink = (sceneId: string, shotId: string) =>
      ir.scenes.find((s) => s.id === sceneId)?.shots.find((s) => s.id === shotId)?.style?.color;
    // One surface for the message cards; the high-energy profile spends the primary on the CTA alone.
    expect(ir.scenes.find((s) => s.id === "message-1")?.background?.color).toBe("background");
    expect(ink("message-1", "message-1-text")).toBe("foreground");
    // Dark green primary: the cream background colour, not the near-black foreground or the orange accent.
    expect(ir.scenes.find((s) => s.id === "cta")?.background?.color).toBe("primary");
    expect(ink("cta", "cta-text")).toBe("background");
    expect(ink("cta", "cta-logo")).toBe("background");
    // Cream background: the brand's own foreground.
    expect(ink("hook", "hook-text")).toBe("foreground");
    expect(ink("message-2", "message-2-text")).toBe("foreground");
  });

  it("lifts near-black scene fills off black so the QA gate does not count them as black frames", () => {
    const ir = motionGraphicTemplate({
      prompt: "Lá Mây",
      brand: {
        ...brief.brand,
        palette: { primary: "#000000", background: "#0e0e0e", foreground: "#ffffff" },
      },
    });
    const luma = (hex: string) =>
      0.299 * Number.parseInt(hex.slice(1, 3), 16) +
      0.587 * Number.parseInt(hex.slice(3, 5), 16) +
      0.114 * Number.parseInt(hex.slice(5, 7), 16);
    expect(luma(ir.brand?.palette.background ?? "")).toBeGreaterThanOrEqual(28);
    expect(luma(ir.brand?.palette.primary ?? "")).toBeGreaterThanOrEqual(28);
    expect(ir.brand?.palette.foreground).toBe("#ffffff");
  });

  it("fits a derived script into the length, keeping the hook and the call to action", () => {
    const brief = {
      prompt: "Studix intro",
      title: "Studix makes videos for your agents",
      aspectRatio: "16:9" as const,
      durationMs: 10_000,
      keyMessages: ["Briefs become motion graphics in minutes", "Every render passes a quality gate"],
      callToAction: "Try Studix free today",
    };
    // 6 + 6 + 6 + 4 words: 22, within the 28 a 10 s graphic holds, so nothing is cut.
    expect(wordCount(motionGraphicTemplate(brief).metadata?.voiceover as string)).toBe(22);
    const long = {
      ...brief,
      keyMessages: [...brief.keyMessages, "Agents call one tool, then poll it"],
    };
    // 29 words, one over: the last message card goes, the hook and the call to action stay.
    const ir = motionGraphicTemplate(long);
    const script = ir.metadata?.voiceover as string;
    expect(wordCount(script)).toBeLessThanOrEqual(28);
    expect(script.endsWith("Try Studix free today")).toBe(true);
    expect(ir.scenes.map((sc) => sc.id)).toEqual(["hook", "message-1", "message-2", "cta"]);
    // A hook and call to action too long to say whole are cut in their voice only; the card keeps its words.
    const hook =
      "Studix turns one short brief into a finished kinetic motion graphic with voice captions and sound";
    const cut = motionGraphicTemplate({ ...brief, title: hook, durationMs: 6_000, keyMessages: [] });
    const said = String(cut.metadata?.voiceover);
    // Cut by spoken length: the 16 words a 6 s graphic holds, English counted by its syllables.
    expect(spokenLength(said)).toBeLessThanOrEqual(voiceoverWordBudget(6_000));
    expect(spokenLength(said)).toBeGreaterThan(voiceoverWordBudget(6_000) - 2);
    expect(said.endsWith("Try Studix free today")).toBe(true);
    const title = cut.scenes[0]?.shots[0];
    expect(title && "text" in title ? title.text?.replace(/\s+/g, " ") : undefined).toBe(hook);
  });

  it("builds a valid captioned IR with its voice-over script and rejects beats that cannot fit", () => {
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
    const beats = [{ visual: "Chữ lớn", voiceover: long }, { visual: "Logo" }];
    const direction = { id: "d1", name: "Một", concept: "Trà", beats };
    expect(
      codeOf(() => motionGraphicTemplate({ prompt: "x", durationMs: 6_000, directions: [direction] })),
    ).toBe("VALIDATION");
  });

  it("gives a long hook the time it takes to say, not an even split with a short call to action", () => {
    const hook = "Motion graphic intro for Studix: kinetic title, videos made by agents in minutes";
    const ir = motionGraphicTemplate({
      prompt: hook,
      title: hook,
      durationMs: 10_000,
      callToAction: "Try Studix",
    });
    const [first, cta] = ir.scenes;
    expect(ir.scenes).toHaveLength(2);
    expect((first?.durationMs ?? 0) + (cta?.durationMs ?? 0)).toBe(10_000);
    expect(first?.durationMs).toBeGreaterThan(cta?.durationMs ?? 0);
    for (const line of voiceLines(ir)) {
      expect(line.roomMs).toBeGreaterThanOrEqual((wordCount(line.text) / VO_WORDS_PER_SECOND) * 1000);
    }
  });
});

describe("spoken length", () => {
  it("counts a Vietnamese syllable as a word and a loanword or brand by its syllables", () => {
    expect(spokenLength("Cà phê rang tại chỗ, view đồi thông Đà Lạt")).toBe(10);
    expect(spokenLength("Mua 1 tặng 1 cuối tuần")).toBe(6);
    // Read on prod in 2.6 s: five whitespace words, about eight words of speech at three a second.
    expect(spokenLength("Studix là studio video AI-native.")).toBeCloseTo(7.7, 1);
    expect(spokenLength("Studix turns one brief into a finished video")).toBe(8);
    expect(spokenLength("")).toBe(0);
  });

  it("reads unaccented Vietnamese, capitals and prices for what they take to say", () => {
    expect(spokenLength("Mua mot tang mot cuoi tuan nay", "vi")).toBe(7);
    expect(spokenLength("MUA NGAY HÔM NAY")).toBe(4);
    expect(spokenLength("Try MCP now")).toBeCloseTo(3.3, 1);
    expect(spokenLength("Giá chỉ 99.000đ")).toBe(8);
    expect(spokenLength("Giảm 50% hôm nay")).toBe(7);
    expect(spokenLength("Cà phê".normalize("NFD"))).toBe(2);
  });

  it("reads sale dates as two numbers, phone numbers a digit at a time and amounts by their places", () => {
    expect(spokenLength("12.12", "vi")).toBe(4);
    expect(spokenLength("11/11", "vi")).toBe(4);
    expect(spokenLength("Gọi ngay 0901 234 567")).toBe(12);
    expect(spokenLength("Gọi 0901234567")).toBe(11);
    expect(spokenLength("Hotline 1900-1234")).toBeCloseTo(9.3, 1);
    expect(spokenLength("10.000.000đ")).toBe(5);
    expect(spokenLength("Lãi 4,5%")).toBe(6);
    expect(spokenLength("Gọi 0901.234.567")).toBe(11);
    expect(spokenLength("+84 901 234 567")).toBe(11);
    expect(spokenLength("1900.6868")).toBe(8);
    // A year range is two years and "đến", never a phone number; a decimal point is a word too.
    expect(spokenLength("2024-2025")).toBe(15);
    expect(spokenLength("Thu Đông 2024 2025")).toBe(17);
    expect(spokenLength("12.5%")).toBe(6);
    expect(spokenLength("4.9 sao", "vi")).toBe(4);
    // All in capitals, a word is read as a word; a run with no vowel is still spelled out.
    expect(spokenLength("SALE SẬP SÀN TV")).toBeCloseTo(4.7, 1);
  });

  it("keeps a 15s sale ad with a date hook and a phone call to action", () => {
    const ad = {
      ...brief,
      durationMs: 15_000,
      callToAction: "Gọi ngay 0901 234 567",
      directions: [
        {
          id: "sale",
          name: "Sale 12.12",
          concept: "Flash sale trên sàn thương mại điện tử",
          hook: "Săn sale 12.12 trên Shopee",
          keyMessages: ["Giảm đến 50% toàn bộ cửa hàng", "Miễn phí vận chuyển"],
        },
      ],
    };
    const script = marketingScript(ad);
    expect(script.ads[0]?.beats).toHaveLength(4);
    expect(script.ads[0]?.beats.at(-1)?.voiceover).toBe("Gọi ngay 0901 234 567");
  });

  it("refuses a marketing beat whose line its beat cannot hold, before any paid stage", () => {
    const hook = "Studix là studio video AI-native cho marketer bận rộn mỗi ngày";
    const ad = { ...brief, directions: [{ ...brief.directions[0], hook }] };
    const err = (() => {
      try {
        marketingScript(ad);
      } catch (e) {
        return e as StudixError;
      }
    })();
    expect(err?.code).toBe("VALIDATION");
    expect(err?.message).toContain("longer than its beat");
  });

  it("refuses a storyboard whose cards, rounded up to 100ms, need more than the length", () => {
    // 10 + 10 + 8 words fit the 28-word budget of 10 s, but the cards need 3700 + 3400 + 3000 ms.
    const words = (n: number) => Array.from({ length: n }, () => "bốn").join(" ");
    const err = (() => {
      try {
        motionGraphicTemplate(
          { prompt: "Giới thiệu Studix", language: "vi", durationMs: 10_000, aspectRatio: "16:9" },
          {
            storyboard: {
              styleProfile: "apple-clean",
              beats: [10, 10, 8].map((n, i) => ({
                onScreen: `C${i}`,
                voiceover: words(n),
                enter: "fade",
                weight: 1,
              })),
              music: null,
            } as never,
          },
        );
      } catch (e) {
        return e as StudixError;
      }
    })();
    expect(err?.code).toBe("VALIDATION");
    expect(err?.details).toMatchObject({ words: 28, neededMs: 10_100, totalMs: 10_000 });
  });

  it("draws a storyboard beat's layout under its headline and keeps the call to action a CTA", () => {
    const beat = (onScreen: string, layout?: unknown) => ({
      onScreen,
      voiceover: `${onScreen}.`,
      visual: "A dark card.",
      enter: "fade",
      weight: 1,
      ...(layout ? { layout } : {}),
    });
    const ir = motionGraphicTemplate(
      {
        prompt: "A launch video introducing Studix",
        language: "en",
        durationMs: 15_000,
        aspectRatio: "16:9",
      },
      {
        storyboard: {
          styleProfile: "kinetic-typography",
          beats: [
            beat("Type a prompt", {
              kind: "prompt-box",
              text: "A 60s launch film for Studix",
              action: "Create",
            }),
            beat("Plug in any agent", { kind: "chips", hub: "Studix MCP", items: ["Claude", "ChatGPT"] }),
            beat("Watch it build"),
            beat("Start free", { kind: "stat", value: "100", label: "credits" }),
          ],
          music: null,
        } as never,
      },
    );
    expect(validateVideoIR(ir).ok).toBe(true);
    const hook = ir.scenes[0]!;
    expect(hook.shots.map((s) => [s.type, s.style?.region])).toEqual([
      ["title", "top"],
      ["layout", "middle"],
    ]);
    const layout = hook.shots[1];
    expect(layout?.type === "layout" && layout.layout.kind).toBe("prompt-box");
    expect(ir.scenes[2]!.shots.map((s) => s.type)).toEqual(["text"]);
    // The last beat stays the call to action, whatever layout it names.
    expect(ir.scenes[3]!.shots.some((s) => s.type === "layout")).toBe(false);
    // No mechanical alternation: every message card shares the scene background.
    expect(ir.scenes.slice(0, 3).map((s) => s.background?.color)).toEqual([
      "background",
      "background",
      "background",
    ]);
    expect(ir.metadata?.templateVersion).toBe(9);
    // Landscape has the room: a short headline over a layout is set at display size too.
    expect(hook.shots[0]?.style?.textStyle).toBe("display");
  });

  it("rejects a storyboard layout outside its typed shape", () => {
    const parsed = MotionStoryboard.safeParse({
      styleProfile: "kinetic-typography",
      beats: [1, 2, 3].map((i) => ({
        onScreen: `C${i}`,
        voiceover: "Hi.",
        visual: "Card.",
        enter: "fade",
        weight: 1,
        layout: { kind: "chips", hub: "Hub", items: ["only one"] },
      })),
      music: null,
      rationale: "r",
    });
    expect(parsed.success).toBe(false);
  });

  it("writes again a stored storyboard whose beats name a layout instead of typing it", () => {
    const stored = (layout: unknown) => ({
      source: "agent",
      storyboard: {
        styleProfile: "kinetic-typography",
        beats: [1, 2, 3].map((i) => ({
          onScreen: `C${i}`,
          voiceover: "Hi.",
          visual: "Card.",
          enter: "fade",
          weight: 1,
          layout,
        })),
        music: null,
        rationale: "r",
      },
    });
    const valid = (output: unknown) => motionGraphicStoryboardStage.isCheckpointValid?.(output as never, {});
    expect(valid(stored(null))).toBe(true);
    expect(valid({ ...stored("chips"), items: ["MCP", "API"] })).toBe(false);
  });

  it("names the brand the storyboard found in the brief, not the hook line, on the kit, title and CTA", () => {
    const named = (brandName: string | null) =>
      motionGraphicTemplate(
        { prompt: "A 10s launch motion graphic introducing Studix", language: "en", durationMs: 10_000 },
        {
          storyboard: {
            styleProfile: "apple-clean",
            beats: [
              {
                onScreen: "Describe a video. Get a film.",
                voiceover: "Describe a video.",
                enter: "fade",
                weight: 1,
              },
              { onScreen: "Agents do the rest", voiceover: "Agents do the rest.", enter: "fade", weight: 1 },
              { onScreen: "Try it now", voiceover: "Try it now.", enter: "fade", weight: 1 },
            ],
            music: null,
            brandName,
          } as never,
        },
      );
    const ctaLogo = (ir: VideoIR) => ir.scenes.at(-1)?.shots.find((s) => s.id === "cta-logo");
    const ir = named("Studix");
    expect(ir.brand?.name).toBe("Studix");
    expect(ir.title).toBe("Studix");
    expect(ctaLogo(ir)).toMatchObject({ type: "logo", text: "Studix" });
    // The brief's spelling wins over the agent's casing.
    expect(named("STUDIX").brand?.name).toBe("Studix");
    // A name the brief never writes as a whole word, or the hook line itself, is dropped, and the CTA
    // shows no hook line in its place.
    for (const ir of [named("Acme"), named("Stud"), named("Describe a video. Get a film."), named(null)]) {
      expect(ir.brand?.name).toBe("Describe a video. Get a film.");
      expect(ctaLogo(ir)).toBeUndefined();
    }
  });

  it("gives a motion-graphic card the time a mixed-language line takes to say", () => {
    const line = "Studix là studio video AI-native.";
    const ir = motionGraphicTemplate(
      { prompt: "Giới thiệu Studix", language: "vi", durationMs: 10_000, aspectRatio: "16:9" },
      {
        storyboard: {
          styleProfile: "apple-clean",
          beats: [
            { onScreen: "Studix", voiceover: "Từ một brief tới video hoàn chỉnh", enter: "fade", weight: 1 },
            { onScreen: "AI-native", voiceover: line, enter: "fade", weight: 1 },
            { onScreen: "Render", voiceover: "Agent lên kịch bản, dựng và render", enter: "fade", weight: 1 },
            { onScreen: "Thử ngay", voiceover: "Thử Studix ngay", enter: "fade", weight: 1 },
          ],
          music: null,
        } as never,
      },
    );
    const room = voiceLines(ir).find((l) => l.text === line)?.roomMs ?? 0;
    expect(room).toBeGreaterThanOrEqual((spokenLength(line, "vi") / VO_WORDS_PER_SECOND) * 1000);
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
    const paid = stages.filter((s) =>
      ["marketing-video.i2v", "marketing-video.audio", "marketing-video.voiceover"].includes(s.name),
    );
    expect(paid).toHaveLength(3);
    expect(paid.every((s) => s.requiresApprovedStoryboard === true)).toBe(true);
    const mg =
      packPipelines(packRegistry)("motion-graphic")?.stages({ fromVersion: false }, engine as never) ?? [];
    expect(mg.some((s) => s.name.includes("i2v"))).toBe(false);
  });
});
