// The DOM edit for this scene on the engine's edit kit: camera per shot (#cam moves videos and GL together),
// shake, whips, impact frames, flashes, tints. Captions, title and fades come from the EDL automatically.
export function editCues(k) {
  const { at, cam, shake, whipIn, flash, tint, hit } = k;
  cam("s01", { scale: 1.0 }, { scale: 1.0 });
  flash(1.42, 0.22, 0.12);
  whipIn(at("s02"), 55, 0.1);
  cam("s02", { scale: 1.0 }, { scale: 1.06, x: -18 }, "sine.out");
  shake(at("s02"), 1.5, 5, { freq: 3, rot: 0.3, decay: 0, seed: 2 });
  cam("s03", {}, {});
  tint(3.7, 0.18, 0.2, "rgb(120, 175, 255)");
  hit(4.2, { frames: 2, amp: 18, seed: 44 });
}
