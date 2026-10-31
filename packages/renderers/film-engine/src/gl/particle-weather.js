// Ported from zuey-workspace@10719856:.agents/skills/anime-creator/assets/film-engine/engine/src/gl/particle-weather.js (Studix changes are marked "Studix:").
// 3D weather in camera space (petals, sakura, snow, embers, leaves, ash), drawn over every shot. Positions
// are an analytic function of time (wind drift + turbulence + vortex + burst), so any seek renders the same
// frame and workers can render out of order. Each particle is a tumbling quad shaped by an SDF, lit with a
// backlit translucency term, and softened near the lens (depth of field) or far away.
import * as THREE from "three";

// screen point (FX space: x in +-aspect, y in +-1) -> camera-space point at depth d, for bursts aimed at an
// on-screen contact; fov must match the weather camera (default 40)
export const atDepth = ([x, y], d, fov = 40) => { const th = Math.tan((fov / 2) * Math.PI / 180); return [x * d * th, y * d * th, -d]; };

// shape ids used by the fragment shader
const SHAPE = { petal: 0, sakura: 0, snow: 1, ember: 2, leaf: 3, ash: 4 };

// base / edge colours, size, tumble and spin per preset; override any of them with set({...})
export const WEATHER_PRESETS = {
  petal: { shape: "petal", base: [1.0, 0.8, 0.87], edge: [0.92, 0.42, 0.6], size: 0.16, tumble: 1, glow: 0 },
  sakura: { shape: "sakura", base: [1.0, 0.9, 0.93], edge: [0.95, 0.6, 0.72], size: 0.13, tumble: 1, glow: 0 },
  snow: { shape: "snow", base: [0.96, 0.98, 1.0], edge: [0.8, 0.86, 0.95], size: 0.07, tumble: 0, glow: 0.2 },
  ember: { shape: "ember", base: [1.0, 0.75, 0.35], edge: [1.0, 0.35, 0.08], size: 0.05, tumble: 0, glow: 1.2 },
  leaf: { shape: "leaf", base: [0.95, 0.62, 0.22], edge: [0.6, 0.22, 0.08], size: 0.2, tumble: 1, glow: 0 },
  ash: { shape: "ash", base: [0.55, 0.53, 0.52], edge: [0.25, 0.24, 0.24], size: 0.06, tumble: 1, glow: 0 },
};

const VERT = /* glsl */ `
  attribute vec4 aSeed;
  attribute vec4 aSeed2;
  uniform float uTime, uField, uDensity, uSize, uSwirl, uVortex, uBurstT, uBurstAmt, uBurstR, uTumble;
  uniform vec3 uWind, uVortexC, uBurstC, uSun;
  uniform vec3 uBoxMin, uBoxSize;
  varying vec2 vUv;
  varying float vBlur, vLit, vBack, vFade, vHeat;
  mat3 rotAxis(vec3 a, float g) {
    float s = sin(g), c = cos(g), o = 1.0 - c;
    return mat3(o*a.x*a.x + c, o*a.x*a.y + a.z*s, o*a.z*a.x - a.y*s,
                o*a.x*a.y - a.z*s, o*a.y*a.y + c, o*a.y*a.z + a.x*s,
                o*a.z*a.x + a.y*s, o*a.y*a.z - a.x*s, o*a.z*a.z + c);
  }
  void main() {
    vUv = uv;
    vec4 s = fract(aSeed + uField * vec4(0.137, 0.271, 0.419, 0.563));
    float t = uTime;
    vec3 p = uBoxMin + s.xyz * uBoxSize;
    p += uWind * t * (0.65 + 0.7 * s.w);
    p += uSwirl * vec3(sin(t * 1.3 + s.x * 41.0), cos(t * 1.1 + s.y * 29.0), sin(t * 0.9 + s.z * 17.0));
    p = uBoxMin + mod(p - uBoxMin, uBoxSize); // endless field: particles wrap around the box
    // vortex around a vertical axis through uVortexC: angular speed falls off with radius
    vec3 r = p - uVortexC;
    float ang = uVortex * t / (0.35 + 0.12 * length(r.xz));
    float ca = cos(ang), sa = sin(ang);
    r.xz = mat2(ca, sa, -sa, ca) * r.xz;
    r.y += uVortex * 0.08 * sin(ang + s.x * 6.28);
    p = uVortexC + r;
    // burst: a reserved subset is hidden until uBurstT, then erupts from uBurstC and drifts down with drag
    float bt = t - uBurstT, held = 1.0;
    if (aSeed2.y < uBurstAmt) {
      held = step(0.0, bt);
      vec3 dir = normalize(vec3(s.x - 0.5, s.y - 0.35, s.z - 0.5) + 1e-3);
      p = uBurstC + dir * uBurstR * (0.3 + s.w) * (1.0 - exp(-max(bt, 0.0) * 2.6)) + vec3(0.3, -0.25, 0.0) * bt * bt * held;
    }
    float keep = step(aSeed2.x, uDensity) * step(p.z, -0.45) * held;
    vec3 axis = normalize(vec3(aSeed2.z - 0.5, aSeed2.w - 0.5, s.x - 0.5) + 1e-3);
    mat3 R = rotAxis(axis, uTumble * (t * (1.6 + 3.2 * s.w) + s.y * 6.283));
    float size = uSize * (0.75 + 0.6 * aSeed2.z);
    vec3 corner = R * vec3(position.xy * size * vec2(1.0, 1.25), 0.0);
    vec3 n = R * vec3(0.0, 0.0, 1.0);
    vLit = abs(dot(n, uSun));
    vBack = pow(max(0.0, dot(normalize(p), uSun)), 3.0); // looking toward the light through the particle
    vBlur = smoothstep(-3.2, -0.5, p.z) + 0.3 * smoothstep(-12.0, -22.0, p.z);
    vFade = keep * smoothstep(uBoxMin.z, uBoxMin.z + 5.0, p.z);
    vHeat = 0.5 + 0.5 * sin(t * (3.0 + 5.0 * s.w) + s.z * 40.0); // ember flicker
    gl_Position = projectionMatrix * vec4(p + corner, 1.0);
    if (keep < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }`;

