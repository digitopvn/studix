// Ported from zuey-workspace@10719856:.agents/skills/anime-creator/assets/film-engine/engine/src/gl/multiplane-set.js (Studix changes are marked "Studix:").
// A painted set as a multiplane: each layer of a layer decomposition (or hand-cut layers of one painting)
// is a plane at its own depth in front of a perspective camera, so a dolly, crane or pan gives true parallax.
// Placement: a layer covers its bounding box as seen from the rest camera (origin, looking -z).
// Figure cards stand ON the set: their feet sit on a ground row at their own depth, so scale and parallax
// follow the camera (no floating cutouts, no screen-space foot pins).
import * as THREE from "three";

const VERT = /* glsl */ `
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

// Depth of field by mip bias: blur grows as a layer gets closer than the focus distance.
// Haze lifts far layers toward the sky colour (atmospheric perspective).
const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uBias, uFocus, uHaze, uOpacity, uShade;
  uniform vec3 uHazeCol;
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    float near = clamp((uFocus - vDepth) / uFocus, 0.0, 1.0);
    vec4 c = texture2D(uMap, vUv, uBias + near * 3.5);
    c.rgb /= max(c.a, 1e-4);                 // textures are premultiplied so blurred edges never fringe dark
    c.rgb = mix(c.rgb * uShade, uHazeCol, uHaze);
    gl_FragColor = vec4(c.rgb, c.a * uOpacity);
    if (gl_FragColor.a < 0.003) discard;
  }`;

// soft elliptical contact shadow under a figure card
const SHADOW_FRAG = /* glsl */ `
  uniform float uOpacity; varying vec2 vUv;
  void main() { vec2 q = (vUv - 0.5) * 2.0; float a = (1.0 - smoothstep(0.2, 1.0, length(q))) * uOpacity; gl_FragColor = vec4(0.0, 0.0, 0.0, a); }`;

const toLayer = (l) => (Array.isArray(l) ? { file: l[0], depth: l[1], bbox: l[2], bias: l[3] ?? 0, overscan: l[4] } : l);

export class MultiplaneSet {
  // tex: {file: THREE.Texture}; layers: [{file, depth, bbox [x1,y1,x2,y2] 0..1000, bias, overscan}] back to front
  constructor(tex, layers, { fov = 40, aspect = 16 / 9, overscan = 1.16, hazeColor = [0.86, 0.9, 0.97], hazeMax = 0.18, hazeDepth = 500 } = {}) {
    this.fov = fov; this.aspect = aspect; this.overscan = overscan;
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(fov, aspect, 0.1, 1000);
    this.th = Math.tan(THREE.MathUtils.degToRad(fov / 2));
    this.layers = [];
    this.cards = [];
    layers.map(toLayer).forEach(({ file, depth: d, bbox: [x1, y1, x2, y2], bias = 0, overscan: os = overscan }, i) => {
      const fh = 2 * d * this.th * os, fw = fh * aspect;
      const w = ((x2 - x1) / 1000) * fw, h = ((y2 - y1) / 1000) * fh;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.material(tex[file], bias, Math.min(hazeMax, d / hazeDepth), hazeColor));
      m.position.set(((x1 + x2) / 2000 - 0.5) * fw, (0.5 - (y1 + y2) / 2000) * fh, -d);
      m.renderOrder = i; // back to front
      m.userData = { file, depth: d };
      this.scene.add(m);
      this.layers.push(m);
    });
  }

  material(map, bias, haze, hazeColor) {
    return new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: false,
      uniforms: {
        uMap: { value: map }, uBias: { value: bias }, uFocus: { value: 12 }, uOpacity: { value: 1 }, uShade: { value: 1 },
        uHaze: { value: haze }, uHazeCol: { value: new THREE.Color(...hazeColor) },
      },
    });
  }

  // Stand a figure (premultiplied RGBA cutout) on the set. groundRow: the screen row 0..1000 (top = 0) of the
  // ground at that depth in the REST frame (read it off the painting where the figure's feet go); x: screen
  // column 0..1000 of the feet; height: figure height in world units at that depth (people ~ 1.7 for a
  // human-scale set). The card is inserted between the layers by depth, with a contact shadow.
  addCard(texture, { depth, groundRow, x = 500, height, aspect = texture.image.width / texture.image.height, shadow = 0.35, shade = 1 }) {
    const fh = 2 * depth * this.th * this.overscan, fw = fh * this.aspect;
    const footX = (x / 1000 - 0.5) * fw, footY = (0.5 - groundRow / 1000) * fh;
    const card = new THREE.Mesh(new THREE.PlaneGeometry(height * aspect, height), this.material(texture, 0, 0, [0, 0, 0]));
    card.material.uniforms.uShade.value = shade;
    card.position.set(footX, footY + height / 2, -depth);
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(height * aspect * 0.9, height * 0.12), new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: SHADOW_FRAG, transparent: true, depthWrite: false, depthTest: false, uniforms: { uOpacity: { value: shadow } },
    }));
    sh.position.set(footX, footY, -depth + 0.01);
    // draw order by depth among the layers (back to front)
    const order = this.layers.filter((l) => l.userData.depth > depth).length - 0.5;
    sh.renderOrder = order - 0.01; card.renderOrder = order;
    this.scene.add(sh, card);
    const handle = { card, shadow: sh, base: card.position.clone() };
    this.cards.push(handle);
    return handle;
  }

  // camera pose: z dolly (negative = forward), crane y, pan x, roll/tilt/yaw in degrees, focus distance
  pose({ x = 0, y = 0, z = 0, roll = 0, tilt = 0, yaw = 0, focus = 12 }) {
    const r = THREE.MathUtils.degToRad;
    this.cam.position.set(x, y, z);
    this.cam.rotation.set(r(tilt), r(yaw), r(roll), "YXZ");
    this.cam.updateMatrixWorld();
    for (const m of [...this.layers, ...this.cards.map((c) => c.card)]) m.material.uniforms.uFocus.value = focus;
  }

  render(renderer) { renderer.render(this.scene, this.cam); }
}
