// Ported from zuey-workspace@10719856:.agents/skills/anime-creator/assets/film-engine/engine/src/gl/cel-plate.js (Studix changes are marked "Studix:").
// A still cel drawn fullscreen with a slow camera push (zoom about a focus point), so code FX placed in
// the cel's own frame (blade glints, eye sparkles) stay locked to the drawing.
// With a depth map (scripts/make-depth-maps.py) and `depth` in the shot's cel config it becomes a 2.5D plate:
// dolly, truck and orbit move the near and far parts of the drawing apart, and rack focus blurs by depth.
import * as THREE from "three";
import { lerp, lerp2 } from "../core/film-constants.js";

const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FRAG = /* glsl */ `
  uniform sampler2D uMap; uniform float uZoom; uniform float uAlpha; uniform vec2 uFocus; varying vec2 vUv;
  void main() { gl_FragColor = vec4(texture2D(uMap, uFocus + (vUv - uFocus) / uZoom).rgb, uAlpha); }`;

// 2.5D: the surface at relative depth r (depth - pivot) seen at screen uv p comes from cel uv
// q(r) = F + (p - F - S·r)·(1 - dolly·r) / zoom. March r from near to far in steps of about 1.5 px of travel (thin
// parts are never stepped over) and keep the first surface the ray meets, so the foreground occludes and a
// disoccluded gap stretches the edge next to it (no inpaint). Rack focus blurs by |depth - plane| with four mip taps.
const DEPTH_FRAG = /* glsl */ `
  uniform sampler2D uMap, uDepth;
  uniform vec2 uFocus, uShift, uTexel;
  uniform float uZoom, uDolly, uPivot, uAlpha, uDof, uDofPlane;
  uniform int uSteps;
  varying vec2 vUv;
  vec2 src(float r) { return uFocus + (vUv - uFocus - uShift * r) * (1.0 - uDolly * r) / uZoom; }
  float gap(float r) { return textureLod(uDepth, src(r), 0.0).r - uPivot - r; }   // >= 0: a surface at or before r
  void main() {
    float r0 = 1.0 - uPivot, rPrev = r0, gPrev = gap(r0), rHit = r0;
    if (gPrev < 0.0) for (int i = 1; i <= uSteps; i++) {
      float r = r0 - float(i) / float(uSteps), g = gap(r);
      if (g >= 0.0) { rHit = mix(rPrev, r, gPrev / (gPrev - g)); break; }
      rPrev = r; gPrev = g;
    }
    vec2 q = src(rHit);
    float b = uDof * abs(rHit + uPivot - uDofPlane), lod = log2(1.0 + 0.5 * b);
    vec2 o = 0.35 * b * uTexel;
    vec3 c = textureLod(uMap, q + o, lod).rgb + textureLod(uMap, q - o, lod).rgb
           + textureLod(uMap, q + vec2(o.x, -o.y), lod).rgb + textureLod(uMap, q + vec2(-o.x, o.y), lod).rgb;
    gl_FragColor = vec4(c * 0.25, uAlpha);
  }`;

const ORBIT_R = 1;   // orbit: frame heights of camera travel per radian of arc
const EASE = { linear: (k) => k, in: (k) => k * k, out: (k) => k * (2 - k), inOut: (k) => 0.5 - 0.5 * Math.cos(Math.PI * k) };

// The depth move of a cel shot at progress k (0..1), from SCENE.cels.<id>.depth:
//   dolly [z0, z1]: push toward the pivot plane, near planes grow by 1 / (1 - z·r); 0.1-0.2 reads strong, past 0.25 thin parts smear
//   truck [[x0, y0], [x1, y1]]: camera travel in frame heights (+x right, +y up); near planes slide against it
//   orbit deg | [a0, a1]: arc around the pivot in degrees (a number sweeps -deg/2 -> +deg/2), +: camera swings right
//   strength (1) scales all three; focusDepth (0.5): the pivot plane, in depth-map units (0 far .. 1 near), holds
//   still; ease: linear | in | out | inOut (default). nudge [x, y]: extra camera travel in frame heights (the
//   handheld rig); dof { plane, amount }: rack focus (blur px per unit of depth off the plane).
// Returns the pose for CelPlate.show, with the overscan that keeps every sample inside the cel over the whole move.
export function depthPose(d, k, zoom, focus, { nudge = [0, 0], dof = null } = {}) {
  const ease = EASE[d.ease || "inOut"], s = d.strength ?? 1, pivot = d.focusDepth ?? 0.5;
  const orbit = typeof d.orbit === "number" ? [-d.orbit / 2, d.orbit / 2] : d.orbit || [0, 0];
  const at = (e) => {
    const [tx, ty] = d.truck ? lerp2(d.truck[0], d.truck[1], e) : [0, 0];
    const cx = tx + Math.sin((lerp(orbit[0], orbit[1], e) * Math.PI) / 180) * ORBIT_R;
    return { dolly: (d.dolly ? lerp(d.dolly[0], d.dolly[1], e) : 0) * s, shift: [(-cx * s * 9) / 16, -ty * s] };
  };
  // smallest zoom that keeps q(r) inside the cel at both ends of the move, for the nearest and farthest surface
  let need = 1;
  for (const p of [at(0), at(1)]) for (const r of [-pivot, 1 - pivot]) for (const a of [0, 1]) {
    const m = Math.min(focus[a], 1 - focus[a]);
    need = Math.max(need, (1 - p.dolly * r) * (1 + Math.abs(p.shift[a] * r) / Math.max(m, 0.05)));
  }
  const p = at(ease(k));
  p.shift = [p.shift[0] - (nudge[0] * 9) / 16, p.shift[1] - nudge[1]];
  return { ...p, pivot, overscan: need > 1 ? Math.max(1, (need * 1.005) / Math.min(zoom[0], zoom[1])) : 1, dof };
}

