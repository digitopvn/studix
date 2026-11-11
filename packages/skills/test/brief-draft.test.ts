import { describe, expect, it } from "vitest";
import {
  applyBriefDraft,
  BriefDraft,
  brandIntroTemplate,
  DEFAULT_BRAND_PALETTE,
  draftBriefFromPrompt,
  needsBriefDraft,
} from "../src/index.ts";

const VI_PROMPT =
  "Video giới thiệu thương hiệu cà phê Sương Mai cho khách hàng trẻ ở thành phố, dài 6 giây, dọc.\n" +
  "Rang mới mỗi tuần. Giao tận nơi trong 24 giờ. Đặt ngay hôm nay!";

describe("draftBriefFromPrompt", () => {
  it("reads comma-separated messages after a colon in a one-sentence prompt", () => {
    const draft = draftBriefFromPrompt(
      "Làm video giới thiệu thương hiệu cà phê Sương Mai: rang mộc, vị đậm, giao nhanh trong 30 phút.",
    );
    expect(draft.brandName).toBe("Sương Mai");
    expect(draft.keyMessages).toEqual(["rang mộc", "vị đậm", "giao nhanh trong 30 phút"]);
  });

  it("extracts brand, messages, CTA, audience and format from a Vietnamese prompt", () => {
    const draft = draftBriefFromPrompt(VI_PROMPT);
    expect(draft).toEqual({
      title: "Sương Mai",
      brandName: "Sương Mai",
      keyMessages: ["Rang mới mỗi tuần", "Giao tận nơi trong 24 giờ"],
      callToAction: "Đặt ngay hôm nay!",
      audience: "khách hàng trẻ ở thành phố",
      language: "vi",
      aspectRatio: "9:16",
      durationMs: 6000,
    });
  });

  it("keeps diacritics of decomposed (NFD) input and stays deterministic", () => {
    const nfd = VI_PROMPT.normalize("NFD");
    const draft = draftBriefFromPrompt(nfd);
    expect(draft.brandName).toBe("Sương Mai");
    expect(draft.keyMessages[0]).toBe("Rang mới mỗi tuần".normalize("NFC"));
    expect(draftBriefFromPrompt(nfd)).toEqual(draft);
  });

  it("handles English prompts, quoted brands, bullets and clamps the duration", () => {
    const draft = draftBriefFromPrompt(
      'A 40 second landscape intro for "acme robotics".\n- Robots that fold laundry\n- Built in Saigon\nVisit acme.example today.',
    );
    expect(draft).toMatchObject({
      brandName: "acme robotics",
      keyMessages: ["Robots that fold laundry", "Built in Saigon"],
      callToAction: "Visit acme.example today",
      language: "en",
      aspectRatio: "16:9",
      durationMs: 15_000,
    });
  });

  it("returns a valid draft without a brand when the prompt names none", () => {
    const draft = draftBriefFromPrompt("make something nice about coffee");
    expect(BriefDraft.safeParse(draft).success).toBe(true);
    expect(draft.brandName).toBeUndefined();
    expect(draft.keyMessages).toEqual([]);
  });
});

describe("applyBriefDraft", () => {
  it("fills only missing brief fields and builds a default-palette brand kit", () => {
    const brief = { prompt: VI_PROMPT, durationMs: 9000 };
    expect(needsBriefDraft(brief)).toBe(true);
    const merged = applyBriefDraft(brief, draftBriefFromPrompt(VI_PROMPT));
    expect(merged.durationMs).toBe(9000);
    expect(merged.brand?.name).toBe("Sương Mai");
    expect(merged.brand?.palette).toEqual(DEFAULT_BRAND_PALETTE);
    expect(merged.keyMessages).toHaveLength(2);
    expect(needsBriefDraft(merged)).toBe(false);

    const ir = brandIntroTemplate(merged);
    expect(ir.language).toBe("vi");
    expect(ir.format.durationMs).toBe(9000);
    const texts = ir.scenes.flatMap((s) => s.shots.map((shot) => ("text" in shot ? shot.text : "")));
    expect(texts.map((t) => t?.replace(/\n/g, " "))).toContain("Giao tận nơi trong 24 giờ");
  });

  it("never overrides a brand the user supplied", () => {
    const brand = {
      name: "Digitop",
      palette: { primary: "#111111", background: "#000000", foreground: "#FFFFFF" },
      fonts: { heading: "Inter", body: "Inter" },
    };
    const merged = applyBriefDraft(
      { prompt: "x", brand },
      { brandName: "Other", keyMessages: [], palette: { primary: "#222222" } },
    );
    expect(merged.brand).toEqual(brand);
  });
});

describe("promptFormatHints", () => {
  it("reads a hyphenated length and an aspect ratio, clamped to the workflow range", async () => {
    const { promptFormatHints } = await import("../src/brand-intro/brief-draft-from-prompt.ts");
    expect(promptFormatHints("A 60-second 16:9 intro", { minMs: 6_000, maxMs: 60_000 })).toEqual({
      aspectRatio: "16:9",
      durationMs: 60_000,
    });
    expect(promptFormatHints("video dọc 1 phút", { minMs: 6_000, maxMs: 30_000 })).toEqual({
      aspectRatio: "9:16",
      durationMs: 30_000,
    });
  });
});
