import { writtenCaptionText } from "@studix/renderers";
import { describe, expect, it } from "vitest";
import { captionCues, chunkCaption, MAX_CAPTION_WORDS, wordCount } from "../src/index.ts";

const burned = (line: string) => chunkCaption(line).map(writtenCaptionText);

describe("caption chunks at phrase boundaries", () => {
  it("never ends a cue on a word that leans on the next one", () => {
    expect(chunkCaption("Budget caps give you control over spending at one US cent per credit.")).toEqual([
      "Budget caps give you control over spending",
      "at one US cent per credit.",
    ]);
    expect(
      chunkCaption(
        "Studix gives Claude, Cursor or any agent a real motion studio through one HTTPS slash MCP endpoint.",
      ),
    ).toEqual([
      "Studix gives Claude,",
      "Cursor or any agent a real motion studio",
      "through one HTTPS slash MCP endpoint.",
    ]);
  });

  it("prefers a sentence end, then a clause end, inside the limit", () => {
    expect(chunkCaption("Write the brief. Studix plans every scene and cuts the film.")).toEqual([
      "Write the brief.",
      "Studix plans every scene and cuts the film.",
    ]);
    const chunks = chunkCaption(
      "One prompt in, a finished film out, with music, captions and a voice that fits",
    );
    expect(chunks.every((c) => wordCount(c) <= MAX_CAPTION_WORDS + 1)).toBe(true);
    expect(chunks[0]).toBe("One prompt in, a finished film out, with music,");
  });

  it("keeps a spoken web address in one cue and burns it as written", () => {
    expect(burned("Start your next launch film at app dot studix dot digitop dot ai")).toEqual([
      "Start your next launch film at app.studix.digitop.ai",
    ]);
    expect(burned("Try it today at studix dot ai slash pricing. It takes about a minute.")).toEqual([
      "Try it today at studix.ai/pricing.",
      "It takes about a minute.",
    ]);
  });

  it("times an address cue by its spoken words, not its written form", () => {
    const cues = captionCues(
      "Open app dot studix dot digitop dot ai now. Describe the film you want and press go.",
      0,
      6000,
    );
    expect(cues[0]?.text).toBe("Open app dot studix dot digitop dot ai now.");
    expect((cues[0]?.endMs ?? 0) - (cues[0]?.startMs ?? 0)).toBeGreaterThan(3000);
  });
});

describe("written caption text", () => {
  it("maps spoken addresses only", () => {
    expect(writtenCaptionText("Visit app dot Studix dot ai.")).toBe("Visit app.studix.ai.");
    expect(writtenCaptionText("Ghé studix chấm vn nhé")).toBe("Ghé studix.vn nhé");
    expect(writtenCaptionText("version two dot five ships today")).toBe("version two dot five ships today");
    expect(writtenCaptionText("one HTTPS slash MCP endpoint")).toBe("one HTTPS slash MCP endpoint");
  });

  it("leaves prose with a spoken dot alone", () => {
    expect(writtenCaptionText("Add a dot so the line")).toBe("Add a dot so the line");
    expect(writtenCaptionText("the dot com bubble")).toBe("the dot com bubble");
  });

  it("lowercases only the host and keeps the line's own breaks", () => {
    expect(writtenCaptionText("Go to Studix dot ai slash Pricing\nnow")).toBe("Go to studix.ai/Pricing\nnow");
  });
});
