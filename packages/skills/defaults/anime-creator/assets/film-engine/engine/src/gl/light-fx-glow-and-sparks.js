// Screen-space light FX (sword glints, qi arcs, magic streaks, hit flashes, spark sprays), composited
// additively over the shots.
// Space: centre (0,0), y in [-1,1], x in [-16/9, 16/9] (so circles stay round).
//  - LightGlow: one fullscreen pass with comet streaks (head + tapered tail), 4-ray star glints,
//    crescent sword-qi arcs and a radial flash. All driven by uniforms set per frame from the timeline.
//  - SparkBurst: instanced spark streaks erupting from a point; analytic ballistic motion with drag and
//    gravity, each spark stretched along its velocity and cooling from white to its tint.
import * as THREE from "three";

const ASPECT = 16 / 9;
// light adds to rgb but leaves alpha alone: over a transparent canvas the page's premultiplied
// composite (src + dst * (1 - a)) then adds the glow on top of the video underneath
const ADD_LIGHT = { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor };
const FS_VERT = /* glsl */ `varying vec2 vP; void main() { vP = position.xy * vec2(${ASPECT.toFixed(6)}, 1.0); gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const GLOW_FRAG = /* glsl */ `
  varying vec2 vP;
  uniform vec4 uStreak[2];   // head.xy, tail dir.xy * length
  uniform vec3 uStreakCol[2];
  uniform float uStreakI[2];
  uniform vec4 uGlint[4];    // pos.xy, size, rotation
  uniform vec3 uGlintCol[4];
  uniform float uGlintI[4];
  uniform vec4 uArc[2];      // centre.xy, radius, thickness
  uniform vec3 uArcAng[2];   // start angle, sweep (signed), progress 0..1 (the leading edge travels, the tail fades)
  uniform vec3 uArcCol[2];
  uniform float uArcI[2];
  uniform vec3 uFlash;       // pos.xy, intensity
  uniform vec3 uFlashCol;
  float segDist(vec2 p, vec2 a, vec2 b, out float h) {
    vec2 pa = p - a, ba = b - a;
    h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
  }
  void main() {
    vec3 c = vec3(0.0);
    for (int i = 0; i < 2; i++) {
      if (uStreakI[i] <= 0.0) continue;
      float h; vec2 head = uStreak[i].xy;
      float d = segDist(vP, head, head + uStreak[i].zw, h);
      float w = mix(0.018, 0.002, h);                       // tapered tail
      float core = exp(-d * d / (w * w)) * (1.0 - h);
      float halo = exp(-d / (w * 6.0 + 0.01)) * (1.0 - h) * 0.35;
      float hd = length(vP - head);
      float bloom = exp(-hd * 34.0) * 0.8 + exp(-hd * 9.0) * 0.12;
      c += (uStreakCol[i] * (halo + bloom) + vec3(1.0) * core) * uStreakI[i];
    }
    for (int i = 0; i < 4; i++) {
      if (uGlintI[i] <= 0.0) continue;
      vec2 q = vP - uGlint[i].xy;
      float s = uGlint[i].z, r = uGlint[i].w;
      q = mat2(cos(r), sin(r), -sin(r), cos(r)) * q;
      float rays = exp(-abs(q.y) / (s * 0.035)) * exp(-abs(q.x) / s) + exp(-abs(q.x) / (s * 0.035)) * exp(-abs(q.y) / s);
      vec2 qd = mat2(0.7071, 0.7071, -0.7071, 0.7071) * q;    // faint diagonal rays
      rays += 0.35 * (exp(-abs(qd.y) / (s * 0.03)) * exp(-abs(qd.x) / (s * 0.45)) + exp(-abs(qd.x) / (s * 0.03)) * exp(-abs(qd.y) / (s * 0.45)));
      float core = exp(-length(q) / (s * 0.08));
      c += (uGlintCol[i] * (rays + core * 0.6) + vec3(core)) * uGlintI[i];
    }
    for (int i = 0; i < 2; i++) {
      if (uArcI[i] <= 0.0) continue;
      vec2 q = vP - uArc[i].xy;
      float a = atan(q.y, q.x) - uArcAng[i].x;
      float sw = uArcAng[i].y;
      a = mod(a * sign(sw) + 6.2831853, 6.2831853);            // angle travelled along the sweep
      float u = a / abs(sw);                                      // 0 at the start, 1 at the full sweep
      float lead = uArcAng[i].z;
      float along = step(u, lead) * smoothstep(lead - 0.75, lead, u); // bright at the leading edge, fading tail
      float th = uArc[i].w * (0.25 + 0.75 * along);
      float d = abs(length(q) - uArc[i].z);
      float band = exp(-d * d / (th * th)) * along;
      float edge = exp(-d * d / (th * th * 0.08)) * along * along;
      c += (uArcCol[i] * band * 0.9 + vec3(edge)) * uArcI[i];
    }
    float fd = length(vP - uFlash.xy);
    c += (uFlashCol * (exp(-fd * 2.2) * 0.6 + exp(-fd * 9.0)) + vec3(exp(-fd * 25.0))) * uFlash.z;
    gl_FragColor = vec4(c, 1.0);
  }`;

const z3 = () => new THREE.Vector3(), z4 = () => new THREE.Vector4();
export class LightGlow {
  constructor() {
    this.u = {
      uStreak: { value: [z4(), z4()] }, uStreakCol: { value: [z3(), z3()] }, uStreakI: { value: [0, 0] },
      uGlint: { value: [z4(), z4(), z4(), z4()] }, uGlintCol: { value: [z3(), z3(), z3(), z3()] }, uGlintI: { value: [0, 0, 0, 0] },
      uArc: { value: [z4(), z4()] }, uArcAng: { value: [z3(), z3()] }, uArcCol: { value: [z3(), z3()] }, uArcI: { value: [0, 0] },
      uFlash: { value: z3() }, uFlashCol: { value: new THREE.Vector3(1, 0.85, 0.9) },
    };
    const m = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: GLOW_FRAG, uniforms: this.u, transparent: true, ...ADD_LIGHT, depthTest: false, depthWrite: false });
    this.scene = new THREE.Scene();
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
    q.frustumCulled = false;
    this.scene.add(q);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  clear() {
    const u = this.u;
    u.uStreakI.value.fill(0); u.uGlintI.value.fill(0); u.uArcI.value.fill(0); u.uFlash.value.z = 0;
  }
  streak(i, [hx, hy], [tx, ty], col, k) { this.u.uStreak.value[i].set(hx, hy, tx, ty); this.u.uStreakCol.value[i].set(...col); this.u.uStreakI.value[i] = k; }
  glint(i, [x, y], size, rot, col, k) { this.u.uGlint.value[i].set(x, y, size, rot); this.u.uGlintCol.value[i].set(...col); this.u.uGlintI.value[i] = k; }
  arc(i, [x, y], radius, thick, a0, sweep, lead, col, k) {
    this.u.uArc.value[i].set(x, y, radius, thick); this.u.uArcAng.value[i].set(a0, sweep, lead); this.u.uArcCol.value[i].set(...col); this.u.uArcI.value[i] = k;
  }
  flash([x, y], k, col = [1, 0.85, 0.9]) { this.u.uFlash.value.set(x, y, k); this.u.uFlashCol.value.set(...col); }
  render(renderer) { renderer.render(this.scene, this.cam); }
}

const SPARK_VERT = /* glsl */ `
  attribute vec4 aSeed;
  uniform float uAge, uSpeed, uLife, uGravity, uDrag, uSize;
  uniform vec2 uOrigin, uDir;      // uDir: bias direction (0 = isotropic)
  varying vec2 vUv; varying float vHeat;
  void main() {
    vUv = uv;
    float ang = aSeed.x * 6.2831853;
    vec2 d = normalize(vec2(cos(ang), sin(ang)) + uDir * 1.3);
    float sp = uSpeed * (0.35 + 1.1 * aSeed.y * aSeed.y);
    float life = uLife * (0.45 + 0.55 * aSeed.z);
    float t = min(uAge, life);
    float k = (1.0 - exp(-uDrag * t)) / uDrag;              // integral of exp(-drag t)
    vec2 p = uOrigin + d * sp * k + vec2(0.0, -uGravity) * t * t * 0.5;
    vec2 v = d * sp * exp(-uDrag * t) + vec2(0.0, -uGravity) * t;
    float alive = step(0.0, uAge) * step(uAge, life);
    vHeat = 1.0 - t / life;
    float len = clamp(length(v) * 0.03, 0.004, 0.16), wid = uSize * (0.5 + aSeed.w);
    vec2 ax = normalize(v + 1e-5), ay = vec2(-ax.y, ax.x);
    vec2 corner = ax * position.x * len + ay * position.y * wid;
    vec2 s = (p + corner) / vec2(${ASPECT.toFixed(6)}, 1.0);
    gl_Position = alive > 0.5 ? vec4(s, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  }`;
const SPARK_FRAG = /* glsl */ `
  uniform vec3 uTint; uniform float uIntensity;
  varying vec2 vUv; varying float vHeat;
  void main() {
    vec2 q = (vUv - 0.5) * 2.0;
    float a = (1.0 - smoothstep(0.0, 1.0, abs(q.y))) * (1.0 - smoothstep(0.2, 1.0, abs(q.x)));
    vec3 col = mix(uTint, vec3(1.0, 0.97, 0.9), smoothstep(0.4, 1.0, vHeat)) * (0.4 + 1.4 * vHeat);
    gl_FragColor = vec4(col * a * uIntensity, 1.0);
  }`;

export class SparkBurst {
  constructor(count = 220, seed = 7) {
    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    g.index = quad.index;
    g.setAttribute("position", quad.getAttribute("position"));
    g.setAttribute("uv", quad.getAttribute("uv"));
    let k = seed * 7919 + 1;
    const rnd = () => ((k = (Math.imul(k, 1664525) + 1013904223) >>> 0) / 4294967296);
    const a = new Float32Array(count * 4).map(() => rnd());
    g.setAttribute("aSeed", new THREE.InstancedBufferAttribute(a, 4));
    g.instanceCount = count;
    this.u = {
      uAge: { value: -1 }, uSpeed: { value: 2.2 }, uLife: { value: 0.6 }, uGravity: { value: 1.4 }, uDrag: { value: 3.5 },
      uSize: { value: 0.004 }, uOrigin: { value: new THREE.Vector2() }, uDir: { value: new THREE.Vector2() },
      uTint: { value: new THREE.Color(1, 0.55, 0.35) }, uIntensity: { value: 1 },
    };
    const m = new THREE.ShaderMaterial({ vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG, uniforms: this.u, transparent: true, ...ADD_LIGHT, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  // fire(age, origin [x,y], opts {speed, life, gravity, drag, size, dir [x,y], tint [r,g,b], intensity}); age < 0 hides it
  fire(age, [x, y], o = {}) {
    const u = this.u;
    u.uAge.value = age; u.uOrigin.value.set(x, y);
    for (const key of ["speed", "life", "gravity", "drag", "size", "intensity"]) if (o[key] !== undefined) u["u" + key[0].toUpperCase() + key.slice(1)].value = o[key];
    if (o.dir) u.uDir.value.set(...o.dir); else u.uDir.value.set(0, 0);
    if (o.tint) u.uTint.value.setRGB(...o.tint);
  }
  render(renderer) { if (this.u.uAge.value >= 0) renderer.render(this.scene, this.cam); }
}

// the xianxia film's name for LightGlow
export { LightGlow as SwordGlow };
