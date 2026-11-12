import type { DirectorTiming, SceneFragment } from "../src/index.ts";

/**
 * A realistic hook fragment as a builder would write it for "Describe a video. Get a finished film." at 9:16:
 * a prompt pill types itself, its send button is pressed on "get", the pill becomes a film frame that fills
 * up and resolves on "film", and a ready chip lands. Every reveal is keyed to a spoken word or a beat.
 */
export const HOOK_FRAGMENT: SceneFragment = {
  html: `<div class="cam">
  <div class="glow"></div>
  <div class="kicker hl">Describe a video.</div>
  <div class="pill">
    <span class="ptxt split">A 15s film for my coffee brand</span>
    <div class="send"><svg viewBox="0 0 40 40" width="44" height="44"><path d="M13 9 L31 20 L13 31 Z" fill="currentColor"/></svg></div>
    <div class="mask sw"><div class="sweep"></div></div>
  </div>
  <div class="frame">
    <div class="bars"><i></i><i></i><i></i></div>
    <div class="fill"></div>
    <div class="play"><svg viewBox="0 0 120 120" width="160" height="160"><circle cx="60" cy="60" r="56" fill="none" stroke="currentColor" stroke-width="4" class="draw" pathLength="1"/><path d="M48 38 L84 60 L48 82 Z" fill="currentColor"/></svg></div>
  </div>
  <div class="head hl">Get a finished <em>film.</em></div>
  <div class="chip"><i class="dot"></i>MP4 ready</div>
</div>`,
  css: `.glow { position: absolute; left: 140px; top: 520px; width: 800px; height: 800px; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--accent) 35%, transparent), transparent 70%); }
.kicker { position: absolute; left: 90px; right: 90px; top: 420px; text-align: center; font-size: 96px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.1; }
.pill { position: absolute; left: 90px; width: 900px; top: 760px; height: 150px; border-radius: 75px; background: var(--surface); border: 2px solid var(--hair); display: flex; align-items: center; padding: 0 140px 0 56px; overflow: hidden; }
.ptxt { font-size: 44px; font-weight: 600; color: var(--ink); white-space: nowrap; }
.send { position: absolute; right: 22px; top: 22px; width: 106px; height: 106px; border-radius: 50%; background: var(--accent); color: var(--bg); display: flex; align-items: center; justify-content: center; }
.sw { position: absolute; inset: 0; border-radius: 75px; }
.frame { position: absolute; left: 90px; top: 640px; width: 900px; height: 506px; border-radius: 28px; background: var(--surface); border: 2px solid var(--hair); overflow: hidden; }
.bars { position: absolute; left: 40px; top: 40px; display: flex; gap: 14px; }
.bars i { display: block; width: 120px; height: 18px; border-radius: 9px; background: var(--hair); }
.fill { position: absolute; left: 0; bottom: 0; width: 100%; height: 10px; background: var(--accent); transform-origin: 0% 50%; }
.play { position: absolute; left: 370px; top: 173px; width: 160px; height: 160px; color: var(--ink); }
.head { position: absolute; left: 90px; right: 90px; top: 1230px; text-align: center; font-size: 104px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.1; }
.head em { font-style: normal; color: var(--accent); }
.chip { position: absolute; left: 340px; top: 1500px; width: 400px; height: 76px; border-radius: 38px; background: var(--surface); border: 2px solid var(--hair); font-size: 34px; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 14px; }
.dot { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--accent); }`,
  js: `const each = T.beatLen / 4;
const describe = W(sid, "describe"), get = W(sid, "get"), film = W(sid, "film");
settleCam($s(".cam"), t0, t1, 0.04);
tl.fromTo($s(".glow"), { scale: 0.8, opacity: 0.5 }, { scale: 1.1, opacity: 1, duration: t1 - t0, ease: "sine.inOut" }, t0);
tl.fromTo($$s(".kicker .w"), { autoAlpha: 0, yPercent: 60 }, { autoAlpha: 1, yPercent: 0, duration: 0.36, ease: "power3.out", stagger: 0.07 }, Math.max(0, describe - 0.12));
typeWords($s(".ptxt"), t0 + 0.05, each);
sweep($s(".pill .sw"), W(sid, "video"), 0.5);
press($s(".send"), get - 0.18);
ripple($s(".send"), get - 0.18);
fadeOut([$s(".pill"), $s(".kicker")], get - 0.08, { d: 0.18, y: -40 });
pop($s(".frame"), get - 0.04, { from: 0.7, d: 0.4 });
tl.fromTo($s(".fill"), { scaleX: 0 }, { scaleX: 1, duration: Math.max(0.2, film - get), ease: "power2.inOut" }, get);
tl.fromTo($$s(".head .w"), { autoAlpha: 0, yPercent: 60 }, { autoAlpha: 1, yPercent: 0, duration: 0.4, ease: "power3.out", stagger: 0.06 }, get);
slam($s(".play"), film);
draw($s(".play .draw"), film - 0.1, 0.5);
pop($s(".chip"), film + 0.3, { from: 0.6 });
bump($s(".head em"), B(5));`,
};

/** TIMING of the hook alone, with real word timings from a voiced take (the dogfood reference film's s01). */
export const HOOK_TIMING: DirectorTiming = {
  duration: 3.537,
  fps: 30,
  beat0: 0.036,
  beatLen: 0.500083,
  kick: [[0, 8]],
  drops: [],
  outroBeat: 8,
  scenes: {
    "s01-hook": {
      start: 0,
      end: 3.537,
      lines: [
        {
          on: 0.12,
          off: 0.879,
          words: [
            ["describe", 0.12, 0.472],
            ["a", 0.527, 0.546],
            ["video", 0.583, 0.879],
          ],
        },
        {
          on: 1.6,
          off: 2.415,
          words: [
            ["get", 1.6, 1.674],
            ["a", 1.711, 1.767],
            ["finished", 1.841, 2.119],
            ["film", 2.174, 2.415],
          ],
        },
      ],
    },
    "s02-name": { start: 3.537, end: 7.537, lines: [] },
  },
  captions: [],
  env: [],
  handoff: {},
  options: { fadeIn: false, fadeOut: false },
};

export const HOOK_WORDS = ["describe", "a", "video", "get", "finished", "film"];
