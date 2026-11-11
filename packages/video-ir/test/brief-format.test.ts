import { describe, expect, it } from "vitest";
import { promptFormatOf, withPromptFormat } from "../src/index.ts";

const LONG_FORM_PROMPT =
  "A masterpiece-grade 60-second 16:9 (1920x1080) English motion-graphic video about our launch. Exactly 60 seconds.";
const lengthOf = (prompt: string) => promptFormatOf(prompt).durationMs;
const ratioOf = (prompt: string) => promptFormatOf(prompt).aspectRatio;

describe("promptFormatOf", () => {
  it("reads the whole video's length in its common spellings", () => {
    expect(promptFormatOf(LONG_FORM_PROMPT)).toEqual({ aspectRatio: "16:9", durationMs: 60_000 });
    expect(lengthOf("a 1-minute explainer")).toBe(60_000);
    expect(lengthOf("a 1.5 minute explainer")).toBe(90_000);
    expect(lengthOf("1 minute and 30 seconds")).toBe(90_000);
    expect(lengthOf("a 1m30s video")).toBe(90_000);
    expect(lengthOf("Video dài 1p30")).toBe(90_000);
    expect(lengthOf("Video dọc dài 2 phút")).toBe(120_000);
    expect(lengthOf("Video 15s cho quán cà phê")).toBe(15_000);
  });

  it("prefers the whole video's length over a part's, a later minute or a timecode", () => {
    expect(lengthOf("A 30-second teaser for our 5-minute documentary")).toBe(30_000);
    expect(lengthOf("15s TikTok ad: book in 2 minutes")).toBe(15_000);
    expect(lengthOf("Show 3 scenes, each 5 seconds, total 30 seconds")).toBe(30_000);
    expect(lengthOf("Phần mở đầu 3 giây, tổng 30 giây")).toBe(30_000);
    expect(lengthOf("0.5s transitions, 15 second video")).toBe(15_000);
    expect(lengthOf("Scene at 0:15s shows the logo")).toBeUndefined();
  });

  it("ignores decades, counts and lengths no brief accepts", () => {
    expect(promptFormatOf("an 80s retro look for the 1990s crowd")).toEqual({});
    expect(lengthOf("an 80s-style ad, 20 seconds")).toBe(20_000);
    expect(promptFormatOf("launch on 5 sites")).toEqual({});
    expect(lengthOf("a 20 minute documentary")).toBeUndefined();
  });

  it("reads the frame shape only where the prompt ties it to the frame", () => {
    expect(ratioOf("render at 1080x1920")).toBe("9:16");
    expect(ratioOf("a vertical video for our café")).toBe("9:16");
    expect(ratioOf("Quảng cáo ngang cho tiệm trà")).toBe("16:9");
    expect(ratioOf("A vertical TikTok ad, use our 1200x1200 logo")).toBe("9:16");
    expect(ratioOf("A portrait of our founder")).toBeUndefined();
    expect(ratioOf("Summer sale on shorts, follow us on YouTube")).toBeUndefined();
    expect(ratioOf("Promote our 1:1 coaching sessions")).toBeUndefined();
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
