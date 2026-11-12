import type { TenantContext } from "@studix/core";
import { StudixError } from "@studix/shared";
import { InMemoryStorageAdapter } from "@studix/storage";
import type { AssetRef, CreativeBrief, Shot } from "@studix/video-ir";
import type { StageContext, StageServices } from "@studix/workflow";
import { describe, expect, it, vi } from "vitest";
import {
  motionGraphicBrandStage,
  readBrandPage,
  sniffLogo,
} from "../src/motion-graphic/motion-graphic-brand.ts";
import { motionGraphicTemplate } from "../src/motion-graphic/motion-graphic-template.ts";

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};

const PAGE = `<!doctype html><html><head>
<title>Home | Lá Mây Tea</title>
<meta property="og:site_name" content="L&aacute; M&#226;y &amp; Co">
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#2E7D32">
<meta name="msapplication-TileColor" content="#da532c">
<link rel="mask-icon" href="/safari.svg" color="#333333">
<link rel="icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png">
<link rel="apple-touch-icon" sizes="120x120" href="/touch-120.png">
<link rel="apple-touch-icon" sizes="180x180" href="/touch-180.png">
<link rel="icon" type="image/svg+xml" href="https://cdn.example.com/logo.svg">
<script type="application/ld+json">{"@type":"Organization","logo":{"url":"/ld-logo.png"}}</script>
</head><body></body></html>`;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("readBrandPage", () => {
  it("reads the name, the vivid colours and the logo candidates in order", () => {
    const page = readBrandPage(PAGE, "https://lamay.example/vi/");
    expect(page.name).toBe("L&aacute; Mây & Co");
    expect(page.colors).toEqual(["#2e7d32", "#da532c"]);
    expect(page.logoUrls).toEqual([
      "https://cdn.example.com/logo.svg",
      "https://lamay.example/touch-180.png",
      "https://lamay.example/touch-120.png",
      "https://lamay.example/ld-logo.png",
      "https://lamay.example/icon-32.png",
    ]);
  });

  it("falls back to the title's first segment for the name", () => {
    expect(readBrandPage("<title>Acme — Rockets</title>", "https://acme.example/").name).toBe("Acme");
  });

  it("names the brand, not the page, from a title that leads with a page word", () => {
    const name = (title: string, url: string) => readBrandPage(`<title>${title}</title>`, url).name;
    expect(name("Home | Acme", "https://www.acme.com/")).toBe("Acme");
    expect(name("Trang chủ - Lá Mây", "https://lamay.com.vn/")).toBe("Lá Mây");
    expect(name("Welcome · Rockets for all", "https://example.org/")).toBe("Rockets for all");
    expect(name("Fast rockets | Acme Labs", "https://acmelabs.io/")).toBe("Acme Labs");
  });
});

describe("sniffLogo", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  it("takes an SVG document after a BOM, XML declaration, comment and doctype", () => {
    const svg =
      '\uFEFF<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg>\n<svg xmlns="http://www.w3.org/2000/svg"/>';
    expect(sniffLogo(bytes(svg))).toEqual({ mime: "image/svg+xml", ext: "svg" });
    expect(sniffLogo(PNG)).toEqual({ mime: "image/png", ext: "png" });
  });

  it("refuses an HTML page that only contains an inline SVG", () => {
    expect(sniffLogo(bytes("<!doctype html><html><body><svg></svg></body></html>"))).toBeUndefined();
    expect(sniffLogo(bytes("not found <svg></svg>"))).toBeUndefined();
  });
});

function stage(
  brief: CreativeBrief,
  services: Partial<StageServices>,
  signal = new AbortController().signal,
) {
  return {
    ctx,
    job: { id: "job_1" },
    attempt: 1,
    signal,
    input: { outputs: { brief: { brief } } },
    services,
  } as unknown as StageContext;
}

