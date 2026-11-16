/**
 * Short, generic scene fragments the builder sees as examples of the artifact script (shell v2) at 1080 x 1920:
 * each puts its scene's `copy` on screen verbatim as real artifacts on the open stage (no window, no placeholder
 * objects), frames by layout scale and moves on the timeline at t0-relative, beat or word times. Original to
 * Studix; a test runs each through the fragment contract with its copy.
 */
export const FILM_EXEMPLARS = [
  {
    role: "hook",
    framing: "close",
    note: "the thread is typed into a prompt bar on the open stage, then Generate is pressed",
    copy: ["A 30 second launch film for our app", "Generate", "16:9 · 30 s · voice on"],
    html:
      '<div class="cam"><div class="sx-pill bar"><span class="typed split">' +
      'A 30 second launch film for our app</span><i class="sx-caret"></i></div>' +
      '<div class="meta">16:9 · 30 s · voice on</div><span class="sx-chip go">Generate</span></div>',
    css:
      ".bar{position:absolute;left:60px;right:60px;top:640px;padding:48px 56px;font:700 84px/1.1 " +
      "var(--font-heading);color:var(--ink);white-space:normal} " +
      ".meta{position:absolute;left:96px;top:1010px;font:500 36px var(--font-mono);color:var(--mute)} " +
      ".go{position:absolute;right:96px;top:1000px;font-size:40px}",
    js:
      'settleCam($s(".cam"), t0, t1, 0.03); typeWords($s(".typed"), t0 + 0.1, T.beatLen / 4); ' +
      'caretBlink($s(".sx-caret"), t0, B(4)); press($s(".go"), B(4)); bump($s(".go"), B(4) + 0.1);',
  },
  {
    role: "scene",
    framing: "close",
    note: "a tool-call card the brief names, its text verbatim in mono, the result line lighting up on the beat",
    copy: [
      "render({",
      'prompt: "A 30 second launch film for our app",',
      "seconds: 30 })",
      "→ job ••••41 queued",
    ],
    html:
      '<div class="cam"><div class="call"><div class="ln head">render({</div>' +
      '<div class="ln arg">prompt: "A 30 second launch film for our app",</div>' +
      '<div class="ln arg">seconds: 30 })</div><div class="ln out">→ job ••••41 queued</div></div></div>',
    css:
      ".call{position:absolute;left:60px;right:60px;top:520px;padding:56px;border-radius:32px;" +
      "background:var(--surface);border:2px solid var(--hair);font-family:var(--font-mono)} " +
      ".ln{font-size:46px;line-height:1.35;color:var(--ink)} .head{font-size:84px;font-weight:700} " +
      ".arg{padding-left:48px} .out{margin-top:40px;color:var(--film-accent);font-weight:700}",
    js:
      'settleCam($s(".cam"), t0, t1, 0.03); typeIn($s(".head"), t0 + 0.1); ' +
      'rise($$s(".arg"), B(1), { stagger: T.beatLen / 2 }); pop($s(".out"), B(4));',
  },
  {
    role: "scene",
    framing: "wide",
    note: "the job as a strip of five labelled tiles; each lights in the accent as its step finishes",
    copy: ["Script", "Voice", "Music", "Scenes", "Render", "Rendering · 00:42"],
    html:
      '<div class="cam"><div class="state">Rendering · 00:42</div><div class="strip">' +
      '<div class="tile">Script</div><div class="tile">Voice</div><div class="tile">Music</div>' +
      '<div class="tile">Scenes</div><div class="tile">Render</div></div>' +
      '<div class="sx-rail bar"></div></div>',
    css:
      ".state{position:absolute;left:60px;top:700px;font:700 72px var(--font-heading);color:var(--ink)} " +
      ".strip{position:absolute;left:60px;right:60px;top:860px;display:flex;gap:16px} " +
      ".tile{flex:1;height:220px;display:flex;align-items:flex-end;padding:20px;border-radius:20px;" +
      "background:var(--surface);border:2px solid var(--hair);font:600 30px var(--font-body);color:var(--mute)} " +
      ".tile.done{border-color:var(--film-accent);color:var(--ink)} .bar{left:60px;right:60px;top:1130px}",
    js:
      'settleCam($s(".cam"), t0, t1, 0.03); railTo($s(".bar"), t0, 0.1, 0.01); ' +
      '$$s(".tile").forEach((e, i) => tl.set(e, { className: "tile done" }, B(1 + i * 2))); ' +
      'railTo($s(".bar"), B(1), 1, Math.max(0.5, t1 - B(1) - 0.3));',
  },
] as const;
