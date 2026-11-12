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

  it("rejects js that redeclares a name the shell provides, and allows shadowing-free locals", () => {
    const problems = problemsOf({ js: 'const sid = "hook";\nlet { t0, end } = {};\nfunction lineIn() {}' });
    expect(problems).toEqual([
      "js: `sid` is already provided by the Studix shell; do not declare it, use it as is",
      "js: `t0` is already provided by the Studix shell; do not declare it, use it as is",
      "js: `lineIn` is already provided by the Studix shell; do not declare it, use it as is",
    ]);
    expect(problemsOf({ js: 'const sidebar = $s(".a"); const $t = 1; pop(sidebar, t0 + $t);' })).toEqual([]);
  });

  it("rejects a ghosted headline: headline-sized text at low opacity or in a dimmed ink", () => {
    const withFloor = (css: string) =>
      sceneFragmentProblems({ ...HOOK_FRAGMENT, css }, { ...check, headlinePx: 72 });
    expect(withFloor(".ghost{font-size:180px;opacity:0.25}").join()).toContain("ghosted");
    expect(withFloor(".ghost{font-size:120px;color:var(--faint)}").join()).toContain("ghosted");
    // An entry state (opacity 0), an opaque headline and small dim labels pass.
    expect(withFloor(".h{font-size:96px;opacity:0;color:var(--ink)} .l{font-size:24px;opacity:.4}")).toEqual(
      [],
    );
    // Without a floor the rule is not checked.
    expect(problemsOf({ css: ".ghost{font-size:180px;opacity:0.25}" })).toEqual([]);
  });

  it("rejects blur filters, backdrop-filter and will-change that stall the render", () => {
    const css =
      ".aura{filter:blur(80px)} .g{backdrop-filter:blur(4px)} .s{will-change:transform} .ok{filter:saturate(1.2)}";
    const problems = problemsOf({ css });
    expect(problems.filter((p) => p.includes("too slow"))).toHaveLength(3);
    expect(problems.some((p) => p.startsWith("css: filter: ") && p.includes("radial-gradient"))).toBe(true);
    expect(problemsOf({ js: 'tl.to(".g", { filter: "blur(1.5px)", duration: 1 }, t0);' })).toEqual([
      expect.stringMatching(/^js: tweening or setting filter.*too slow/),
    ]);
    expect(
      problemsOf({ js: "const xs = [1, 2].filter((x) => x > 1 ? true : false); pop(S, t0 + xs.length);" }),
    ).toEqual([]);
  });

  it("rejects classes the shell owns but lets a container reuse a helper class name", () => {
    expect(problemsOf({ html: '<div class="cam"><p class="scene cap">Hi</p></div>' })).toEqual([
      expect.stringContaining('class "scene" is reserved'),
      expect.stringContaining('class "cap" is reserved'),
    ]);
    expect(
      problemsOf({ html: '<div class="film-frame sweep"><svg></svg><i class="glass"></i></div>' }),
    ).toEqual([]);
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

  it("styles only the helper-owned sweep and ripple bars, never a fragment's .sweep container", () => {
    const page = build({
      ...HOOK_FRAGMENT,
      html: '<div class="film-frame sweep"><svg></svg></div>',
      css: ".film-frame{left:160px;top:400px;width:760px;height:428px}",
      js: 'sweep(".film-frame", t0 + 0.5);',
    }).files.get("index.html") as string;
    const shellCss = page.slice(0, page.indexOf("/*SCENE-CSS:BEGIN*/"));
    expect(shellCss).not.toMatch(/(?:^|[\s,}])\.(?:sweep|ripple)\b[^{]*\{/);
    expect(shellCss).toMatch(/\.sx-sweep-bar \{[^}]*opacity: 0/);
    expect(page).toContain('sw = document.createElement("i")');
  });

  it("refuses a fragment that breaks the contract", () => {
    expect(() => build({ ...HOOK_FRAGMENT, js: 'fetch("x")' })).toThrow(/checked fragments/);
  });
});
