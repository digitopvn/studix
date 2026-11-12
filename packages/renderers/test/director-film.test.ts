import { describe, expect, it } from "vitest";
import {
  attributeFilmCheck,
  blankCutScenes,
  buildDirectorProject,
  checkSceneFragment,
  cutFrames,
  cutLumaCommand,
  filmFrameRanges,
  filmSplitCommand,
  hexLuma,
  markSymbolFromSvg,
  monogramInitials,
  parseCutLuma,
  sceneFragmentProblems,
  scenesThrownInLog,
} from "../src/index.ts";
import { HOOK_FRAGMENT, HOOK_TIMING } from "./director-fixture.ts";

const windows = [
  { id: "s01", startMs: 0, endMs: 2_017 },
  { id: "s02", startMs: 2_017, endMs: 4_983 },
  { id: "s03", startMs: 4_983, endMs: 8_000 },
];

describe("film split", () => {
  it("tiles the film with frame ranges that start on the first frame at or after each cut", () => {
    const ranges = filmFrameRanges(windows, 30);
    // 2017 ms is frame 60.51 and 4983 ms frame 149.49: both scenes start on the next whole frame.
    expect(ranges).toEqual([
      { sid: "s01", startFrame: 0, endFrame: 61 },
      { sid: "s02", startFrame: 61, endFrame: 150 },
      { sid: "s03", startFrame: 150, endFrame: 240 },
    ]);
    expect(filmFrameRanges([{ id: "a", startMs: 0, endMs: 2000 }], 30)).toEqual([
      { sid: "a", startFrame: 0, endFrame: 60 },
    ]);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]?.startFrame).toBe(ranges[i - 1]?.endFrame);
  });

  it("decodes once and re-encodes each scene's exact frames to its own silent clip", () => {
    const ranges = filmFrameRanges(windows, 30);
    const cmd = filmSplitCommand(
      "out/film.mp4",
      [ranges[0], ranges[2]].map((r) => ({ ...r!, path: `out/${r!.sid}.mp4` })),
    );
    expect(cmd).toBe(
      'ffmpeg -v error -y -i out/film.mp4 -filter_complex "[0:v]split=2[v0][v1];' +
        "[v0]trim=start_frame=0:end_frame=61,setpts=PTS-STARTPTS[o0];" +
        '[v1]trim=start_frame=150:end_frame=240,setpts=PTS-STARTPTS[o1]" ' +
        '-map "[o0]" -an -c:v libx264 -preset veryfast -crf 12 -pix_fmt yuv420p -movflags +faststart out/s01.mp4 ' +
        '-map "[o1]" -an -c:v libx264 -preset veryfast -crf 12 -pix_fmt yuv420p -movflags +faststart out/s03.mp4',
    );
    expect(cmd).not.toContain("-c copy");
    expect(() => filmSplitCommand("out/a b.mp4", [{ ...ranges[0]!, path: "out/x.mp4" }])).toThrow();
  });
});

