import { describe, expect, it } from "vitest";
import { promptFormatOf, withPromptFormat } from "../src/index.ts";

const LONG_FORM_PROMPT =
  "A masterpiece-grade 60-second 16:9 (1920x1080) English motion-graphic video about our launch. Exactly 60 seconds.";

describe("promptFormatOf", () => {
  it("reads hyphenated, minute and Vietnamese lengths", () => {
    expect(promptFormatOf(LONG_FORM_PROMPT)).toEqual({ aspectRatio: "16:9", durationMs: 60_000 });
    expect(promptFormatOf("a 1-minute explainer").durationMs).toBe(60_000);
    expect(promptFormatOf("a 1.5 minute explainer").durationMs).toBe(90_000);
    expect(promptFormatOf("1 minute and 30 seconds, vertical").durationMs).toBe(90_000);
    expect(promptFormatOf("Video dọc dài 2 phút").durationMs).toBe(120_000);
    expect(promptFormatOf("Video 15s cho quán cà phê").durationMs).toBe(15_000);
  });

  it("reads the frame shape from a pixel size or a platform word", () => {
    expect(promptFormatOf("render at 1080x1920").aspectRatio).toBe("9:16");
    expect(promptFormatOf("square 1080×1080 post").aspectRatio).toBe("1:1");
    expect(promptFormatOf("a TikTok ad").aspectRatio).toBe("9:16");
  });

  it("ignores decades, counts and lengths no brief accepts", () => {
    expect(promptFormatOf("an 80s retro look for the 1990s crowd")).toEqual({});
    expect(promptFormatOf("launch on 5 sites")).toEqual({});
    expect(promptFormatOf("a 20 minute documentary").durationMs).toBeUndefined();
  });
});

describe("withPromptFormat", () => {
  it("fills what the brief leaves unset and keeps explicit fields", () => {
    expect(withPromptFormat({ prompt: LONG_FORM_PROMPT })).toMatchObject({
      aspectRatio: "16:9",
      durationMs: 60_000,
    });
    expect(
      withPromptFormat({ prompt: LONG_FORM_PROMPT, aspectRatio: "1:1", durationMs: 20_000 }),
    ).toMatchObject({ aspectRatio: "1:1", durationMs: 20_000 });
    expect(withPromptFormat({ prompt: "Coffee brand video" })).toEqual({ prompt: "Coffee brand video" });
  });
});
