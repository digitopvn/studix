import { describe, expect, it } from "vitest";
import { marketingScript } from "../src/marketing-video/marketing-script.ts";
import { marketingVideoIr } from "../src/marketing-video/marketing-video-template.ts";
import { motionGraphicTemplate } from "../src/motion-graphic/motion-graphic-template.ts";
import { MAX_VOICE_DIRECTION_CHARS, voiceDirection } from "../src/voice-direction.ts";

const brand = {
  name: "Lá Mây",
  palette: { primary: "#2f5d50", accent: "#e0b354", background: "#f7f3ea", foreground: "#1c1c1c" },
  fonts: { heading: "Inter", body: "Inter" },
  voice: ["ấm áp", "tinh tế"],
};

describe("voice-over direction", () => {
  it("reads a motion graphic's hook, messages and call to action in order, in its language and tone", () => {
    const ir = motionGraphicTemplate({
      prompt: "Motion graphic giới thiệu tiệm trà Lá Mây",
      language: "vi",
      durationMs: 12_000,
      keyMessages: ["Trà hái tay mỗi sớm"],
      callToAction: "Đặt trà ngay",
      brand,
    });
    const direction = voiceDirection(ir) ?? "";
    expect(direction).toContain("Vietnamese");
    expect(direction).toContain("Tone of voice: ấm áp, tinh tế.");
    const hook = direction.indexOf("lean in");
    const message = direction.indexOf("carry the message");
    const cta = direction.indexOf("call to action");
    expect(hook).toBeGreaterThan(-1);
    expect(message).toBeGreaterThan(hook);
    expect(cta).toBeGreaterThan(message);
  });

  it("directs each ad of a marketing video from its own beats", () => {
    const script = marketingScript({
      prompt: "Ads cho tiệm trà",
      language: "vi",
      durationMs: 20_000,
      directions: [
        {
          id: "morning",
          name: "Buổi sáng",
          concept: "Một tách trà buổi sáng",
          beats: [
            {
              visual: "ấm trà",
              onScreen: "Sáng nay uống trà chưa?",
              voiceover: "Sáng nay bạn uống trà chưa?",
            },
            { visual: "lá trà", voiceover: "Trà hái tay mỗi sớm." },
            { visual: "tiệm", onScreen: "Ghé Lá Mây", voiceover: "Ghé Lá Mây hôm nay." },
          ],
        },
      ],
    });
    const ir = marketingVideoIr(script, undefined, "Lá Mây");
    const direction = voiceDirection(ir, 0, 20_000) ?? "";
    expect(direction).toMatch(/lean in.*carry the message.*call to action/);
    expect(direction).toContain("Tone of voice: warm, confident.");
    expect(direction.length).toBeLessThanOrEqual(MAX_VOICE_DIRECTION_CHARS);
    expect(voiceDirection(ir, 20_000, 40_000)).toBeUndefined();
  });

  it("keeps free-text brand keywords from breaking the direction", () => {
    const ir = motionGraphicTemplate({
      prompt: "Trà",
      language: "vi",
      durationMs: 12_000,
      keyMessages: ["Trà hái tay mỗi sớm"],
      brand: { ...brand, voice: ["ấm\náp", "a", "b", "c", "d", "e"] },
    });
    const direction = voiceDirection(ir) ?? "";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting that none are left.
    expect(direction).not.toMatch(/[\u0000-\u001f]/);
    expect(direction).toContain("Tone of voice: ấm áp, a, b, c.");
  });
});
