import { readFileSync } from "node:fs";
import {
  type AssetRef,
  type CreativeBrief,
  type Shot,
  type VideoIR,
  validateVideoIR,
} from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import { BRAND_INTRO_MAX_MS, BRAND_INTRO_MIN_MS, brandIntroTemplate } from "../src/index.ts";

const viBrief: CreativeBrief = JSON.parse(
  readFileSync(new URL("./fixtures/brand-intro-vi-brief.json", import.meta.url), "utf8"),
);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const allShots = (ir: VideoIR): Shot[] => ir.scenes.flatMap((s) => s.shots);
const onScreenText = (ir: VideoIR): string[] =>
  allShots(ir).flatMap((s) => {
    if (s.type === "title") return [s.text, s.subtitle ?? ""];
    if (s.type === "text" || s.type === "cta") return [s.text];
    if (s.type === "logo") return [s.text ?? ""];
    return [];
  });

describe("brandIntroTemplate golden", () => {
  it("turns the Vietnamese brief into the golden IR", async () => {
    const ir = brandIntroTemplate(deepFreeze(structuredClone(viBrief)));
    expect(validateVideoIR(ir).ok).toBe(true);
    await expect(`${JSON.stringify(ir, null, 2)}\n`).toMatchFileSnapshot(
      "./__snapshots__/brand-intro-vi.ir.json",
    );
  });

  it("is deterministic and keeps Vietnamese copy intact", () => {
    const a = brandIntroTemplate(viBrief);
    expect(brandIntroTemplate(viBrief)).toEqual(a);
    expect(a.language).toBe("vi");
    expect(a.format).toEqual({ aspectRatio: "9:16", width: 1080, height: 1920, fps: 30, durationMs: 12_000 });
    expect(a.scenes.map((s) => s.id)).toEqual(["title", "message-1", "message-2", "outro"]);
    const text = onScreenText(a).join(" ").replace(/\n/g, " ");
    expect(text).toContain("100% Arabica trồng ở độ cao 1.500m trên cao nguyên Lâm Đồng");
    expect(text).toContain("Rang mới mỗi tuần, giao tận nơi trong 24 giờ");
    expect(text).toContain("Đặt ngay hôm nay");
    expect(text).toContain("Cà phê rang mộc từ Cầu Đất");
  });
});

describe("brandIntroTemplate rules", () => {
  it("stays within 6–15s with 2–3 message scenes", () => {
    for (const durationMs of [1000, 6000, 9000, 15_000, 600_000, undefined]) {
      const ir = brandIntroTemplate({ ...viBrief, durationMs });
      const messages = ir.scenes.filter((s) => s.role === "feature").length;
      expect(ir.format.durationMs).toBeGreaterThanOrEqual(BRAND_INTRO_MIN_MS);
      expect(ir.format.durationMs).toBeLessThanOrEqual(BRAND_INTRO_MAX_MS);
      expect(messages).toBeGreaterThanOrEqual(2);
      expect(messages).toBeLessThanOrEqual(3);
      expect(ir.scenes[0]!.role).toBe("intro");
      expect(ir.scenes.at(-1)!.role).toBe("cta");
      expect(validateVideoIR(ir).ok).toBe(true);
    }
    expect(brandIntroTemplate({ ...viBrief, durationMs: undefined }).format.durationMs).toBe(15_000);
    expect(brandIntroTemplate({ ...viBrief, durationMs: 600_000 }).metadata?.notes).toEqual([
      "duration 600000ms clamped to 15000ms",
    ]);
  });

  it("uses the brief's aspect ratio", () => {
    for (const aspectRatio of ["16:9", "1:1"] as const) {
      const ir = brandIntroTemplate({ ...viBrief, aspectRatio });
      expect(ir.format.aspectRatio).toBe(aspectRatio);
      expect(validateVideoIR(ir).ok).toBe(true);
    }
  });

  it("fills missing key messages and CTA without a brand, in the detected language", () => {
    const ir = brandIntroTemplate({ prompt: "Giới thiệu tiệm bánh mì Hội An", title: "Bánh mì Phượng" });
    expect(ir.language).toBe("vi");
    expect(ir.brand).toBeUndefined();
    expect(ir.scenes.filter((s) => s.role === "feature")).toHaveLength(2);
    expect(onScreenText(ir).map((t) => t.replace(/\n/g, " "))).toEqual([
      "Bánh mì Phượng",
      "",
      "Khám phá Bánh mì Phượng",
      "Trải nghiệm khác biệt cùng Bánh mì Phượng",
      "Tìm hiểu thêm",
    ]);
    expect(ir.metadata?.notes).toEqual(["2 key message(s) filled from template defaults"]);

    const en = brandIntroTemplate({
      prompt: "Launch video for a running shoe",
      keyMessages: ["Light as air"],
    });
    expect(en.language).toBe("en");
    expect(onScreenText(en)).toContain("Learn more");
  });

  it("normalizes decomposed input to NFC and never folds diacritics", () => {
    const nfd = "Cà phê sữa đá ngon nhất Sài Gòn".normalize("NFD");
    const ir = brandIntroTemplate({ prompt: "x", title: nfd, keyMessages: [nfd, "Đậm đà hương vị Việt"] });
    const text = onScreenText(ir).join("\n");
    expect(text).toBe(text.normalize("NFC"));
    expect(text).toContain("Đậm đà hương vị Việt");
    // The title duplicates the first message, so the duplicate is dropped rather than shown twice.
    expect(ir.scenes.filter((s) => s.role === "feature")).toHaveLength(2);
  });

  it("uses a supplied logo asset and falls back to the wordmark otherwise", () => {
    const logo: AssetRef = {
      id: "brand-logo",
      kind: "image",
      storageKey: "assets/brand-logo.png",
      sha256: "a".repeat(64),
      mime: "image/png",
      provenance: { source: "brand" },
    };
    const brief = { ...viBrief, brand: { ...viBrief.brand!, logoAssetId: "brand-logo" } };
    const withLogo = brandIntroTemplate(brief, { assets: [logo] });
    expect(withLogo.assets).toEqual([logo]);
    expect(allShots(withLogo).find((s) => s.id === "outro-logo")).toMatchObject({ assetId: "brand-logo" });

    const without = brandIntroTemplate(brief);
    expect(without.assets).toEqual([]);
    expect(without.brand?.logoAssetId).toBeUndefined();
    expect(allShots(without).find((s) => s.id === "outro-logo")).toMatchObject({ text: "Sương Mai Coffee" });
    expect(without.metadata?.notes).toContain(
      'logo asset "brand-logo" was not supplied; the outro uses the brand wordmark',
    );
  });

  it("rejects an invalid brief with VALIDATION", () => {
    expect(() => brandIntroTemplate({ prompt: "" })).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    expect(() => brandIntroTemplate({ prompt: "x", aspectRatio: "4:3" })).toThrow(
      expect.objectContaining({ code: "VALIDATION" }),
    );
  });
});
