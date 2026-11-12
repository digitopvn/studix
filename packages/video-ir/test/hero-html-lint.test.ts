import { describe, expect, it } from "vitest";
import { lintHeroHtml, type VideoIR, validateVideoIR } from "../src/index.ts";
import { loadFixture } from "./load-fixture.ts";

const CLEAN = `
<style>
  :root { --gap: 24px; }
  .card { display: grid; gap: var(--gap); color: var(--color-foreground); }
  .ring { fill: url(#glow); }
</style>
<!-- hero -->
<div class="card" role="group" aria-label="Launch">
  <h1 data-enter="slide-up" data-at="0.2" data-duration="0.6">Ra mắt <em>hôm nay</em></h1>
  <p data-enter="fade">Nhanh hơn<br>gọn hơn</p>
  <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="glow"><stop offset="0" stop-color="#fff"/></linearGradient></defs>
    <circle class="ring" cx="50" cy="50" r="40" fill="url(#glow)"/>
  </svg>
</div>`;

describe("lintHeroHtml", () => {
  it("passes a clean card", () => {
    expect(lintHeroHtml(CLEAN)).toEqual([]);
  });

  it.each([
    ["script", "<div><script>alert(1)</script></div>", "<script> is not allowed"],
    ["img", '<img src="x.png">', "<img> is not allowed"],
    ["onclick", '<div onclick="x()">a</div>', "event handlers"],
    ["external url", "<style>.a { background: url(http://x/y.png) }</style>", "external resource"],
    ["@import", "<style>@import 'x.css';</style>", "@import is not allowed"],
    ["position fixed", '<div style="position:fixed">a</div>', "position: fixed"],
    ["bad data-enter", '<div data-enter="spin">a</div>', '"spin" is not a motion preset'],
    ["bad data-at", '<div data-at="1e9">a</div>', "must be seconds"],
    ["unclosed", "<div><span>a</div>", "</span> was expected"],
    ["entity-encoded javascript", '<div style="x: &#106;avascript:1">a</div>', "javascript:"],
  ])("rejects %s", (_, html, problem) => {
    expect(lintHeroHtml(html).join("\n")).toContain(problem);
  });
});

describe("validateVideoIR html shots", () => {
  it("reports lint problems at the shot's html", () => {
    const ir = structuredClone(loadFixture("brand-intro-9x16.json")) as VideoIR;
    ir.scenes[0]!.shots[0] = { id: "hero", type: "html", startMs: 0, durationMs: 3000, html: CLEAN };
    expect(validateVideoIR(ir).ok).toBe(true);
    ir.scenes[0]!.shots[0] = {
      id: "hero",
      type: "html",
      startMs: 0,
      durationMs: 3000,
      html: "<iframe></iframe>",
    };
    const result = validateVideoIR(ir);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: "hero_html", path: "/scenes/0/shots/0/html" }),
      );
  });
});