describe("blank frames at cuts", () => {
  const ranges = filmFrameRanges(windows, 30);

  it("measures two frames either side of every cut", () => {
    expect(cutFrames(ranges)).toEqual([0, 1, 2, 59, 60, 61, 62, 63, 148, 149, 150, 151, 152]);
    const cmd = cutLumaCommand("out/film.mp4", [0, 1, 60], "out/luma.txt");
    expect(cmd).toContain(
      "select='eq(n,0)+eq(n,1)+eq(n,60)',signalstats,metadata=mode=print:file=out/luma.txt",
    );
  });

  it("flags the scene that owns a frame showing only the background", () => {
    const bg = "#0b0b10";
    const y = hexLuma(bg);
    const frame = (n: number, avg: number, spread: number) =>
      `frame:${n} pts:${n} pts_time:${(n / 30).toFixed(6)}\nlavfi.signalstats.YAVG=${avg}\n` +
      `lavfi.signalstats.YLOW=${avg - spread / 2}\nlavfi.signalstats.YHIGH=${avg + spread / 2}\n`;
    const text = [
      frame(59, y + 40, 90), // s01's last frames: content
      frame(60, y + 38, 80),
      frame(61, y + 2, 4), // s02 opens empty
      frame(62, y + 3, 6),
      frame(63, y + 30, 70),
      frame(148, y + 1, 2), // s02 closes empty, but s02 is the only scene measured below
      frame(150, y + 50, 120),
    ].join("");
    const lumas = parseCutLuma(text, 30);
    expect(lumas).toHaveLength(7);
    expect(lumas[2]).toMatchObject({ frame: 61 });
    expect(blankCutScenes(ranges, lumas, bg)).toEqual([{ sid: "s02", frames: [61, 62, 148] }]);
    expect(blankCutScenes(ranges, lumas, bg, new Set(["s03"]))).toEqual([]);
  });

  it("never takes a frame with an empty product panel for a blank one", () => {
    // A panel of 6% ink over the page covering 40% of a dark frame: the 90th percentile sits on the panel.
    const bg = "#0b0b10";
    const y = hexLuma(bg);
    const panel = hexLuma("#191a1e");
    const avg = 0.6 * y + 0.4 * panel;
    const lumas = parseCutLuma(
      `frame:61 pts:61 pts_time:${(61 / 30).toFixed(6)}\nlavfi.signalstats.YAVG=${avg}\n` +
        `lavfi.signalstats.YLOW=${y}\nlavfi.signalstats.YHIGH=${panel}\n`,
      30,
    );
    expect(blankCutScenes(ranges, lumas, bg)).toEqual([]);
  });

  it("judges blank against the background, so a light theme's white page is blank too", () => {
    const lumas = parseCutLuma(
      "frame:0 pts:0 pts_time:0\nlavfi.signalstats.YAVG=233\nlavfi.signalstats.YLOW=230\nlavfi.signalstats.YHIGH=235\n",
      30,
    );
    expect(blankCutScenes(ranges, lumas, "#ffffff")).toEqual([{ sid: "s01", frames: [0] }]);
    expect(blankCutScenes(ranges, lumas, "#101010")).toEqual([]);
  });
});

describe("film check attribution", () => {
  const scenes = [
    { sid: "s01", start: 0, end: 2 },
    { sid: "s02", start: 2, end: 5 },
  ];
  const section = (findings: unknown[] = []) => ({ errorCount: 0, findings });

  it("names each scene's errors by selector, logged throw or time, and keeps the rest film-level", () => {
    const verdict = attributeFilmCheck(
      {
        lint: section([
          { code: "unknown_selector", severity: "error", selector: "#sc-s02 .pill", message: "x" },
          { code: "style", severity: "warning", selector: "#sc-s01 .a" },
        ]),
        runtime: section([
          { code: "console_error", severity: "error", message: "[studix-scene s01] boom is not defined" },
          { code: "tween_error", severity: "error", time: 3.1, message: "bad target" },
          { code: "page_error", severity: "error", message: "shell broke" },
        ]),
        layout: section([
          {
            code: "canvas_overflow",
            severity: "info",
            selector: "#sc-s02 .title",
            containerSelector: "#root",
            text: "Your film",
            overflow: { left: 40 },
            time: 3,
          },
        ]),
      },
      scenes,
    );
    expect(verdict.readable).toBe(true);
    expect(verdict.errors.get("s01")).toEqual(["console_error [studix-scene s01] boom is not defined"]);
    expect(verdict.errors.get("s02")).toEqual(["unknown_selector #sc-s02 .pill x", "tween_error bad target"]);
    expect(verdict.film).toEqual(["page_error shell broke"]);
    expect(verdict.layout.get("s02")?.[0]).toContain('"Your film"');
    expect(verdict.layout.has("s01")).toBe(false);
  });

  it("fails the whole film on errors the report counts but does not list", () => {
    const verdict = attributeFilmCheck({ lint: { errorCount: 2, findings: [] }, runtime: section() }, scenes);
    expect(verdict.film).toEqual(["lint: 2 error(s) without findings"]);
  });

  it("reads nothing from a missing or broken report", () => {
    expect(attributeFilmCheck(undefined, scenes).readable).toBe(false);
    expect(attributeFilmCheck({ error: "x" }, scenes).readable).toBe(false);
  });

  it("finds the scenes the shell logged a throw for", () => {
    expect(scenesThrownInLog("ok\n[studix-scene s02] x is not a function\n", ["s01", "s02"])).toEqual([
      "s02",
    ]);
  });
});

