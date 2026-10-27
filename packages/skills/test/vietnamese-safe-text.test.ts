import { describe, expect, it } from "vitest";
import { breakLines, detectLanguage, normalizeText, truncateText, visibleLength } from "../src/index.ts";

describe("vietnamese-safe-text", () => {
  it("normalizes to NFC and collapses whitespace without folding diacritics", () => {
    const nfd = "  Tiếng   Việt\tcó dấu ".normalize("NFD");
    expect(normalizeText(nfd)).toBe("Tiếng Việt có dấu");
    expect(normalizeText(nfd)).toBe("Tiếng Việt có dấu".normalize("NFC"));
  });

  it("counts graphemes, not code units", () => {
    expect(visibleLength("Việt".normalize("NFD"))).toBe(4);
  });

  it("detects Vietnamese only from Vietnamese-specific letters", () => {
    expect(detectLanguage("Cà phê sữa đá")).toBe("vi");
    expect(detectLanguage("Ca phe")).toBe("en");
    expect(detectLanguage("Café crème")).toBe("en");
  });

  it("truncates at a space and adds an ellipsis", () => {
    expect(truncateText("Rang mới mỗi tuần, giao tận nơi", 20)).toBe("Rang mới mỗi tuần…");
    expect(truncateText("ngắn", 20)).toBe("ngắn");
  });

  it("breaks lines only at spaces, within the limit, and balanced", () => {
    const text = "100% Arabica trồng ở độ cao 1.500m trên cao nguyên Lâm Đồng";
    const broken = breakLines(text, 22);
    const lines = broken.split("\n");
    expect(lines.join(" ")).toBe(text);
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(22);
    const lengths = lines.map(visibleLength);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(8);
    expect(breakLines("Sương Mai", 22)).toBe("Sương Mai");
    // A balanced break avoids leaving one syllable alone on the last line.
    expect(breakLines("Mỗi sáng một tách cà phê", 20)).toBe("Mỗi sáng một\ntách cà phê");
  });

  it("prefers clause ends and keeps a number with its unit", () => {
    expect(breakLines("Rang mới mỗi tuần, giao tận nơi trong 24 giờ", 22)).toBe(
      "Rang mới mỗi tuần,\ngiao tận nơi\ntrong 24 giờ",
    );
  });

  it("keeps an over-long token on its own line instead of splitting it", () => {
    expect(breakLines("xem suongmai-coffee-roastery.example ngay", 12)).toBe(
      "xem\nsuongmai-coffee-roastery.example\nngay",
    );
  });
});
