import { describe, expect, it } from "vitest";
import { FeedbackInput } from "../src/studio/studio-types.ts";

const base = { projectId: "prj_1", shotId: "shot-1", comment: "Make the logo bigger" };
const png = "data:image/png;base64,iVBORw0KGgo=";

describe("feedback annotation", () => {
  it("accepts frame marks, a snapshot and references", () => {
    const parsed = FeedbackInput.parse({
      ...base,
      annotation: {
        intent: "change",
        priority: "must",
        frameMs: 1200,
        region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        pins: [{ x: 0.5, y: 0.5, label: "logo" }],
        strokes: [
          {
            tool: "arrow",
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ],
          },
        ],
        snapshot: png,
        references: [{ url: "https://example.com/look.jpg", note: "this color" }, { url: png }],
      },
    });
    expect(parsed.annotation?.pins).toHaveLength(1);
  });

  it("rejects marks outside the frame, unknown keys and non-image data URLs", () => {
    const bad = [
      { region: { x: 0.5, y: 0.5, w: 1.5, h: 0.1 } },
      { color: "red" },
      { snapshot: "data:text/html;base64,PGI+" },
      { references: [{ url: "javascript:alert(1)" }] },
      { strokes: [{ tool: "pen", points: [{ x: 0, y: 0 }] }] },
    ];
    for (const annotation of bad)
      expect(FeedbackInput.safeParse({ ...base, annotation }).success).toBe(false);
  });
});