describe("brand mark", () => {
  it("keeps plain shapes only and drops anything that loads or runs", () => {
    const symbol = markSymbolFromSvg(
      '<svg viewBox="0 0 64 64" onload="x()"><script>alert(1)</script><g transform="translate(2,2)">' +
        '<circle cx="30" cy="30" r="28" fill="#ff5500" onclick="y()"/><path d="M10 10L50 50" stroke="url(#a)"/>' +
        '<image href="https://x.test/a.png"/><rect x="1" y="1" width="4" height="4" style="fill:red"/></g></svg>',
    );
    expect(symbol).toBe(
      '<symbol id="sx-mark" viewBox="0 0 64 64"><g transform="translate(2,2)">' +
        '<circle cx="30" cy="30" r="28" fill="#ff5500"></circle><path d="M10 10L50 50"></path>' +
        '<rect x="1" y="1" width="4" height="4"></rect></g></symbol>',
    );
  });

  it("refuses what is not one svg with a viewBox and a shape", () => {
    expect(markSymbolFromSvg('<svg><circle r="2"/></svg>')).toBeUndefined();
    expect(markSymbolFromSvg('<svg viewBox="0 0 4 4"><text>A</text></svg>')).toBeUndefined();
    expect(markSymbolFromSvg('<div viewBox="0 0 4 4"><circle r="2"/></div>')).toBeUndefined();
    expect(markSymbolFromSvg("x".repeat(7000))).toBeUndefined();
  });

  it("draws a deterministic monogram from the brand name", () => {
    expect(monogramInitials("Studix")).toBe("S");
    expect(monogramInitials("digital top")).toBe("DT");
    expect(monogramInitials("Đẹp Phim Studio")).toBe("ĐP");
    expect(monogramInitials("  ")).toBe("S");
  });
});

describe("director shell v2", () => {
  const build = (shellVersion?: number) =>
    buildDirectorProject({
      width: 1080,
      height: 1920,
      timing: { ...HOOK_TIMING, film: { offset: 4, duration: 30 } },
      theme: {
        palette: { background: "#101010", foreground: "#fafafa", accent: "#ff5500" },
        filmAccent: "#3366ff",
      },
      scenes: [{ sid: "s01-hook", fragment: checkSceneFragment(HOOK_FRAGMENT, { sid: "s01-hook" }) }],
      markName: "Studix",
      ...(shellVersion ? { shellVersion } : {}),
    }).files.get("index.html") as string;

  it("adds the chrome, the mark symbol, the film accent and an attributed scene block", () => {
    const page = build();
    expect(page).toContain('<div id="chrome" class="layer">');
    expect(page).toContain('<symbol id="sx-mark" viewBox="0 0 100 100">');
    expect(page).toContain(">S</text>");
    expect(page).toContain("--film-accent: #3366ff;");
    expect(page).toContain('"film":{"offset":4,"duration":30}');
    expect(page).toContain('console.error("[studix-scene " + sid + "] "');
    expect(page).toContain("const B = ((k) =>");
    expect(page).not.toContain("<!--MARK:BEGIN-->\n<!--MARK:END-->");
  });

  it("assembles a stored v1 composition with the v1 shell", () => {
    const page = build(1);
    expect(page).not.toContain('id="chrome"');
    expect(page).not.toContain("studix-scene");
    expect(() => build(9)).toThrow(/version 9/);
  });

  it("lets v2 fragments wear the component classes, never v1 ones or other sx- classes", () => {
    const html = '<div class="sx-panel"><div class="sx-pill">Make a film<i class="sx-caret"></i></div></div>';
    const fragment = { ...HOOK_FRAGMENT, html };
    expect(sceneFragmentProblems(fragment, { sid: "s01-hook" })).toEqual([]);
    expect(sceneFragmentProblems(fragment, { sid: "s01-hook", shellVersion: 1 }).join()).toContain(
      'class "sx-panel" is reserved',
    );
    expect(
      sceneFragmentProblems(
        { ...HOOK_FRAGMENT, html: '<i class="sx-light"></i>' },
        { sid: "s01-hook" },
      ).join(),
    ).toContain('class "sx-light" is reserved');
    expect(
      sceneFragmentProblems({ ...HOOK_FRAGMENT, js: "const railTo = 1;" }, { sid: "s01-hook" }).join(),
    ).toContain("`railTo` is already provided");
  });
});
