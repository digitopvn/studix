import { buildComposition } from "@studix/renderers";
import { describe, expect, it } from "vitest";
import { ctaCopy, cutOnWord, splitCtaLine } from "../src/motion-graphic/motion-graphic-cta.ts";
import { motionGraphicTemplate } from "../src/motion-graphic/motion-graphic-template.ts";

describe("splitCtaLine", () => {
  it("sets the URL apart and drops the brand name the wordmark already shows", () => {
    expect(splitCtaLine("Studix — Make a film. app.studix.digitop.ai", "Studix")).toEqual({
      text: "Make a film.",
      url: "app.studix.digitop.ai",
    });
  });

  it("keeps a scheme and a path, and drops a trailing full stop", () => {
    expect(splitCtaLine("Start free at https://example.com/start.")).toEqual({
      text: "Start free at",
      url: "https://example.com/start",
    });
  });

  it("leaves a line without a web address alone", () => {
    expect(splitCtaLine("Built on Node.js. Try it today")).toEqual({
      text: "Built on Node.js. Try it today",
    });
  });

  it("keeps a URL-only line as its text and its url", () => {
    expect(splitCtaLine("studix.ai")).toEqual({ text: "studix.ai", url: "studix.ai" });
  });
});

describe("splitCtaLine email", () => {
  it("leaves an email address in the text", () => {
    expect(splitCtaLine("Email hi@studix.ai")).toEqual({ text: "Email hi@studix.ai" });
  });
});

describe("ctaCopy", () => {
  it("gives a URL-only line the words of the first fallback that says more than a URL", () => {
    expect(
      ctaCopy("studix.ai", [undefined, "studix.ai", "Make your next launch film with Studix."], "Studix"),
    ).toEqual({ text: "Make your next launch film with Studix.", url: "studix.ai" });
  });

  it("keeps the URL alone when no fallback has words", () => {
    expect(ctaCopy("studix.ai", ["https://studix.ai"])).toEqual({ text: "studix.ai", url: "studix.ai" });
  });
});

describe("URL-only end card", () => {
  it("draws the lockup (line, rule, URL) from the closing voice-over, never the bare URL pill", () => {
    const ir = motionGraphicTemplate(
      { prompt: "A 10 second Studix intro", title: "Studix", language: "en", durationMs: 10_000 },
      {
        storyboard: {
          styleProfile: "apple-clean",
          beats: [
            { onScreen: "Describe a video.", voiceover: "Describe a video.", enter: "fade", weight: 1 },
            {
              onScreen: "studix.ai",
              voiceover: "Make your next launch film with Studix.",
              enter: "fade",
              weight: 1,
            },
          ],
          music: null,
          brandName: "Studix",
        } as never,
      },
    );
    const cta = ir.scenes.at(-1)?.shots.find((s) => s.type === "cta");
    expect(cta).toMatchObject({ type: "cta", url: "studix.ai" });
    expect(cta?.type === "cta" && cta.text.replace(/\s+/g, " ")).toBe(
      "Make your next launch film with Studix.",
    );
    const build = buildComposition(ir, { width: 540, height: 960, assetFiles: {} });
    const html = build.files.get(`compositions/${ir.scenes.at(-1)?.id}.html`) ?? "";
    expect(html).toContain('class="cta-url">studix.ai<');
    expect(html).toContain('class="cta-line">Make your next');
    expect(html).not.toContain("cta-pill");
  });
});

describe("cutOnWord", () => {
  it("never cuts mid-word", () => {
    expect(cutOnWord("Make your next launch film", 14)).toBe("Make your next");
    expect(cutOnWord("short", 14)).toBe("short");
  });
});