describe("motion-graphic brand stage", () => {
  it("skips the network without a brand URL or logo", async () => {
    const fetchPublic = vi.fn();
    const result = await motionGraphicBrandStage.run(stage({ prompt: "x" }, { fetchPublic }));
    expect(result.output).toEqual({});
    expect(fetchPublic).not.toHaveBeenCalled();
  });

  it("reads the site, stores its first real logo and warns about the ones it cannot use", async () => {
    const storage = new InMemoryStorageAdapter();
    const fetchPublic = vi.fn(async (url: string) => {
      if (url === "https://lamay.example/") {
        return {
          body: new TextEncoder().encode(PAGE),
          contentType: "text/html",
          url: "https://lamay.example/vi/",
        };
      }
      if (url.endsWith("logo.svg"))
        throw new StudixError("VALIDATION", "The input URL was refused: HTTP 404");
      return { body: PNG, contentType: "image/png", url };
    });
    const out = (
      await motionGraphicBrandStage.run(
        stage({ prompt: "x", brandUrl: "https://lamay.example/" }, { fetchPublic, storage }),
      )
    ).output as { name: string; colors: string[]; logo: AssetRef; warning?: string };
    expect(out).toMatchObject({ name: "L&aacute; Mây & Co", colors: ["#2e7d32", "#da532c"] });
    expect(out.logo).toMatchObject({
      id: "brand-logo",
      kind: "image",
      mime: "image/png",
      storageKey: "brand/job_1/logo.png",
      provenance: { source: "brand", sourceUrl: "https://lamay.example/touch-180.png" },
    });
    expect((await storage.head(ctx, "brand/job_1/logo.png"))?.sha256).toBe(out.logo.sha256);
    expect(out.warning).toBeUndefined();
  });

  it("never fails on an unreadable site or a fake logo, but still aborts", async () => {
    const storage = new InMemoryStorageAdapter();
    const fetchPublic = vi.fn(async () => {
      throw new StudixError("VALIDATION", "The input URL was refused: HTTP 500");
    });
    const brief = {
      prompt: "x",
      brandUrl: "https://down.example/",
      brandLogo: `data:image/png;base64,${Buffer.from("<html>no image</html>").toString("base64")}`,
    };
    const out = (await motionGraphicBrandStage.run(stage(brief, { fetchPublic, storage }))).output;
    expect(out).toEqual({ warning: expect.stringMatching(/could not be read: .*HTTP 500.*uploaded logo/s) });
    const noFetch = (await motionGraphicBrandStage.run(stage(brief, { storage }))).output;
    expect(noFetch).toEqual({ warning: expect.stringContaining("cannot fetch public URLs") });

    const abort = new AbortController();
    abort.abort(new StudixError("CANCELLED", "cancelled"));
    await expect(
      motionGraphicBrandStage.run(stage(brief, { fetchPublic, storage }, abort.signal)),
    ).rejects.toThrow("cancelled");
  });
});

describe("motion-graphic brand kit", () => {
  const logo: AssetRef = {
    id: "brand-logo",
    kind: "image",
    storageKey: "brand/job_1/logo.png",
    sha256: "a".repeat(64),
    mime: "image/png",
    provenance: { source: "brand" },
  };
  const brief = {
    prompt: "Motion graphic for a tea shop",
    title: "Fresh tea every morning",
    keyMessages: ["Hand-picked leaves"],
    callToAction: "Order now",
    brandColors: ["#2e7d32", "#ffb300"],
  };
  const logoShot = (shots: readonly Shot[]) => shots.find((s) => s.type === "logo");

  it("draws the logo lockup on the hook and CTA cards in the brand's colours", () => {
    const ir = motionGraphicTemplate(brief, {
      brandSource: { name: "Lá Mây", colors: ["#123456"], logo },
    });
    expect(ir.brand).toMatchObject({
      name: "Lá Mây",
      logoAssetId: "brand-logo",
      palette: { primary: "#2e7d32", accent: "#2e7d32", secondary: "#ffb300" },
    });
    expect(ir.assets).toEqual([logo]);
    const hook = ir.scenes[0]?.shots ?? [];
    expect(hook[0]).toMatchObject({
      id: "hook-logo",
      type: "logo",
      assetId: "brand-logo",
      text: "Lá Mây",
      lockup: true,
      startMs: 0,
      durationMs: ir.scenes[0]?.durationMs,
      style: { textStyle: "body", region: "top" },
    });
    expect(logoShot(ir.scenes.at(-1)?.shots ?? [])).toMatchObject({
      id: "cta-logo",
      assetId: "brand-logo",
      text: "Lá Mây",
      lockup: true,
      style: { textStyle: "heading" },
    });
  });

  it("takes the site's colours only when the brief sets none, and leaves the wordmark off a hook that names the brand", () => {
    const ir = motionGraphicTemplate(
      { prompt: "x", title: "Lá Mây tea, fresh daily", keyMessages: ["Hand-picked"] },
      { brandSource: { name: "Lá Mây", colors: ["#123456"] } },
    );
    expect(ir.brand?.palette).toMatchObject({ primary: "#123456", accent: "#123456" });
    expect(logoShot(ir.scenes[0]?.shots ?? [])).toBeUndefined();
    expect(logoShot(ir.scenes.at(-1)?.shots ?? [])).toMatchObject({ text: "Lá Mây" });
  });

  it("keeps the name the brief writes over the site's name", () => {
    const ir = motionGraphicTemplate(
      { prompt: "A launch motion graphic for Studix", language: "en" },
      {
        brandSource: { name: "Home", colors: [] },
        storyboard: {
          styleProfile: "apple-clean",
          beats: [
            { onScreen: "Describe a video.", voiceover: "Describe a video.", enter: "fade", weight: 1 },
            { onScreen: "Try it now", voiceover: "Try it now.", enter: "fade", weight: 1 },
          ],
          music: null,
          brandName: "Studix",
        } as never,
      },
    );
    expect(ir.brand?.name).toBe("Studix");
  });

  it("draws the mark alone on the hook when no name is known", () => {
    const ir = motionGraphicTemplate(
      { prompt: "x", title: "Fresh tea every morning", keyMessages: ["Hand-picked"] },
      { brandSource: { colors: [], logo } },
    );
    const hook = logoShot(ir.scenes[0]?.shots ?? []);
    expect(hook).toMatchObject({ id: "hook-logo", assetId: "brand-logo", lockup: true });
    expect(hook).not.toHaveProperty("text");
  });
});
