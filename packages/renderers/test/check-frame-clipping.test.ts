import { describe, expect, it } from "vitest";
import { frameClippingProblems } from "../src/index.ts";

/** Findings as `hyperframes check --json` 0.8.223 reports a camera push-in on the reference hook. */
const pushIn = {
  ok: true,
  layout: {
    findings: [
      {
        code: "text_box_overflow",
        severity: "info",
        time: 0.589,
        selector: "div.kicker.hl > span:nth-of-type(1)",
        containerSelector: "#root",
        text: "Describe",
        overflow: { left: 147.83 },
      },
      {
        code: "canvas_overflow",
        severity: "info",
        time: 0.589,
        selector: "div.kicker.hl > span:nth-of-type(3)",
        containerSelector: "#root",
        text: "video.",
        overflow: { right: 160.2 },
      },
      {
        code: "panel_out_of_canvas",
        severity: "info",
        time: 0.589,
        selector: "div.pill",
        containerSelector: "#root",
        text: "A 15s film for my coffee brand",
        overflow: { left: 224.91, right: 224.91 },
      },
      // Text overflowing its own card, a glow off the edge and a hairline past it are not frame clipping.
      {
        code: "text_box_overflow",
        selector: "span.label",
        containerSelector: "div.card",
        text: "Pro",
        overflow: { right: 40 },
      },
      { code: "canvas_overflow", selector: "div.glow", containerSelector: "#root", overflow: { left: 300 } },
      {
        code: "canvas_overflow",
        selector: "div.chip",
        containerSelector: "#root",
        text: "MP4",
        overflow: { left: 3 },
      },
    ],
  },
};

describe("frame clipping from the HyperFrames check", () => {
  it("reports text and UI cut at the frame edge, one per element, widest first", () => {
    expect(frameClippingProblems(pushIn)).toEqual([
      expect.stringMatching(
        /^layout: "A 15s film for my coffee brand" \(div\.pill\) is cut 225px past the left/,
      ),
      expect.stringMatching(
        /^layout: "video\." \(div\.kicker\.hl\) is cut 160px past the right frame edge at 0\.59s/,
      ),
    ]);
  });

  it("ignores an element wholly outside the frame, mid entrance or exit", () => {
    const frame = { left: 0, top: 0, right: 1080, bottom: 1920, width: 1080, height: 1920 };
    const finding = (left: number, right: number) => ({
      code: "canvas_overflow",
      time: 0.2,
      selector: "div.title",
      containerSelector: "#root",
      text: "Launch day",
      overflow: { left: -left },
      rect: { left, top: 800, right, bottom: 900, width: right - left, height: 100 },
      containerRect: frame,
    });
    expect(frameClippingProblems({ layout: { findings: [finding(-600, -40)] } })).toEqual([]);
    expect(frameClippingProblems({ layout: { findings: [finding(-300, 260)] } })).toEqual([
      expect.stringMatching(/^layout: "Launch day" \(div\.title\) is cut 300px past the left/),
    ]);
  });

  it("gives nothing for a clean or unreadable report", () => {
    expect(frameClippingProblems({ ok: true, layout: { findings: [] } })).toEqual([]);
    expect(frameClippingProblems("not json")).toEqual([]);
    expect(frameClippingProblems({ layout: { findings: [{ code: 1 }] } })).toEqual([]);
  });
});
