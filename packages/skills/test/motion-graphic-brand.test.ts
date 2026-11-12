import { describe, expect, it } from "vitest";
import { imageInfo, parseBrandPage } from "../src/motion-graphic/motion-graphic-brand.ts";
import { motionGraphicTemplate } from "../src/motion-graphic/motion-graphic-template.ts";

describe("brand page", () => {
  it("reads the name, brand colours and logos, best first, of a home page", () => {
    const html = `<html><head>
      <title>Studix &amp; Co — AI video studio</title>
      <meta name="theme-color" content="#FFFFFF"><meta name="theme-color" content="#7c3aed">
      <link rel="mask-icon" href="/m.svg" color="#f59e0b">
      <style>:root{--brand-primary:#0EA5E9;--gray:#777}</style>
      <link rel="icon" href="/favicon.ico"><link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link rel="apple-touch-icon" sizes="120x120" href="/t120.png"><link rel="apple-touch-icon" sizes="180x180" href="/t180.png">
      <script type="application/ld+json">{"@type":"Organization","logo":{"url":"https://cdn.example/logo.svg"}}</script>
      </head><body><img class="site-logo" src="//cdn.example/header.png"><img src="http://plain.example/logo.png"></body></html>`;
    expect(parseBrandPage(html, "https://studix.example/vi/")).toEqual({
      name: "Studix & Co",
      // White is no brand colour; the grey custom property is not a brand property.
      colors: ["#7c3aed", "#f59e0b", "#0ea5e9"],
      logos: [
        "https://studix.example/t180.png",
        "https://studix.example/t120.png",
        "https://cdn.example/logo.svg",
        "https://cdn.example/header.png",
        "https://studix.example/icon.svg",
      ],
    });
    expect(parseBrandPage('<meta property="og:site_name" content="Lá Mây">', "https://x.example").name).toBe(
      "Lá Mây",
    );
  });

  it("sniffs a logo's type and size from its bytes, and refuses what is no image", () => {
    const png = Uint8Array.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 1, 0, 0, 0, 0, 64,
    ]);
    expect(imageInfo(png)).toEqual({ mime: "image/png", ext: ".png", width: 256, height: 64 });
    const svg = new TextEncoder().encode(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"/>',
    );
    expect(imageInfo(svg)).toEqual({ mime: "image/svg+xml", ext: ".svg", width: 300, height: 100 });
    expect(imageInfo(new TextEncoder().encode("<html><body>404</body></html>"))).toBeUndefined();
  });
});

describe("motion-graphic brand kit", () => {
  const brief = {
    prompt: "Motion graphic giới thiệu Lá Mây",
    language: "vi",
    durationMs: 9_000,
    keyMessages: ["Trà hái tay mỗi sớm"],
    callToAction: "Đặt trà ngay",
  };
  const logo = (width: number, height: number) => ({
    id: "brand-logo",
    kind: "image" as const,
    storageKey: "generated/job_1/brand-logo.png",
    sha256: "a".repeat(64),
    mime: "image/png",
    width,
    height,
    provenance: { source: "brand" as const },
  });

  it("restyles the graphic in the brand colours and sets its wordmark logo alone", () => {
    const ir = motionGraphicTemplate(brief, {
      brandFound: { name: "Lá Mây", colors: ["#2f6b4f", "#d98e3f"], logo: logo(600, 120) },
    });
    expect(ir.brand?.palette).toEqual(expect.objectContaining({ primary: "#2f6b4f", secondary: "#d98e3f" }));
    const shots = ir.scenes.flatMap((sc) => sc.shots).filter((sh) => sh.type === "logo");
    // A wide wordmark already carries the name: the hook shows it as a small lockup mark, the CTA at full size.
    expect(shots).toEqual([
      expect.objectContaining({ id: "hook-logo", assetId: "brand-logo", lockup: true }),
      expect.not.objectContaining({ lockup: true }),
    ]);
    expect(shots[0]).not.toHaveProperty("text");
    expect(ir.assets.map((a) => a.id)).toEqual(["brand-logo"]);
  });

  it("keeps the brief's own brand over what the site says", () => {
    const ir = motionGraphicTemplate(
      {
        ...brief,
        brand: {
          name: "Lá Mây Tea",
          palette: { primary: "#112233", background: "#ffffff", foreground: "#111111" },
          fonts: { heading: "Be Vietnam Pro", body: "Be Vietnam Pro" },
        },
      },
      { brandFound: { name: "Other", colors: ["#2f6b4f"], logo: logo(64, 64) } },
    );
    expect(ir.brand?.name).toBe("Lá Mây Tea");
    expect(ir.brand?.palette.primary).toBe("#112233");
    const cta = ir.scenes.at(-1)?.shots.find((sh) => sh.id === "cta-logo");
    expect(cta).toEqual(expect.objectContaining({ lockup: true, text: "Lá Mây Tea", assetId: "brand-logo" }));
  });
});
