// Boot: WebGL renderer (transparent, over the edit's videos) -> textures -> sets, figure cards, cels, weather,
// light FX; then hand HyperFrames a paused GSAP timeline (DOM edit: cuts, camera, shake, captions) and draw on
// every hf-seek (the GL frame and the edit's camera rig, both pure functions of t). HyperFrames contract:
// composition "main", timeline at window.__timelines.main, build promise at window.__hf.buildReady.engine; a
// failed build still registers an empty timeline so the render fails loudly in QA instead of hanging.
import * as THREE from "three";
import { W, H, DURATION, SHOTS, EDL } from "./core/film-constants.js";
import { drawFrame } from "./core/draw-frame.js";
import { MultiplaneSet } from "./gl/multiplane-set.js";
import { ParticleWeather } from "./gl/particle-weather.js";
import { LightGlow, SparkBurst } from "./gl/light-fx-glow-and-sparks.js";
import { CelPlate } from "./gl/cel-plate.js";
import { createEditKit } from "./edit/dom-edit-helpers.js";
import { animateCaptions } from "./edit/captions-from-edl.js";

THREE.ColorManagement.enabled = false; // display-referred: paintings and footage are used as delivered

function loadTex(url, tries = 4) {
  // the local file server can drop a connection under parallel render workers: retry before failing
  return loadOnce(url).catch((e) => (tries > 1 ? new Promise((r) => setTimeout(r, 150)).then(() => loadTex(url, tries - 1)) : Promise.reject(e)));
}

function loadOnce(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const t = new THREE.Texture(img);
      t.premultiplyAlpha = true;              // shaders un-premultiply, so mip blur never fringes dark
      t.colorSpace = THREE.NoColorSpace;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.anisotropy = 8;
      t.needsUpdate = true;
      res(t);
    };
    img.onerror = () => rej(new Error(`texture failed: ${url}`));
    img.src = url;
  });
}

const loadAll = async (pairs) => Object.fromEntries(await Promise.all(pairs.map(async ([k, url]) => [k, await loadTex(url)])));

// scene: the scene config (sets, cards, weather, cels, cameras, sparks); fxCues(t, shot, fx); editCues(kit)
export function bootFilm({ scene, fxCues = null, editCues = null }) {
  let world = null;
  const draw = (t) => {
    if (!world) return;
    drawFrame(world, t, scene, fxCues);
    if (world.rig) world.rig.apply(t);
  };
  window.__film = { draw, duration: DURATION };
  window.addEventListener("hf-seek", (e) => window.__film.draw(e && e.detail ? e.detail.time : 0));
  window.__hf = window.__hf || {};
  window.__hf.buildReady = window.__hf.buildReady || {};

  async function build() {
    const canvas = document.getElementById("gl");
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance", stencil: false });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.autoClear = false;

    const setDefs = scene.sets || {};
    const layerPairs = Object.entries(setDefs).flatMap(([name, s]) => s.layers.map((l) => [`${name}/${l.file ?? l[0]}`, `${s.dir}/${l.file ?? l[0]}`]));
    const cardPairs = Object.entries(scene.cards || {}).flatMap(([name, cards]) => cards.map((c, i) => [`${name}#${i}`, c.img]));
    const celShots = SHOTS.filter((s) => s.kind === "cel");
    // depth maps (make-depth-maps.py) only for cel shots whose config asks for the 2.5D move: <img>.depth.png
    const depthPairs = celShots.filter((s) => scene.cels?.[s.id]?.depth).map((s) => [s.id, scene.cels[s.id].depth.map || s.img.replace(/\.[^./]+$/, ".depth.png")]);
    const [layerTex, cardTex, celTex, depthTex] = await Promise.all([loadAll(layerPairs), loadAll(cardPairs), loadAll(celShots.map((s) => [s.id, s.img])), loadAll(depthPairs)]);

    const sets = {};
    for (const [name, s] of Object.entries(setDefs)) {
      const tex = Object.fromEntries(s.layers.map((l) => [l.file ?? l[0], layerTex[`${name}/${l.file ?? l[0]}`]]));
      sets[name] = new MultiplaneSet(tex, s.layers, { aspect: W / H, ...s });
      (scene.cards?.[name] || []).forEach((c, i) => sets[name].addCard(cardTex[`${name}#${i}`], c));
    }
    const sparks = (scene.sparks || [[240, 3], [200, 11]]).map(([n, seed]) => new SparkBurst(n, seed));
    world = {
      renderer, sets, tex: { cels: celTex, depth: depthTex },
      cel: new CelPlate(), glow: new LightGlow(), sparks,
      weather: scene.weather ? new ParticleWeather({ aspect: W / H, ...scene.weather }) : null,
    };
    window.__film.world = world;
    // compile every program once so no frame pays for it
    for (const o of [...Object.values(sets), world.cel, world.glow, ...sparks, world.weather].filter(Boolean)) renderer.compile(o.scene, o.cam);

    await document.fonts.ready;
    const kit = createEditKit(gsap);
    kit.fadeFromBlack(EDL.fade?.in ?? 0.35);
    if (editCues) editCues(kit);
    world.rig = kit.rig.used() ? kit.rig : null;   // a scene without rig cues never touches the DOM it adds
    animateCaptions(kit, EDL);
    if (EDL.title) kit.title(EDL.title.at, EDL.title.dur ?? 0.55);
    kit.fadeToBlack(EDL.fade?.out ?? 0.3);
    const tl = kit.tl;
    tl.set({}, {}, DURATION);
    window.__timelines = window.__timelines || {};
    window.__timelines.main = tl;
    const t0 = window.__hfThreeTime || 0;
    tl.totalTime(t0, true);
    draw(t0);
  }

  window.__hf.buildReady.engine = build().catch((e) => {
    console.error("[film] build failed", e);
    if (!window.__timelines || !window.__timelines.main) {
      const tl = gsap.timeline({ paused: true });
      tl.set({}, {}, DURATION);
      window.__timelines = window.__timelines || {};
      window.__timelines.main = tl;
    }
  });
}
