import { describe, expect, it } from "vitest";
import { splitCtaLine } from "../src/motion-graphic/motion-graphic-cta.ts";

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

  it("keeps a URL-only line as its text", () => {
    expect(splitCtaLine("studix.ai")).toEqual({ text: "studix.ai" });
  });
});

describe("splitCtaLine email", () => {
  it("leaves an email address in the text", () => {
    expect(splitCtaLine("Email hi@studix.ai")).toEqual({ text: "Email hi@studix.ai" });
  });
});