const FRAG = /* glsl */ `
  uniform vec3 uTint, uBase, uEdge;
  uniform float uOpacity, uShape, uGlow;
  varying vec2 vUv;
  varying float vBlur, vLit, vBack, vFade, vHeat;
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float d;
    if (uShape < 0.5) {                       // petal: narrow toward the stem, notch at the tip
      float w = 0.64 * (1.0 - 0.5 * smoothstep(1.0, -1.0, p.y));
      d = length(vec2(p.x / w, p.y)) - 1.0;
      d = max(d, -(length(p - vec2(0.0, 1.08)) - 0.2));
    } else if (uShape < 2.5) {
      d = length(p) - 0.8;                    // snow / ember: round
    } else if (uShape < 3.5) {                // leaf: pointed ellipse (the midrib is shaded below)
      d = length(vec2(p.x / (0.5 * (1.0 - 0.6 * p.y * p.y) + 1e-3), p.y)) - 1.0;
    } else {                                  // ash: ragged flake
      d = length(p) - 0.75 - 0.15 * sin(atan(p.y, p.x) * 5.0 + vUv.x * 9.0);
    }
    float e = 0.05 + vBlur * 0.75 + (uShape > 0.5 && uShape < 2.5 ? 0.35 : 0.0);
    float a = 1.0 - smoothstep(-e, e, d);
    vec3 col = mix(uBase, uEdge, clamp(0.25 + 0.55 * (p.y * 0.5 + 0.5) + 0.3 * abs(p.x), 0.0, 1.0)) * uTint;
    col *= 0.78 + 0.3 * vLit;
    if (uShape > 2.5 && uShape < 3.5) col *= 1.0 - 0.3 * exp(-abs(p.x) * 40.0); // leaf midrib
    col += vec3(1.0, 0.7, 0.62) * vBack * 0.3;
    col *= 1.0 + uGlow * (0.6 + 0.4 * vHeat);
    a *= vFade * uOpacity * (1.0 - 0.5 * vBlur);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

export class ParticleWeather {
  constructor({ count = 3200, preset = "petal", seed = 12345, boxMin = [-11, -6.5, -22], boxSize = [22, 13, 21.4], fov = 40, aspect = 16 / 9 } = {}) {
    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    g.index = quad.index;
    g.setAttribute("position", quad.getAttribute("position"));
    g.setAttribute("uv", quad.getAttribute("uv"));
    let k = seed; // deterministic seeds
    const rnd = () => ((k = (Math.imul(k, 1664525) + 1013904223) >>> 0) / 4294967296);
    const a = new Float32Array(count * 4), b = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) { a[i] = rnd(); b[i] = rnd(); }
    g.setAttribute("aSeed", new THREE.InstancedBufferAttribute(a, 4));
    g.setAttribute("aSeed2", new THREE.InstancedBufferAttribute(b, 4));
    g.instanceCount = count;
    const v3 = (x) => new THREE.Vector3(...x);
    this.u = {
      uTime: { value: 0 }, uField: { value: 0 }, uDensity: { value: 0.5 }, uSize: { value: 0.16 }, uTumble: { value: 1 },
      uSwirl: { value: 0.4 }, uVortex: { value: 0 }, uBurstT: { value: 1e9 }, uBurstAmt: { value: 0 }, uBurstR: { value: 6 },
      uWind: { value: v3([1, -0.4, 0]) }, uVortexC: { value: v3([0, 0, -10]) }, uBurstC: { value: v3([0, 0, -10]) },
      uSun: { value: v3([0.45, 0.4, -0.8]).normalize() }, uBoxMin: { value: v3(boxMin) }, uBoxSize: { value: v3(boxSize) },
      uTint: { value: new THREE.Color(1, 1, 1) }, uBase: { value: new THREE.Color(1, 1, 1) }, uEdge: { value: new THREE.Color(1, 1, 1) },
      uOpacity: { value: 1 }, uShape: { value: 0 }, uGlow: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.u, transparent: true, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.cam = new THREE.PerspectiveCamera(fov, aspect, 0.05, 100); // fixed: particles live in camera space
    this.preset(preset);
  }

  // switch look; embers add light instead of covering what is under them
  preset(name) {
    const p = WEATHER_PRESETS[name];
    if (!p) throw new Error(`unknown weather preset: ${name}`);
    this.u.uShape.value = SHAPE[p.shape];
    this.set({ base: p.base, edge: p.edge, size: p.size, tumble: p.tumble, glow: p.glow });
    this.material.blending = p.shape === "ember" ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.material.needsUpdate = true;
  }

  // params: any of time, field, density, size, swirl, vortex, wind [x,y,z], vortexC, burstT, burstAmt, burstR,
  // burstC, tint, base, edge, opacity, tumble, glow, sun
  set(params) {
    for (const [k, v] of Object.entries(params)) {
      const u = this.u["u" + k[0].toUpperCase() + k.slice(1)];
      if (!u) continue;
      if (Array.isArray(v)) (u.value.isColor ? u.value.setRGB(...v) : u.value.set(...v)); else u.value = v;
    }
  }

  render(renderer) { if (this.u.uDensity.value > 0 && this.u.uOpacity.value > 0) renderer.render(this.scene, this.cam); }
}
