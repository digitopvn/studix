// Live captions driven by the EDL's dialogue lines (edit time). build-edit renders one .cap element per line
// (id cap-<shot>-<n>) with the spoken text (.l1) and the translation (.l2); lines with word timings (from
// forced alignment or ASR) get one .w span per word and a karaoke highlight as each word is spoken.
export function animateCaptions(kit, EDL) {
  const { tl, show } = kit;
  const F = 1 / (EDL.fps || 24), cuts = EDL.shots.map((s) => s.end);
  for (const shot of EDL.shots) {
    (shot.dialogue || []).forEach((line, n) => {
      const id = `#cap-${shot.id}-${n}`;
      if (!document.querySelector(id)) return;
      // a speaker whose caption colour sits close to the shared highlight (warm on warm) names its own
      const hl = EDL.speakers?.[line.speaker]?.hl || EDL.captions?.highlight || "#ffe08a";
      // an aligned line pops on with its first spoken word (a take can open on silence or a breath), not at the file start
      const on = line.words?.length ? Math.max(line.t0, line.words[0].t0 - 0.04) : line.t0;
      // the hold after the last word stops at a hard cut instead of spilling a few frames into the next shot
      let off = line.t1 + (EDL.captions?.hold ?? 0.15);
      const cut = cuts.find((c) => c >= line.t1 - 2 * F);
      if (cut !== undefined && cut < off) off = Math.max(on + F, cut);
      // the line's t1 carries the take's silent tail: once the last word has been up long enough to read, the
      // caption leaves with its shot instead of hanging over the next one (a black beat, a new speaker)
      const last = line.words?.length ? line.words[line.words.length - 1].t0 : null;
      const tail = last === null ? undefined : cuts.find((c) => c >= last + 0.25);
      if (tail !== undefined && tail < off) off = Math.max(on + F, tail);
      show(id, on, off);
      (line.words || []).forEach((w, i) => {
        tl.to(`${id} .w${i}`, { color: hl, duration: 0.04, ease: "none", immediateRender: false }, w.t0);
      });
    });
  }
}
