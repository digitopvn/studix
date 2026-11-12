import { describe, expect, it } from "vitest";
import { lintHeroHtml, type VideoIR, validateVideoIR } from "../src/index.ts";
import { loadFixture } from "./load-fixture.ts";

const CLEAN = `
<style>
  :root { --gap: 24px; }
  .card { display: grid; gap: var(--gap); color: var(--color-foreground); }
  .ring { fill: url(#glow); }
</style>
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
    // Markup the renderer's plain patterns would read differently from the lint.
    [
      "a comment opened in an attribute",
      '<div class="<!--"></div><style>-->"><script>x</script></style>',
      '"<" and ">"',
    ],
    [
      "a comment opened in the style block",
      "<style>x{} <!--</style><div>--></div>",
      '"<" is not allowed in CSS',
    ],
    ["an HTML comment", "<div><!-- note --></div>", "HTML comments are not allowed"],
    ["CSS nesting with &", "<style>.a{ :not(&){display:none} }</style><p>a</p>", "nested rule blocks"],
    ["a bare &", "<style>& .a{color:red}</style><p>a</p>", "CSS nesting"],
    [
      "a brace inside a selector string",
      '<style>a[class="{"], body *{display:none}</style><p>a</p>',
      "not allowed in strings",
    ],
    ["an unclosed rule", "<style>.a{color:red</style><p>a</p>", "must be closed"],
    ["a stray closing brace", "<style>.a{color:red}} body{}</style><p>a</p>", "must be closed"],
    ["an unclosed CSS comment", "<style>.a{color:red /*}</style><p>a</p>", "comment is not closed"],
    [
      "a string cut by a newline",
      '<style>.a{content:"x\n} body *{display:none}</style><p>a</p>',
      "must close on its line",
    ],
    ["an unclosed string", "<style>.a{content:'x}</style><p>a</p>", "must close on its line"],
    ["a CSS escape", "<style>a\\{x, body *{display:none}</style><p>a</p>", "backslash"],
    [
      "-webkit-image-set",
      "<div style='background: -webkit-image-set(\"https://x.test/a.png\" 1x)'>a</div>",
      "image-set()",
    ],
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
