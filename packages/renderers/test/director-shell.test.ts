import { describe, expect, it } from "vitest";
import {
  buildDirectorProject,
  checkSceneFragment,
  GSAP_ASSET,
  parseSceneFragmentFile,
  type SceneFragment,
  sceneFragmentFile,
  sceneFragmentProblems,
  timingWord,
} from "../src/index.ts";
import { HOOK_FRAGMENT, HOOK_TIMING, HOOK_WORDS } from "./director-fixture.ts";

const check = { sid: "s01-hook", words: HOOK_WORDS };
const problemsOf = (patch: Partial<SceneFragment>) =>
  sceneFragmentProblems({ ...HOOK_FRAGMENT, ...patch }, check);

describe("scene fragment contract", () => {
  it("accepts a realistic hook and scopes its CSS under the scene section", () => {
    const checked = checkSceneFragment(HOOK_FRAGMENT, check);
    expect(checked.problems).toEqual([]);
    expect(checked.section).toMatch(/^<section id="sc-s01-hook" class="scene layer" data-sid="s01-hook">/);
    expect(checked.css).toContain("#sc-s01-hook .pill {");
    expect(checked.css).not.toMatch(/^\.pill/m);
  });

  it("rejects network, media, handlers and anything that loads a URL", () => {
    expect(problemsOf({ html: '<img src="https://x.test/a.png">' }).join()).toContain("<img>");
    expect(problemsOf({ html: '<div onclick="x()">a</div>' }).join()).toContain("event handler");
    expect(problemsOf({ html: '<svg><use href="https://x.test/s.svg#a"/></svg>' }).join()).toContain("#ids");
    expect(problemsOf({ css: ".a { background: url(https://x.test/a.png); }" }).join()).toContain(
      "loads a URL",
    );
    expect(problemsOf({ css: "@import 'x.css';" }).join()).toContain("@import");
    expect(problemsOf({ js: 'fetch("/x");' }).join()).toContain("network");
    expect(problemsOf({ js: 'const u = "https://x.test";' }).join()).toContain("URLs");
  });

  it("rejects wall-clock, random and off-timeline motion, and broken syntax", () => {
    expect(problemsOf({ js: "const t = Date.now();" }).join()).toContain("wall clock");
    expect(problemsOf({ js: "const r = Math.random();" }).join()).toContain("Math.random");
    expect(problemsOf({ js: 'gsap.to(".a", { x: 1 });' }).join()).toContain("outside `tl`");
    expect(problemsOf({ css: ".a { transition: all 1s; }" }).join()).toContain("transition");
    expect(problemsOf({ js: "tl.to(" }).join()).toContain("syntax error");
  });

  it("rejects shell markers and selectors that reach sibling scenes", () => {
    expect(problemsOf({ css: "/*TIMING:BEGIN*/ .a { color: red; }" }).join()).toContain("shell markers");
    expect(problemsOf({ html: "<div><!--SCENES:END--></div>" }).join()).toContain("shell markers");
    expect(problemsOf({ css: ":scope ~ * { opacity: 0; }" }).join()).toContain("sibling scenes");
    expect(problemsOf({ css: "#sc-s01-hook + section { opacity: 0; }" }).join()).toContain("sibling scenes");
  });

  it("names W() words the scene does not speak, and passes when the job has no word timings", () => {
    const js = 'pop(".a", W(sid, "sunrise"));';
    expect(problemsOf({ js }).join()).toContain('"sunrise"');
    expect(sceneFragmentProblems({ ...HOOK_FRAGMENT, js }, { sid: "s01-hook" })).toEqual([]);
  });

  it("round-trips through the stored scene file", () => {
    const file = sceneFragmentFile("s01-hook", HOOK_FRAGMENT);
    expect(parseSceneFragmentFile(file)).toEqual({ sid: "s01-hook", fragment: HOOK_FRAGMENT });
    expect(parseSceneFragmentFile("<section></section>")).toBeUndefined();
  });

  it("normalises spoken words the way W() looks them up", () => {
    expect(timingWord("Studix,")).toBe("studix");
    expect(timingWord("Phim.")).toBe("phim");
    expect(timingWord("Đẹp!")).toBe("đẹp");
    expect(timingWord("let's")).toBe("let's");
  });
});

describe("director shell assembly", () => {
  const build = (fragment = HOOK_FRAGMENT) =>
    buildDirectorProject({
      width: 1080,
      height: 1920,
      timing: HOOK_TIMING,
      theme: { palette: { background: "#101010", foreground: "#fafafa", accent: "#ff5500" } },
      scenes: [{ sid: "s01-hook", fragment: checkSceneFragment(fragment, check) }],
    });

  it("splices theme, fonts, TIMING and the guarded fragment into an offline page", () => {
    const { files, copies } = build();
    const page = files.get("index.html") as string;
    expect(page).toContain('data-duration="3.537"');
    expect(page).toContain('data-ratio="9x16"');
    expect(page).toContain("--accent: #ff5500;");
    expect(page).toContain("@font-face");
    expect(page).toContain('window.TIMING={"duration":3.537');
    expect(page).toContain('const sid = "s01-hook"; const S = "#sc-s01-hook"; if (SC[sid]) {');
    expect(page).toContain('<section id="sc-s01-hook"');
    expect(page).not.toMatch(/__STUDIX_|https?:\/\/(?!www\.w3\.org)/);
    expect(copies.get(GSAP_ASSET)).toMatch(/gsap\.min\.js$/);
    expect([...copies.keys()].some((k) => k.startsWith("assets/fonts/"))).toBe(true);
  });

  it("keeps `$` in agent text literal and never lets it close the script", () => {
    const page = build({
      ...HOOK_FRAGMENT,
      js: `${HOOK_FRAGMENT.js}\nconst cost = "$& </script>";`,
    }).files.get("index.html") as string;
    expect(page).toContain('const cost = "$& <\\/script>";');
  });

  it("fills the pristine shell's markers, so marker text inside a scene cannot hijack the splice", () => {
    const checked = checkSceneFragment(HOOK_FRAGMENT, check);
    const page = buildDirectorProject({
      width: 1080,
      height: 1920,
      timing: HOOK_TIMING,
      theme: { palette: {} },
      // A fragment that slipped a marker past the check still lands only in its own slot.
      scenes: [{ sid: "s01-hook", fragment: { ...checked, css: "/*TIMING:BEGIN*/ .x{}" } }],
    }).files.get("index.html") as string;
    expect(page.indexOf("window.TIMING={")).toBeGreaterThan(page.indexOf("/*TIMING:BEGIN*/ .x{}"));
    expect(page).not.toContain("window.TIMING=null");
  });

  it("refuses a fragment that breaks the contract", () => {
    expect(() => build({ ...HOOK_FRAGMENT, js: 'fetch("x")' })).toThrow(/checked fragments/);
  });
});
