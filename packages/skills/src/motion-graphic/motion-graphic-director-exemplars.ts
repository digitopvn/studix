/**
 * Short, generic scene fragments the builder sees as examples of the film system (shell v2) at 1080 x 1920:
 * the product surface is big and on screen from the scene's first frame, built from the shell's component
 * classes, and every move sits on the timeline at t0-relative, beat or word times. Original to Studix; a test
 * runs each through the fragment contract.
 */
export const FILM_EXEMPLARS = [
  {
    role: "hook",
    note: "the prompt box is typed into, then the button is pressed",
    html:
      '<div class="cam"><div class="sx-panel win"><div class="sx-pill prompt"><span class="typed split">' +
      'A 30 second launch film for our app</span><i class="sx-caret"></i></div>' +
      '<span class="sx-chip go">Generate</span></div></div>',
    css:
      ".win{left:80px;top:520px;width:920px;height:620px} " +
      ".prompt{position:absolute;left:48px;right:48px;top:64px;font-size:46px;white-space:normal} " +
      ".go{position:absolute;right:48px;bottom:56px;font-size:36px}",
    js:
      'settleCam($s(".cam"), t0, t1, 0.03); typeWords($s(".typed"), t0 + 0.1, T.beatLen / 4); ' +
      'caretBlink($s(".sx-caret"), t0, B(4)); press($s(".go"), B(4)); bump($s(".go"), B(4) + 0.1);',
  },
  {
    role: "scene",
    note: "the same surface, now a job rendering: the rail fills and the steps tick on the beat",
    html:
      '<div class="cam"><div class="sx-panel job"><div class="row"><span class="sx-chip">Rendering</span>' +
      '<span class="eta">00:42</span></div><div class="title">Launch film, 30 s</div>' +
      '<div class="sx-rail bar"></div><div class="steps"><span class="sx-chip">Script</span>' +
      '<span class="sx-chip">Voice</span><span class="sx-chip">Music</span></div></div></div>',
    css:
      ".job{left:80px;top:420px;width:920px;height:780px;padding:64px} " +
      ".row{display:flex;justify-content:space-between;align-items:center} " +
      ".eta{font:600 40px var(--font-mono);color:var(--mute)} " +
      ".title{margin-top:80px;font:700 76px/1.1 var(--font-heading);color:var(--ink)} " +
      ".bar{left:64px;right:64px;top:440px} .steps{position:absolute;left:64px;bottom:72px;display:flex;gap:20px}",
    js:
      'settleCam($s(".cam"), t0, t1, 0.03); railTo($s(".bar"), t0, 0.15, 0.01); ' +
      'railTo($s(".bar"), B(1), 0.7, 1.2); pop($$s(".steps .sx-chip"), B(1), { stagger: T.beatLen / 2 }); ' +
      'railTo($s(".bar"), Math.max(t0, t1 - 0.7), 1, 0.5);',
  },
] as const;
