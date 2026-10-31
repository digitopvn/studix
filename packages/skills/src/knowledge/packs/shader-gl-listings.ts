// Ported from agentkit@9fe46997:kits/engineer/skills/ak-shader/references/ (GLSL listings, built-in
// function reference excluded). Code is kept as published; headings become entries.
import type { KnowledgeSection } from "../knowledge-pack-schema.ts";

/**
 * GLSL ES 1-style listings for the shader-gl pack, one entry per heading of the source references. They
 * illustrate the techniques the pack describes in words; port each one to the target's GLSL version and
 * uniforms, then render it there before relying on it.
 */
export const SHADER_GLSL_LISTINGS: readonly KnowledgeSection[] = [
  {
    id: "fundamentals-glsl",
    title: "Fundamentals: GLSL listings",
    entries: [
      {
        id: "glsl-minimal-shader",
        title: "Minimal Shader",
        text: "GLSL ES 1 listing: Minimal Shader.",
        fields: {
          glsl: "#ifdef GL_ES\nprecision mediump float;\n#endif\n\nuniform float u_time;\nuniform vec2 u_resolution;\n\nvoid main() {\n    vec2 st = gl_FragCoord.xy / u_resolution.xy;\n    gl_FragColor = vec4(st.x, st.y, 0.0, 1.0);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-precision-qualifiers",
        title: "Precision Qualifiers",
        text: "GLSL ES 1 listing: Precision Qualifiers.",
        fields: {
          glsl: "precision lowp float;    // Fast, low quality\nprecision mediump float; // Default, balanced\nprecision highp float;   // Slow, high quality",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-vector-swizzling",
        title: "Vector Swizzling",
        text: "GLSL ES 1 listing: Vector Swizzling.",
        fields: {
          glsl: "vec4 color = vec4(1.0, 0.5, 0.0, 1.0);\nvec3 rgb = color.rgb;      // (1.0, 0.5, 0.0)\nvec2 rg = color.rg;        // (1.0, 0.5)\nfloat r = color.r;         // 1.0\nvec3 bgr = color.bgr;      // (0.0, 0.5, 1.0) - reorder\nvec4 rrrr = color.rrrr;    // (1.0, 1.0, 1.0, 1.0) - repeat",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-vector-construction",
        title: "Vector Construction",
        text: "GLSL ES 1 listing: Vector Construction.",
        fields: {
          glsl: "vec3 a = vec3(1.0);                    // (1.0, 1.0, 1.0)\nvec3 b = vec3(1.0, 2.0, 3.0);          // (1.0, 2.0, 3.0)\nvec4 c = vec4(a, 1.0);                 // (1.0, 1.0, 1.0, 1.0)\nvec4 d = vec4(vec2(0.5), vec2(0.8));   // (0.5, 0.5, 0.8, 0.8)",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-type-casting",
        title: "Type Casting",
        text: "GLSL ES 1 listing: Type Casting.",
        fields: {
          glsl: "float x = 1.0;      // Correct\nfloat y = 1;        // May fail - use 1.0\nint i = int(x);     // Explicit cast\nfloat z = float(i); // Explicit cast",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-output",
        title: "Output",
        text: "GLSL ES 1 listing: Output.",
        fields: { glsl: "gl_FragColor = vec4(red, green, blue, alpha);\n// Values clamped to 0.0-1.0" },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-preprocessor",
        title: "Preprocessor",
        text: "GLSL ES 1 listing: Preprocessor.",
        fields: {
          glsl: "#define PI 3.14159265359\n#define TWO_PI 6.28318530718\n\n#ifdef GL_ES\nprecision mediump float;\n#endif",
        },
        tags: ["glsl-listing"],
      },
    ],
  },
  {
    id: "shaping-glsl",
    title: "Shaping: GLSL listings",
    entries: [
      {
        id: "glsl-core-functions",
        title: "Core Functions",
        text: "GLSL ES 1 listing: Core Functions.",
        fields: {
          glsl: "// step(edge, x)\nfloat y = step(0.5, st.x);  // Black left, white right\n\n// smoothstep(edge0, edge1, x)\nfloat y = smoothstep(0.2, 0.8, st.x);  // Gradual transition\n\n// mix(a, b, t)\nvec3 color = mix(colorA, colorB, st.x);  // Gradient",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-power-functions",
        title: "Power Functions",
        text: "GLSL ES 1 listing: Power Functions.",
        fields: {
          glsl: "float y = pow(st.x, 5.0);     // Exponential curve\nfloat y = sqrt(st.x);         // Square root\nfloat y = exp(st.x);          // Natural exponential\nfloat y = log(st.x);          // Natural logarithm",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-trigonometric-functions",
        title: "Trigonometric Functions",
        text: "GLSL ES 1 listing: Trigonometric Functions.",
        fields: {
          glsl: "float y = sin(st.x * PI);           // Wave (0 to 1 to 0)\nfloat y = cos(st.x * TWO_PI);       // Full cycle\nfloat y = sin(st.x * 10.0 + u_time); // Animated wave\n\nfloat y = sin(x) * 0.5 + 0.5;",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-fractional-modulo",
        title: "Fractional & Modulo",
        text: "GLSL ES 1 listing: Fractional & Modulo.",
        fields: {
          glsl: "float y = fract(st.x * 5.0);  // Sawtooth wave (0 to 1 repeating)\nfloat y = mod(st.x, 0.2);     // Modulo, repeats every 0.2\nfloat y = floor(st.x * 5.0);  // Integer part (0,1,2,3,4...)\nfloat y = ceil(st.x * 5.0);   // Round up",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-absolute-sign",
        title: "Absolute & Sign",
        text: "GLSL ES 1 listing: Absolute & Sign.",
        fields: {
          glsl: "float y = abs(st.x - 0.5);    // V-shape centered at 0.5\nfloat y = sign(st.x - 0.5);   // -1.0, 0.0, or 1.0",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-clamping",
        title: "Clamping",
        text: "GLSL ES 1 listing: Clamping.",
        fields: {
          glsl: "float y = clamp(x, 0.0, 1.0);         // Constrain range\nfloat y = min(a, b);                   // Smaller value\nfloat y = max(a, b);                   // Larger value",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-custom-shaping-curves",
        title: "Custom Shaping Curves",
        text: "GLSL ES 1 listing: Custom Shaping Curves.",
        fields: {
          glsl: "// Polynomial smoothstep (quintic)\nfloat smootherStep(float x) {\n    return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);\n}\n\n// Exponential impulse\nfloat impulse(float k, float x) {\n    float h = k * x;\n    return h * exp(1.0 - h);\n}\n\n// Parabola\nfloat parabola(float x, float k) {\n    return pow(4.0 * x * (1.0 - x), k);\n}\n\n// Cubic pulse\nfloat cubicPulse(float c, float w, float x) {\n    x = abs(x - c);\n    if (x > w) return 0.0;\n    x /= w;\n    return 1.0 - x * x * (3.0 - 2.0 * x);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-combining-functions",
        title: "Combining Functions",
        text: "GLSL ES 1 listing: Combining Functions.",
        fields: {
          glsl: "float y = smoothstep(0.2, 0.4, st.x) - smoothstep(0.6, 0.8, st.x);\n\nfloat edge = 0.01;\nfloat circle = smoothstep(radius + edge, radius - edge, dist);",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-animation-patterns",
        title: "Animation Patterns",
        text: "GLSL ES 1 listing: Animation Patterns.",
        fields: {
          glsl: "// Oscillate 0-1\nfloat t = sin(u_time) * 0.5 + 0.5;\n\n// Sawtooth\nfloat t = fract(u_time);\n\n// Triangle wave\nfloat t = abs(fract(u_time) * 2.0 - 1.0);\n\n// Ping-pong\nfloat t = abs(mod(u_time, 2.0) - 1.0);",
        },
        tags: ["glsl-listing"],
      },
    ],
  },
  {
    id: "colour-glsl",
    title: "Colour: GLSL listings",
    entries: [
      {
        id: "glsl-rgb-color-space",
        title: "RGB Color Space",
        text: "GLSL ES 1 listing: RGB Color Space.",
        fields: {
          glsl: "vec3 red = vec3(1.0, 0.0, 0.0);\nvec3 green = vec3(0.0, 1.0, 0.0);\nvec3 blue = vec3(0.0, 0.0, 1.0);\nvec3 white = vec3(1.0);\nvec3 black = vec3(0.0);\nvec3 gray = vec3(0.5);",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-hex-to-glsl",
        title: "Hex to GLSL",
        text: "GLSL ES 1 listing: Hex to GLSL.",
        fields: {
          glsl: "vec3 hexToRgb(int hex) {\n    return vec3(\n        float((hex >> 16) & 0xFF) / 255.0,\n        float((hex >> 8) & 0xFF) / 255.0,\n        float(hex & 0xFF) / 255.0\n    );\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-color-mixing",
        title: "Color Mixing",
        text: "GLSL ES 1 listing: Color Mixing.",
        fields: {
          glsl: "// Linear interpolation\nvec3 color = mix(colorA, colorB, 0.5);\n\n// Per-channel mixing\nvec3 color = mix(colorA, colorB, vec3(0.2, 0.5, 0.8));\n\n// Multiply (darken)\nvec3 color = colorA * colorB;\n\n// Screen (lighten)\nvec3 color = 1.0 - (1.0 - colorA) * (1.0 - colorB);\n\n// Add (glow)\nvec3 color = colorA + colorB;",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-gradients",
        title: "Gradients",
        text: "GLSL ES 1 listing: Gradients.",
        fields: {
          glsl: "// Horizontal gradient\nvec3 color = mix(colorA, colorB, st.x);\n\n// Vertical gradient\nvec3 color = mix(colorA, colorB, st.y);\n\n// Radial gradient\nfloat d = distance(st, vec2(0.5));\nvec3 color = mix(centerColor, edgeColor, d);\n\n// Multi-stop gradient\nvec3 gradient(float t) {\n    vec3 a = vec3(0.0, 0.0, 0.5);  // Dark blue\n    vec3 b = vec3(0.0, 0.5, 1.0);  // Light blue\n    vec3 c = vec3(1.0, 1.0, 0.0);  // Yellow\n    vec3 d = vec3(1.0, 0.5, 0.0);  // Orange\n\n    if (t < 0.33) return mix(a, b, t * 3.0);\n    if (t < 0.66) return mix(b, c, (t - 0.33) * 3.0);\n    return mix(c, d, (t - 0.66) * 3.0);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-hsb-hsv-color-space",
        title: "HSB/HSV Color Space",
        text: "GLSL ES 1 listing: HSB/HSV Color Space. hsb2rgb is the smooth HSV conversion by Inigo Quilez, whose algorithm code is MIT licensed; keep this notice with any copy.",
        fields: {
          glsl: "// RGB to HSB\nvec3 rgb2hsb(vec3 c) {\n    vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);\n    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));\n    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));\n    float d = q.x - min(q.w, q.y);\n    float e = 1.0e-10;\n    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);\n}\n\n// HSB to RGB\nvec3 hsb2rgb(vec3 c) {\n    vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0,\n                     0.0, 1.0);\n    rgb = rgb * rgb * (3.0 - 2.0 * rgb);\n    return c.z * mix(vec3(1.0), rgb, c.y);\n}\n\n// HSB Usage\n// Rainbow across x-axis\nvec3 color = hsb2rgb(vec3(st.x, 1.0, 1.0));\n\n// Color wheel (polar coordinates)\nvec2 toCenter = st - 0.5;\nfloat angle = atan(toCenter.y, toCenter.x);\nfloat hue = angle / TWO_PI + 0.5;  // Normalize to 0-1\nfloat sat = length(toCenter) * 2.0;\nvec3 color = hsb2rgb(vec3(hue, sat, 1.0));",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-animated-colors",
        title: "Animated Colors",
        text: "GLSL ES 1 listing: Animated Colors.",
        fields: {
          glsl: "// Cycling hue\nfloat hue = fract(u_time * 0.1);\nvec3 color = hsb2rgb(vec3(hue, 1.0, 1.0));\n\n// Pulsing brightness\nfloat brightness = sin(u_time) * 0.5 + 0.5;\nvec3 color = baseColor * brightness;\n\n// Color oscillation\nvec3 color = mix(colorA, colorB, sin(u_time) * 0.5 + 0.5);",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-color-correction",
        title: "Color Correction",
        text: "GLSL ES 1 listing: Color Correction.",
        fields: {
          glsl: "vec3 gamma(vec3 c, float g) { return pow(c, vec3(1.0 / g)); }\nvec3 contrast(vec3 c, float a) { return (c - 0.5) * a + 0.5; }\nvec3 saturation(vec3 c, float a) { return mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, a); }",
        },
        tags: ["glsl-listing"],
      },
    ],
  },
  {
    id: "shapes-sdf-glsl",
    title: "Shapes and distance fields: GLSL listings",
    entries: [
      {
        id: "glsl-circle",
        title: "Circle",
        text: "GLSL ES 1 listing: Circle.",
        fields: {
          glsl: "// Basic circle\nfloat circle(vec2 st, vec2 center, float radius) {\n    float d = distance(st, center);\n    return 1.0 - step(radius, d);\n}\n\n// Smooth edge circle\nfloat circleSDF(vec2 st, vec2 center, float radius) {\n    return length(st - center) - radius;\n}\n\n// Usage\nfloat d = circleSDF(st, vec2(0.5), 0.3);\nvec3 color = vec3(1.0 - smoothstep(0.0, 0.01, d));",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-rectangle",
        title: "Rectangle",
        text: "GLSL ES 1 listing: Rectangle.",
        fields: {
          glsl: "// Basic rectangle\nfloat rect(vec2 st, vec2 pos, vec2 size) {\n    vec2 bl = step(pos, st);\n    vec2 tr = step(1.0 - pos - size, 1.0 - st);\n    return bl.x * bl.y * tr.x * tr.y;\n}\n\n// Rectangle SDF\nfloat rectSDF(vec2 st, vec2 center, vec2 size) {\n    vec2 d = abs(st - center) - size * 0.5;\n    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);\n}\n\n// Rounded rectangle SDF\nfloat roundedRectSDF(vec2 st, vec2 center, vec2 size, float radius) {\n    vec2 d = abs(st - center) - size * 0.5 + radius;\n    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-line",
        title: "Line",
        text: "GLSL ES 1 listing: Line.",
        fields: {
          glsl: "// Line segment SDF\nfloat lineSDF(vec2 p, vec2 a, vec2 b) {\n    vec2 pa = p - a;\n    vec2 ba = b - a;\n    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);\n    return length(pa - ba * h);\n}\n\n// Draw line with thickness\nfloat line(vec2 st, vec2 a, vec2 b, float thickness) {\n    float d = lineSDF(st, a, b);\n    return 1.0 - smoothstep(0.0, thickness, d);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-shape-outlines",
        title: "Shape Outlines",
        text: "GLSL ES 1 listing: Shape Outlines.",
        fields: {
          glsl: "// Outline only\nfloat outline(float d, float thickness) {\n    return 1.0 - smoothstep(0.0, thickness, abs(d));\n}\n\n// Fill with outline\nvec3 fillWithOutline(float d, vec3 fill, vec3 stroke, float thick) {\n    float fillMask = 1.0 - smoothstep(0.0, 0.01, d);\n    float edge = 1.0 - smoothstep(0.0, thick, abs(d));\n    return mix(fill * fillMask, stroke, edge * (1.0 - fillMask));\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-2d-transformations",
        title: "2D Transformations",
        text: "GLSL ES 1 listing: 2D Transformations.",
        fields: {
          glsl: "// Rotate point around center\nvec2 rotate(vec2 st, vec2 center, float angle) {\n    st -= center;\n    float c = cos(angle);\n    float s = sin(angle);\n    st = mat2(c, -s, s, c) * st;\n    return st + center;\n}\n\n// Scale from center\nvec2 scale(vec2 st, vec2 center, vec2 s) {\n    return (st - center) / s + center;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-regular-polygon-n-sides",
        title: "Regular Polygon (N sides)",
        text: "GLSL ES 1 listing: Regular Polygon (N sides).",
        fields: {
          glsl: "float polygonSDF(vec2 st, vec2 center, float radius, int sides) {\n    st -= center;\n    float a = atan(st.y, st.x) + PI;\n    float r = TWO_PI / float(sides);\n    float d = cos(floor(0.5 + a / r) * r - a) * length(st);\n    return d - radius;\n}\n\n// Usage: hexagon\nfloat hex = polygonSDF(st, vec2(0.5), 0.3, 6);",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-star-shape",
        title: "Star Shape",
        text: "GLSL ES 1 listing: Star Shape.",
        fields: {
          glsl: "float starSDF(vec2 st, vec2 center, float r1, float r2, int points) {\n    st -= center;\n    float a = atan(st.y, st.x);\n    float seg = TWO_PI / float(points);\n    a = mod(a, seg) - seg * 0.5;\n    float r = length(st);\n    float inner = r2 / cos(seg * 0.5);\n    float d = mix(r1, inner, step(0.0, a) * 2.0 - 1.0);\n    return r - d;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-polar-shapes",
        title: "Polar Shapes",
        text: "GLSL ES 1 listing: Polar Shapes.",
        fields: {
          glsl: "// Convert to polar coordinates\nvec2 toPolar(vec2 st) {\n    vec2 pos = st - 0.5;\n    float r = length(pos) * 2.0;\n    float a = atan(pos.y, pos.x);\n    return vec2(r, a);\n}\n\n// Polar flower\nfloat flowerSDF(vec2 st, int petals, float amplitude) {\n    vec2 polar = toPolar(st);\n    float shape = 0.5 + amplitude * cos(float(petals) * polar.y);\n    return polar.x - shape;\n}\n\n// Gear shape\nfloat gearSDF(vec2 st, int teeth, float innerR, float outerR) {\n    vec2 polar = toPolar(st);\n    float tooth = step(0.5, fract(polar.y * float(teeth) / TWO_PI));\n    float radius = mix(innerR, outerR, tooth);\n    return polar.x - radius;\n}\n\n// Heart\nfloat heartSDF(vec2 st) {\n    st -= vec2(0.5, 0.4);\n    st.x *= 0.8;\n    float a = atan(st.x, st.y) / PI;\n    float r = length(st);\n    float h = abs(a);\n    float d = (13.0 * h - 22.0 * h * h + 10.0 * h * h * h) / (6.0 - 5.0 * h);\n    return r - d * 0.3;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-combining-sdfs",
        title: "Combining SDFs",
        text: "GLSL ES 1 listing: Combining SDFs.",
        fields: {
          glsl: "// Union (OR) - combine shapes\nfloat sdfUnion(float d1, float d2) {\n    return min(d1, d2);\n}\n\n// Intersection (AND) - overlap only\nfloat sdfIntersect(float d1, float d2) {\n    return max(d1, d2);\n}\n\n// Subtraction - cut out\nfloat sdfSubtract(float d1, float d2) {\n    return max(d1, -d2);\n}\n\n// XOR - either but not both\nfloat sdfXor(float d1, float d2) {\n    return max(min(d1, d2), -max(d1, d2));\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-smooth-boolean-operations",
        title: "Smooth Boolean Operations",
        text: "GLSL ES 1 listing: Smooth Boolean Operations.",
        fields: {
          glsl: "// Smooth union (blended edges)\nfloat sdfSmoothUnion(float d1, float d2, float k) {\n    float h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0.0, 1.0);\n    return mix(d2, d1, h) - k * h * (1.0 - h);\n}\n\n// Smooth subtraction\nfloat sdfSmoothSubtract(float d1, float d2, float k) {\n    float h = clamp(0.5 - 0.5 * (d2 + d1) / k, 0.0, 1.0);\n    return mix(d1, -d2, h) + k * h * (1.0 - h);\n}\n\n// Smooth intersection\nfloat sdfSmoothIntersect(float d1, float d2, float k) {\n    float h = clamp(0.5 - 0.5 * (d2 - d1) / k, 0.0, 1.0);\n    return mix(d2, d1, h) + k * h * (1.0 - h);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-sdf-modifications",
        title: "SDF Modifications",
        text: "GLSL ES 1 listing: SDF Modifications.",
        fields: {
          glsl: "float ring(float d, float thickness) { return abs(d) - thickness; }\nfloat roundSDF(float d, float r) { return d - r; }",
        },
        tags: ["glsl-listing"],
      },
    ],
  },
  {
    id: "patterns-glsl",
    title: "Patterns: GLSL listings",
    entries: [
      {
        id: "glsl-basic-tiling-with-fract",
        title: "Basic Tiling with fract()",
        text: "GLSL ES 1 listing: Basic Tiling with fract().",
        fields: {
          glsl: "// Tile space into grid\nvec2 tile(vec2 st, float n) {\n    return fract(st * n);\n}\n\n// Usage: 4x4 grid\nvec2 tiled = tile(st, 4.0);",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-grid-with-cell-index",
        title: "Grid with Cell Index",
        text: "GLSL ES 1 listing: Grid with Cell Index.",
        fields: {
          glsl: "// Get both cell index and position within cell\nvec2 grid(vec2 st, float n, out vec2 cellIndex) {\n    st *= n;\n    cellIndex = floor(st);\n    return fract(st);\n}\n\n// Usage\nvec2 idx;\nvec2 local = grid(st, 4.0, idx);",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-brick-pattern-offset-rows",
        title: "Brick Pattern (Offset Rows)",
        text: "GLSL ES 1 listing: Brick Pattern (Offset Rows).",
        fields: {
          glsl: "vec2 brickTile(vec2 st, float n) {\n    st *= n;\n    float row = floor(st.y);\n    st.x += mod(row, 2.0) * 0.5;  // Offset odd rows\n    return fract(st);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-hex-grid",
        title: "Hex Grid",
        text: "GLSL ES 1 listing: Hex Grid.",
        fields: {
          glsl: "vec2 hexGrid(vec2 st, float scale) {\n    st *= scale;\n    vec2 r = vec2(1.0, 1.73205);  // sqrt(3)\n    vec2 h = r * 0.5;\n    vec2 a = mod(st, r) - h;\n    vec2 b = mod(st - h, r) - h;\n    return dot(a, a) < dot(b, b) ? a : b;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-2d-rotation-matrix",
        title: "2D Rotation Matrix",
        text: "GLSL ES 1 listing: 2D Rotation Matrix.",
        fields: {
          glsl: "mat2 rotate2d(float angle) {\n    float c = cos(angle);\n    float s = sin(angle);\n    return mat2(c, -s, s, c);\n}\n\n// Rotate around center\nvec2 rotateAround(vec2 st, vec2 center, float angle) {\n    return rotate2d(angle) * (st - center) + center;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-scale-matrix",
        title: "Scale Matrix",
        text: "GLSL ES 1 listing: Scale Matrix.",
        fields: {
          glsl: "mat2 scale2d(vec2 scale) {\n    return mat2(scale.x, 0.0, 0.0, scale.y);\n}\n\nvec2 scaleFrom(vec2 st, vec2 center, vec2 s) {\n    return scale2d(s) * (st - center) + center;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-checkerboard",
        title: "Checkerboard",
        text: "GLSL ES 1 listing: Checkerboard.",
        fields: {
          glsl: "float checker(vec2 st, float n) {\n    st *= n;\n    vec2 idx = floor(st);\n    return mod(idx.x + idx.y, 2.0);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-stripes",
        title: "Stripes",
        text: "GLSL ES 1 listing: Stripes.",
        fields: {
          glsl: "// Horizontal stripes\nfloat stripes(float y, float n) {\n    return step(0.5, fract(y * n));\n}\n\n// Diagonal stripes\nfloat diagonalStripes(vec2 st, float n, float angle) {\n    vec2 rotated = rotate2d(angle) * st;\n    return step(0.5, fract(rotated.x * n));\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-polar-patterns",
        title: "Polar Patterns",
        text: "GLSL ES 1 listing: Polar Patterns.",
        fields: {
          glsl: "// Convert to polar for radial patterns\nvec2 toPolar(vec2 st) {\n    vec2 pos = st - 0.5;\n    float r = length(pos) * 2.0;\n    float a = atan(pos.y, pos.x);\n    return vec2(r, a);\n}\n\n// Repeat around center\nfloat radialRepeat(vec2 st, float n) {\n    vec2 polar = toPolar(st);\n    polar.y = fract(polar.y * n / TWO_PI);\n    return polar.y;\n}\n\n// Spiral\nfloat spiral(vec2 st, float turns) {\n    vec2 polar = toPolar(st);\n    return fract(polar.x - polar.y * turns / TWO_PI);\n}",
        },
        tags: ["glsl-listing"],
      },
    ],
  },
  {
    id: "symmetry-truchet-warping-glsl",
    title: "Symmetry, truchet and domain warping: GLSL listings",
    entries: [
      {
        id: "glsl-mirror-reflection",
        title: "Mirror/Reflection",
        text: "GLSL ES 1 listing: Mirror/Reflection.",
        fields: {
          glsl: "// Mirror horizontally\nvec2 mirrorX(vec2 st) {\n    return vec2(abs(st.x - 0.5) + 0.5, st.y);\n}\n\n// Mirror vertically\nvec2 mirrorY(vec2 st) {\n    return vec2(st.x, abs(st.y - 0.5) + 0.5);\n}\n\n// Kaleidoscope (4-fold symmetry)\nvec2 kaleidoscope(vec2 st) {\n    st -= 0.5;\n    st = abs(st);\n    return st + 0.5;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-n-fold-radial-symmetry",
        title: "N-fold Radial Symmetry",
        text: "GLSL ES 1 listing: N-fold Radial Symmetry.",
        fields: {
          glsl: "vec2 radialSymmetry(vec2 st, float n) {\n    st -= 0.5;\n    float angle = atan(st.y, st.x);\n    float segment = TWO_PI / n;\n    angle = mod(angle, segment);\n    float r = length(st);\n    return vec2(cos(angle), sin(angle)) * r + 0.5;\n}\n\n// Usage: 6-fold snowflake symmetry\nvec2 sym = radialSymmetry(st, 6.0);",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-truchet-tiles",
        title: "Truchet Tiles",
        text: "GLSL ES 1 listing: Truchet Tiles.",
        fields: {
          glsl: "float random(vec2 st) {\n    return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453);\n}\n\nfloat truchet(vec2 st, float n) {\n    st *= n;\n    vec2 idx = floor(st);\n    vec2 local = fract(st);\n\n    // Random rotation per cell (0, 90, 180, 270 degrees)\n    float r = random(idx);\n    if (r < 0.25) local = local;\n    else if (r < 0.5) local = vec2(1.0 - local.y, local.x);\n    else if (r < 0.75) local = 1.0 - local;\n    else local = vec2(local.y, 1.0 - local.x);\n\n    // Draw quarter circles\n    float d1 = length(local);\n    float d2 = length(local - 1.0);\n    return min(abs(d1 - 0.5), abs(d2 - 0.5));\n}\n\n// Usage\nfloat pattern = 1.0 - smoothstep(0.0, 0.05, truchet(st, 8.0));",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-truchet-variations",
        title: "Truchet Variations",
        text: "GLSL ES 1 listing: Truchet Variations.",
        fields: {
          glsl: "// Line-based Truchet\nfloat truchetLines(vec2 st, float n) {\n    st *= n;\n    vec2 idx = floor(st);\n    vec2 local = fract(st);\n\n    float r = random(idx);\n    if (r > 0.5) local = vec2(local.y, local.x);  // Flip diagonal\n\n    // Diagonal line\n    return abs(local.x - local.y);\n}\n\n// Maze pattern\nfloat truchetMaze(vec2 st, float n) {\n    st *= n;\n    vec2 idx = floor(st);\n    vec2 local = fract(st) - 0.5;\n\n    float r = random(idx);\n    if (r > 0.5) local.x = -local.x;\n\n    return smoothstep(0.0, 0.1, abs(local.x + local.y));\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-domain-warping",
        title: "Domain Warping",
        text: "GLSL ES 1 listing: Domain Warping.",
        fields: {
          glsl: "vec2 warp(vec2 st, float a) {\n    return st + vec2(sin(st.y * 10.0), sin(st.x * 10.0)) * a;\n}\n\nvec2 animatedWarp(vec2 st, float t, float a) {\n    return st + vec2(sin(st.y * 5.0 + t), cos(st.x * 5.0 + t * 1.3)) * a;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-iterative-domain-warping",
        title: "Iterative Domain Warping",
        text: "GLSL ES 1 listing: Iterative Domain Warping.",
        fields: {
          glsl: "vec2 iterativeWarp(vec2 st, int iterations) {\n    for (int i = 0; i < iterations; i++) {\n        st = vec2(valueNoise(st), valueNoise(st + 5.0)) * 2.0 - 1.0 + st;\n    }\n    return st;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-practical-pattern-examples",
        title: "Practical Pattern Examples",
        text: "GLSL ES 1 listing: Practical Pattern Examples.",
        fields: {
          glsl: "// Islamic-style pattern\nfloat islamicPattern(vec2 st, float n) {\n    st = radialSymmetry(st, 8.0);\n    st = tile(st, n);\n    return smoothstep(0.4, 0.41, length(st - 0.5));\n}",
        },
        tags: ["glsl-listing"],
      },
    ],
  },
  {
    id: "noise-glsl",
    title: "Noise: GLSL listings",
    entries: [
      {
        id: "glsl-pseudo-random-function",
        title: "Pseudo-Random Function",
        text: "GLSL ES 1 listing: Pseudo-Random Function.",
        fields: {
          glsl: "// 1D random\nfloat random(float x) {\n    return fract(sin(x) * 43758.5453);\n}\n\n// 2D random\nfloat random(vec2 st) {\n    return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453);\n}\n\n// 2D random returning vec2\nvec2 random2(vec2 st) {\n    st = vec2(dot(st, vec2(127.1, 311.7)), dot(st, vec2(269.5, 183.3)));\n    return fract(sin(st) * 43758.5453123);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-value-noise",
        title: "Value Noise",
        text: "GLSL ES 1 listing: Value Noise.",
        fields: {
          glsl: "float valueNoise(vec2 st) {\n    vec2 i = floor(st);\n    vec2 f = fract(st);\n\n    // Four corners\n    float a = random(i);\n    float b = random(i + vec2(1.0, 0.0));\n    float c = random(i + vec2(0.0, 1.0));\n    float d = random(i + vec2(1.0, 1.0));\n\n    // Smooth interpolation\n    vec2 u = f * f * (3.0 - 2.0 * f);\n\n    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-gradient-noise-perlin-like",
        title: "Gradient Noise (Perlin-like)",
        text: "GLSL ES 1 listing: Gradient Noise (Perlin-like).",
        fields: {
          glsl: "vec2 grad(vec2 i) {\n    float a = random(i) * TWO_PI;\n    return vec2(cos(a), sin(a));\n}\n\nfloat gradientNoise(vec2 st) {\n    vec2 i = floor(st);\n    vec2 f = fract(st);\n\n    float a = dot(grad(i), f);\n    float b = dot(grad(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));\n    float c = dot(grad(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));\n    float d = dot(grad(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));\n\n    // Quintic interpolation\n    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);\n\n    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 0.5 + 0.5;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-simplex-noise-2d",
        title: "Simplex Noise (2D)",
        text: "GLSL ES 1 listing: Simplex Noise (2D). The 2D simplex noise of the webgl-noise library by Ian McEwan and Stefan Gustavson (Ashima Arts), MIT License; keep this notice with any copy.",
        fields: {
          glsl: "vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }\n\nfloat simplexNoise(vec2 v) {\n    const vec4 C = vec4(0.211324865405187, 0.366025403784439,\n                        -0.577350269189626, 0.024390243902439);\n    vec2 i  = floor(v + dot(v, C.yy));\n    vec2 x0 = v - i + dot(i, C.xx);\n    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);\n    vec4 x12 = x0.xyxy + C.xxzz;\n    x12.xy -= i1;\n    i = mod(i, 289.0);\n    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));\n    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);\n    m = m * m; m = m * m;\n    vec3 x = 2.0 * fract(p * C.www) - 1.0;\n    vec3 h = abs(x) - 0.5;\n    vec3 ox = floor(x + 0.5);\n    vec3 a0 = x - ox;\n    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);\n    vec3 g;\n    g.x  = a0.x  * x0.x  + h.x  * x0.y;\n    g.yz = a0.yz * x12.xz + h.yz * x12.yw;\n    return 130.0 * dot(m, g);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-animated-noise",
        title: "Animated Noise",
        text: "GLSL ES 1 listing: Animated Noise.",
        fields: {
          glsl: "float animatedNoise(vec2 st, float time) {\n    return valueNoise(st + vec2(time * 0.1));\n}\n\nfloat flowingNoise(vec2 st, float time) {\n    vec2 offset = vec2(sin(time * 0.5), cos(time * 0.3)) * 2.0;\n    return valueNoise(st + offset);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-basic-cellular-noise",
        title: "Basic Cellular Noise",
        text: "GLSL ES 1 listing: Basic Cellular Noise.",
        fields: {
          glsl: "float cellularNoise(vec2 st) {\n    vec2 i = floor(st);\n    vec2 f = fract(st);\n\n    float minDist = 1.0;\n\n    // Check 3x3 neighborhood\n    for (int y = -1; y <= 1; y++) {\n        for (int x = -1; x <= 1; x++) {\n            vec2 neighbor = vec2(float(x), float(y));\n            vec2 point = random2(i + neighbor);\n            vec2 diff = neighbor + point - f;\n            float dist = length(diff);\n            minDist = min(minDist, dist);\n        }\n    }\n\n    return minDist;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-voronoi-with-cell-id",
        title: "Voronoi with Cell ID",
        text: "GLSL ES 1 listing: Voronoi with Cell ID.",
        fields: {
          glsl: "vec3 voronoi(vec2 st) {\n    vec2 i = floor(st);\n    vec2 f = fract(st);\n\n    float minDist = 1.0;\n    vec2 minPoint;\n\n    for (int y = -1; y <= 1; y++) {\n        for (int x = -1; x <= 1; x++) {\n            vec2 neighbor = vec2(float(x), float(y));\n            vec2 point = random2(i + neighbor);\n            vec2 diff = neighbor + point - f;\n            float dist = length(diff);\n            if (dist < minDist) {\n                minDist = dist;\n                minPoint = i + neighbor + point;\n            }\n        }\n    }\n\n    // Returns: distance, cell id x, cell id y\n    return vec3(minDist, minPoint);\n}\n\n// Color cells by ID\nvec3 voronoiColor(vec2 st, float scale) {\n    vec3 v = voronoi(st * scale);\n    return vec3(random(v.yz), random(v.yz + 1.0), random(v.yz + 2.0));\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-worley-noise-f1-f2",
        title: "Worley Noise (F1, F2)",
        text: "GLSL ES 1 listing: Worley Noise (F1, F2).",
        fields: {
          glsl: "vec2 worleyNoise(vec2 st) {\n    vec2 i = floor(st);\n    vec2 f = fract(st);\n\n    float f1 = 1.0;  // Nearest\n    float f2 = 1.0;  // Second nearest\n\n    for (int y = -1; y <= 1; y++) {\n        for (int x = -1; x <= 1; x++) {\n            vec2 neighbor = vec2(float(x), float(y));\n            vec2 point = random2(i + neighbor);\n            float dist = length(neighbor + point - f);\n\n            if (dist < f1) {\n                f2 = f1;\n                f1 = dist;\n            } else if (dist < f2) {\n                f2 = dist;\n            }\n        }\n    }\n\n    return vec2(f1, f2);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-worley-variations",
        title: "Worley Variations",
        text: "GLSL ES 1 listing: Worley Variations.",
        fields: {
          glsl: "float worleyF1(vec2 st) { return worleyNoise(st).x; }\nfloat worleyEdges(vec2 st) { vec2 w = worleyNoise(st); return w.y - w.x; }\nfloat worleyBlobs(vec2 st) { vec2 w = worleyNoise(st); return w.x * w.y; }",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-animated-voronoi",
        title: "Animated Voronoi",
        text: "GLSL ES 1 listing: Animated Voronoi.",
        fields: {
          glsl: "float animatedVoronoi(vec2 st, float time) {\n    vec2 i = floor(st);\n    vec2 f = fract(st);\n\n    float minDist = 1.0;\n\n    for (int y = -1; y <= 1; y++) {\n        for (int x = -1; x <= 1; x++) {\n            vec2 neighbor = vec2(float(x), float(y));\n            vec2 point = random2(i + neighbor);\n            // Animate point position\n            point = 0.5 + 0.5 * sin(time + 6.2831 * point);\n            float dist = length(neighbor + point - f);\n            minDist = min(minDist, dist);\n        }\n    }\n\n    return minDist;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-distance-metrics",
        title: "Distance Metrics",
        text: "GLSL ES 1 listing: Distance Metrics.",
        fields: {
          glsl: "float euclidean(vec2 v) { return length(v); }\nfloat manhattan(vec2 v) { return abs(v.x) + abs(v.y); }\nfloat chebyshev(vec2 v) { return max(abs(v.x), abs(v.y)); }",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-practical-applications",
        title: "Practical Applications",
        text: "GLSL ES 1 listing: Practical Applications.",
        fields: {
          glsl: "// Cracked ground\nvec3 crackedGround(vec2 st) {\n    float edges = worleyEdges(st * 5.0);\n    return mix(vec3(0.1), vec3(0.5, 0.4, 0.3), smoothstep(0.0, 0.05, edges));\n}",
        },
        tags: ["glsl-listing"],
      },
    ],
  },
  {
    id: "fbm-turbulence-glsl",
    title: "fBm and turbulence: GLSL listings",
    entries: [
      {
        id: "glsl-basic-fbm",
        title: "Basic fBm",
        text: "GLSL ES 1 listing: Basic fBm.",
        fields: {
          glsl: "float fbm(vec2 st) {\n    float value = 0.0;\n    float amplitude = 0.5;\n    float frequency = 1.0;\n\n    // 6 octaves\n    for (int i = 0; i < 6; i++) {\n        value += amplitude * noise(st * frequency);\n        frequency *= 2.0;    // Lacunarity\n        amplitude *= 0.5;    // Gain (persistence)\n    }\n\n    return value;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-fbm-parameters",
        title: "fBm Parameters",
        text: "GLSL ES 1 listing: fBm Parameters.",
        fields: {
          glsl: "float fbm(vec2 st, int octaves, float lacunarity, float gain) {\n    float value = 0.0;\n    float amplitude = 0.5;\n    float frequency = 1.0;\n\n    for (int i = 0; i < octaves; i++) {\n        value += amplitude * noise(st * frequency);\n        frequency *= lacunarity;\n        amplitude *= gain;\n    }\n\n    return value;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-turbulence",
        title: "Turbulence",
        text: "GLSL ES 1 listing: Turbulence.",
        fields: {
          glsl: "float turbulence(vec2 st) {\n    float value = 0.0;\n    float amplitude = 0.5;\n    float frequency = 1.0;\n\n    for (int i = 0; i < 6; i++) {\n        value += amplitude * abs(noise(st * frequency) * 2.0 - 1.0);\n        frequency *= 2.0;\n        amplitude *= 0.5;\n    }\n\n    return value;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-ridged-noise",
        title: "Ridged Noise",
        text: "GLSL ES 1 listing: Ridged Noise.",
        fields: {
          glsl: "float ridged(vec2 st) {\n    float value = 0.0;\n    float amplitude = 0.5;\n    float frequency = 1.0;\n    float prev = 1.0;\n\n    for (int i = 0; i < 6; i++) {\n        float n = abs(noise(st * frequency) * 2.0 - 1.0);\n        n = 1.0 - n;           // Invert\n        n = n * n;             // Sharpen\n        n *= prev;             // Weight by previous\n        prev = n;\n        value += n * amplitude;\n        frequency *= 2.0;\n        amplitude *= 0.5;\n    }\n\n    return value;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-warped-fbm-domain-warping",
        title: "Warped fBm (Domain Warping)",
        text: "GLSL ES 1 listing: Warped fBm (Domain Warping).",
        fields: {
          glsl: "float warpedFbm(vec2 st) {\n    vec2 q = vec2(fbm(st), fbm(st + vec2(5.2, 1.3)));\n    vec2 r = vec2(\n        fbm(st + 4.0 * q + vec2(1.7, 9.2)),\n        fbm(st + 4.0 * q + vec2(8.3, 2.8))\n    );\n    return fbm(st + 4.0 * r);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-animated-fbm",
        title: "Animated fBm",
        text: "GLSL ES 1 listing: Animated fBm.",
        fields: {
          glsl: "float animatedFbm(vec2 st, float time) {\n    float value = 0.0;\n    float amplitude = 0.5;\n    float frequency = 1.0;\n\n    for (int i = 0; i < 6; i++) {\n        vec2 offset = vec2(time * 0.1 * float(i + 1));\n        value += amplitude * noise(st * frequency + offset);\n        frequency *= 2.0;\n        amplitude *= 0.5;\n    }\n\n    return value;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-multifractal",
        title: "Multifractal",
        text: "GLSL ES 1 listing: Multifractal.",
        fields: {
          glsl: "float multifractal(vec2 st, float H, float lacunarity, int octaves) {\n    float value = 1.0;\n    float frequency = 1.0;\n\n    for (int i = 0; i < octaves; i++) {\n        value *= noise(st * frequency) * pow(frequency, -H) + 1.0;\n        frequency *= lacunarity;\n    }\n\n    return value;\n}",
        },
        tags: ["glsl-listing"],
      },
    ],
  },
  {
    id: "procedural-textures-glsl",
    title: "Procedural textures: GLSL listings",
    entries: [
      {
        id: "glsl-clouds",
        title: "Clouds",
        text: "GLSL ES 1 listing: Clouds.",
        fields: {
          glsl: "vec3 clouds(vec2 st, float time) {\n    float n = fbm(st * 3.0 + vec2(time * 0.1, 0.0));\n    n = smoothstep(0.4, 0.6, n);\n    return mix(vec3(0.4, 0.6, 0.9), vec3(1.0), n);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-marble",
        title: "Marble",
        text: "GLSL ES 1 listing: Marble.",
        fields: {
          glsl: "float marble(vec2 st) {\n    float n = fbm(st * 4.0);\n    return sin(st.x * 10.0 + n * 20.0) * 0.5 + 0.5;\n}\n\nvec3 marbleColor(vec2 st) {\n    float v = marble(st);\n    vec3 white = vec3(0.95);\n    vec3 gray = vec3(0.3);\n    return mix(gray, white, v);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-wood-grain",
        title: "Wood Grain",
        text: "GLSL ES 1 listing: Wood Grain.",
        fields: {
          glsl: "float wood(vec2 st) {\n    float n = fbm(st * 2.0);\n    float grain = sin((st.x + n * 0.5) * 50.0) * 0.5 + 0.5;\n    return mix(0.3, 0.6, grain);\n}\n\nvec3 woodColor(vec2 st) {\n    float v = wood(st);\n    vec3 light = vec3(0.76, 0.60, 0.42);\n    vec3 dark = vec3(0.44, 0.30, 0.18);\n    return mix(dark, light, v);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-terrain-height",
        title: "Terrain Height",
        text: "GLSL ES 1 listing: Terrain Height.",
        fields: {
          glsl: "float terrain(vec2 st) {\n    float h = fbm(st * 2.0);\n    h += ridged(st * 4.0) * 0.5;\n    return h;\n}\n\nvec3 terrainColor(vec2 st) {\n    float h = terrain(st);\n    vec3 water = vec3(0.1, 0.3, 0.5);\n    vec3 sand = vec3(0.76, 0.70, 0.50);\n    vec3 grass = vec3(0.2, 0.5, 0.2);\n    vec3 rock = vec3(0.5, 0.5, 0.5);\n    vec3 snow = vec3(1.0);\n\n    if (h < 0.3) return mix(water, sand, h / 0.3);\n    if (h < 0.5) return mix(sand, grass, (h - 0.3) / 0.2);\n    if (h < 0.7) return mix(grass, rock, (h - 0.5) / 0.2);\n    return mix(rock, snow, (h - 0.7) / 0.3);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-fire-smoke",
        title: "Fire / Smoke",
        text: "GLSL ES 1 listing: Fire / Smoke.",
        fields: {
          glsl: "vec3 fire(vec2 st, float time) {\n    vec2 q = st;\n    q.y -= time * 0.5;  // Rise\n\n    float n = turbulence(q * 3.0);\n    n *= smoothstep(1.0, 0.0, st.y);  // Fade at top\n\n    vec3 col = mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), n);\n    return col * n;\n}\n\nvec3 smoke(vec2 st, float time) {\n    vec2 q = st;\n    q.y -= time * 0.2;\n\n    float n = fbm(q * 4.0);\n    n *= smoothstep(1.0, 0.0, st.y);\n\n    return vec3(0.3 + n * 0.3) * n;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-water-caustics",
        title: "Water Caustics",
        text: "GLSL ES 1 listing: Water Caustics.",
        fields: {
          glsl: "float caustics(vec2 st, float time) {\n    vec2 p = st * 8.0;\n    float c = 0.0;\n    for (int i = 0; i < 3; i++) {\n        float t = time * (0.5 + float(i) * 0.1);\n        c += abs(sin(p.x + sin(p.y + t)) * sin(p.y + sin(p.x + t * 1.3)));\n        p *= 1.5;\n    }\n    return c / 3.0;\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-lava",
        title: "Lava",
        text: "GLSL ES 1 listing: Lava.",
        fields: {
          glsl: "vec3 lava(vec2 st, float time) {\n    float n = warpedFbm(st + vec2(time * 0.05));\n    vec3 cold = vec3(0.1, 0.0, 0.0);\n    vec3 hot = vec3(1.0, 0.3, 0.0);\n    vec3 bright = vec3(1.0, 0.9, 0.3);\n    return mix(cold, mix(hot, bright, n), smoothstep(0.3, 0.7, n));\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-grass-fur",
        title: "Grass/Fur",
        text: "GLSL ES 1 listing: Grass/Fur.",
        fields: {
          glsl: "float grass(vec2 st) {\n    float n = fbm(st * 20.0);\n    float blade = smoothstep(0.3, 0.5, n);\n    return blade * (0.8 + fbm(st * 5.0) * 0.2);\n}",
        },
        tags: ["glsl-listing"],
      },
      {
        id: "glsl-stone-rock",
        title: "Stone/Rock",
        text: "GLSL ES 1 listing: Stone/Rock.",
        fields: {
          glsl: "vec3 stone(vec2 st) {\n    float n1 = fbm(st * 4.0);\n    float n2 = fbm(st * 8.0 + 5.0) * 0.5;\n    float crack = smoothstep(0.48, 0.52, n1);\n    vec3 base = vec3(0.5 + n2 * 0.2);\n    return mix(base * 0.7, base, crack);\n}",
        },
        tags: ["glsl-listing"],
      },
    ],
  },
];