const quad = (frag, uniforms) => {
  const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, transparent: true, depthTest: false, depthWrite: false }));
  q.frustumCulled = false;
  return q;
};

export class CelPlate {
  constructor() {
    this.u = { uMap: { value: null }, uZoom: { value: 1 }, uAlpha: { value: 1 }, uFocus: { value: new THREE.Vector2(0.5, 0.5) } };
    this.d = {
      uMap: { value: null }, uDepth: { value: null }, uZoom: { value: 1 }, uAlpha: { value: 1 }, uFocus: { value: new THREE.Vector2(0.5, 0.5) },
      uShift: { value: new THREE.Vector2() }, uTexel: { value: new THREE.Vector2() }, uDolly: { value: 0 }, uPivot: { value: 0.5 },
      uDof: { value: 0 }, uDofPlane: { value: 0.5 }, uSteps: { value: 16 },
    };
    this.scene = new THREE.Scene();
    this.flat = quad(FRAG, this.u);
    this.deep = quad(DEPTH_FRAG, this.d);
    this.scene.add(this.flat, this.deep);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  // focus in uv (0..1, y up); alpha < 1 draws it over what is already on the canvas (cross-dissolves); depth: a
  // depthPose plus its depth map texture, or null for the flat push. Returns a mapper from cel screen-space points
  // to the pushed frame; a third coordinate (the point's depth-map value) adds its parallax on depth shots.
  show(tex, zoom, [fx, fy], alpha = 1, depth = null) {
    const A = 16 / 9, cx = (fx - 0.5) * 2 * A, cy = (fy - 0.5) * 2;
    this.flat.visible = !depth; this.deep.visible = !!depth;
    if (!depth) {
      this.u.uMap.value = tex; this.u.uZoom.value = zoom; this.u.uAlpha.value = alpha; this.u.uFocus.value.set(fx, fy);
      return ([x, y]) => [cx + (x - cx) * zoom, cy + (y - cy) * zoom];
    }
    const u = this.d, z = zoom * depth.overscan, [sx, sy] = depth.shift;
    u.uMap.value = tex; u.uDepth.value = depth.map; u.uZoom.value = z; u.uAlpha.value = alpha; u.uFocus.value.set(fx, fy);
    u.uShift.value.set(sx, sy); u.uTexel.value.set(1 / tex.image.width, 1 / tex.image.height);
    u.uDolly.value = depth.dolly; u.uPivot.value = depth.pivot;
    // march steps: the farthest a sample travels over the whole depth range, in cel px, at 1.5 px a step
    const dz = Math.abs(depth.dolly), travel = (Math.abs(sx) + dz * Math.max(fx, 1 - fx)) * tex.image.width + (Math.abs(sy) + dz * Math.max(fy, 1 - fy)) * tex.image.height;
    u.uSteps.value = Math.min(240, Math.max(12, Math.ceil(travel / z / 1.5)));
    u.uDof.value = depth.dof ? depth.dof.amount : 0; u.uDofPlane.value = depth.dof ? depth.dof.plane : 0.5;
    return ([x, y, s = depth.pivot]) => {
      const r = s - depth.pivot, g = z / (1 - depth.dolly * r);
      return [cx + (x - cx) * g + sx * 2 * A * r, cy + (y - cy) * g + sy * 2 * r];
    };
  }
  render(renderer) { renderer.render(this.scene, this.cam); }
}
