import type { KnowledgePack } from "../knowledge-pack-schema.ts";
import { agentkitSource } from "../knowledge-sources.ts";
import { SHADER_GLSL_LISTINGS } from "./shader-gl-listings.ts";

const SHADER = "kits/engineer/skills/ak-shader";
const ref = (name: string) => agentkitSource(`${SHADER}/references/${name}.md`, "SH-01");
/** A reference whose GLSL listings are carried as published (the owner approved the derived content). */
const listing = (name: string, notice?: string) =>
  agentkitSource(`${SHADER}/references/${name}.md`, "SH-03", notice);

const SIMPLEX_NOTICE =
  "The 2D simplex noise listing is the webgl-noise implementation by Ian McEwan and Stefan Gustavson " +
  "(Ashima Arts), MIT License, Copyright (C) 2011 Ashima Arts.";
const HSV_NOTICE =
  "The hsb2rgb listing is the smooth HSV conversion by Inigo Quilez, whose algorithm code is published " +
  "under the MIT License.";

export const shaderGlPack: KnowledgePack = {
  id: "shader-gl",
  version: "1.1.0",
  title: "GL fragment shader craft",
  summary:
    "Fragment shader fundamentals, shaping curves, colour spaces, SDF shapes, patterns, noise, fBm and procedural textures.",
  purpose:
    "Give the GL film engine a working vocabulary for procedural sets and FX: how a fragment shader thinks per " +
    "pixel, how to shape values, draw and combine shapes with distance fields, repeat and warp space, and build " +
    "organic surfaces from noise. The `*-glsl` sections hold the source's GLSL ES 1 listings for each technique. " +
    "Every shader is proven by rendering it in the actual target, not by compiling it.",
  sources: [
    agentkitSource(`${SHADER}/SKILL.md`, "SH-01"),
    ref("glsl-fundamentals-data-types-vectors-precision-coordinates"),
    ref("glsl-shaping-functions-step-smoothstep-curves-interpolation"),
    ref("glsl-colors-rgb-hsb-gradients-mixing-color-spaces"),
    ref("glsl-shapes-sdf-circles-rectangles-polar-distance-fields"),
    ref("glsl-shapes-polygon-star-polar-sdf-combinations"),
    ref("glsl-patterns-tiling-fract-matrices-transformations"),
    ref("glsl-pattern-symmetry-truchet-domain-warping"),
    ref("glsl-noise-random-perlin-simplex-cellular-voronoi"),
    ref("glsl-cellular-voronoi-worley-noise-patterns"),
    ref("glsl-fbm-fractional-brownian-motion-turbulence-octaves"),
    ref("glsl-procedural-textures-clouds-marble-wood-terrain"),
    listing("glsl-fundamentals-data-types-vectors-precision-coordinates"),
    listing("glsl-shaping-functions-step-smoothstep-curves-interpolation"),
    listing("glsl-colors-rgb-hsb-gradients-mixing-color-spaces", HSV_NOTICE),
    listing("glsl-shapes-sdf-circles-rectangles-polar-distance-fields"),
    listing("glsl-shapes-polygon-star-polar-sdf-combinations"),
    listing("glsl-patterns-tiling-fract-matrices-transformations"),
    listing("glsl-pattern-symmetry-truchet-domain-warping"),
    listing("glsl-noise-random-perlin-simplex-cellular-voronoi", SIMPLEX_NOTICE),
    listing("glsl-cellular-voronoi-worley-noise-patterns"),
    listing("glsl-fbm-fractional-brownian-motion-turbulence-octaves"),
    listing("glsl-procedural-textures-clouds-marble-wood-terrain"),
  ],
  phases: ["design", "composition", "motion"],
  loadWhen: [
    "shader",
    "glsl",
    "fragment shader",
    "sdf",
    "distance field",
    "noise",
    "fbm",
    "voronoi",
    "procedural texture",
    "gradient",
    "pattern",
    "domain warp",
    "gl set",
    "gl fx",
  ],
  useCases: [
    "Building a procedural backdrop for a GL set (sky, clouds, marble wall, wood floor) without painted plates.",
    "Drawing crisp, resolution-independent graphic shapes (rings, polygons, stars) from distance fields and blending them smoothly.",
    "Animating an FX layer (fire, smoke, caustics, lava) by offsetting noise with the frame time uniform.",
    "Filling a surface with a repeating motif (tiles, bricks, hex cells, truchet mazes) and breaking its regularity with domain warping.",
    "Shifting the mood of a shot by moving hue, saturation and brightness in HSB space instead of hand-tuning RGB triples.",
  ],
  antiPatterns: [
    "Treating a clean compile as done: the shader was never rendered and inspected in the actual renderer and GLSL version.",
    "Driving animation from wall-clock time, so two renders of the same frame differ.",
    "Integer literals or integer division in float maths (`1/2` is 0), which fail or silently truncate.",
    "Hard `step` edges on shapes that alias and crawl in motion where a narrow `smoothstep` would anti-alias.",
    "Interpolating hue linearly in RGB and getting muddy midpoints instead of mixing in a space that suits the change.",
    "Raw `fract` tiling left perfectly regular, so the repetition reads as wallpaper.",
    "Stacking more fBm octaves than the output resolution can show, spending GPU time on invisible detail.",
    "Renaming or re-owning existing uniforms when adding an effect, breaking the host's uniform lifecycle.",
  ],
  sections: [
    {
      id: "fundamentals",
      title: "Fundamentals: execution, types, precision, coordinates",
      entries: [
        {
          id: "target-contract",
          title: "Inspect the target first",
          text:
            "Before writing, read the actual renderer, GLSL version, default precision and the names and types of the " +
            "uniforms it provides. ES 1-style output (`gl_FragColor`) and ES 3-style output (a declared `out` variable) " +
            "are not interchangeable. Load only the noise, SDF or colour techniques the effect needs, and keep existing " +
            "uniform ownership and lifecycle intact.",
        },
        {
          id: "per-pixel-execution",
          title: "One stateless thread per pixel",
          text:
            "A fragment shader runs the same program for every pixel in parallel. Each invocation knows its pixel " +
            "position and the uniforms, returns one RGBA colour with channels in 0..1, and cannot read what its " +
            "neighbours computed. Anything that looks like communication (blur, neighbourhood search) is recomputed " +
            "per pixel or done in an extra pass.",
        },
        {
          id: "normalised-coordinates",
          title: "Normalise pixel coordinates",
          text:
            "The fragment coordinate is in pixels with the origin at the bottom-left. Divide by the resolution uniform " +
            "to get `st` in 0..1 and write the rest of the shader in that space, so it is resolution independent. " +
            "Centre-relative work subtracts 0.5 first.",
        },
        {
          id: "standard-uniforms",
          title: "Standard uniforms",
          text:
            "Three uniforms cover most effects: elapsed time in seconds, canvas resolution in pixels, and a pointer " +
            "position in pixels. In a film render the time uniform must be derived from the frame number and fps, " +
            "never from a wall clock, so every frame is reproducible.",
          fields: { time: "float, seconds", resolution: "vec2, pixels", pointer: "vec2, pixels" },
        },
        {
          id: "types-and-swizzling",
          title: "Vector types and swizzling",
          text:
            "Scalars are `float`; `vec2`, `vec3` and `vec4` hold positions and colours; `mat2`..`mat4` hold transforms; " +
            "`sampler2D` is a texture. Components are read through `.xyzw`, `.rgba` or `.stpq` and may be reordered or " +
            "repeated (`.bgr`, `.rrrr`). Constructors broadcast a single value (`vec3(1.0)`) or concatenate smaller vectors.",
        },
        {
          id: "explicit-floats",
          title: "Write floats as floats",
          text:
            "GLSL does not promote integers implicitly in many targets: write `1.0`, not `1`, and cast with `float(i)` " +
            "or `int(x)`. Integer division truncates, so `1/2` is 0. Define constants such as PI and TWO_PI with the " +
            "preprocessor.",
        },
        {
          id: "precision",
          title: "Precision qualifiers",
          text:
            "On ES targets declare a default float precision. `lowp` is fastest and coarsest, `mediump` is the usual " +
            "balance, `highp` is needed for long time values, large coordinate scales and hash functions, which band or " +
            "repeat visibly at low precision.",
        },
      ],
    },
    {
      id: "shaping",
      title: "Shaping functions",
      entries: [
        {
          id: "step-smoothstep-mix",
          title: "step, smoothstep, mix",
          text:
            "`step(edge, x)` is a hard 0/1 threshold. `smoothstep(e0, e1, x)` clamps `t = (x - e0) / (e1 - e0)` to 0..1 " +
            "and returns the Hermite curve `t*t*(3 - 2t)`. `mix(a, b, t)` is `a*(1 - t) + b*t`. Together they turn any " +
            "scalar field into masks, gradients and blends.",
        },
        {
          id: "power-curves",
          title: "Power and exponential curves",
          text:
            "`pow(x, n)` with n > 1 starts slow and ends fast; with n < 1 it starts fast and ends slow. `sqrt`, `exp` " +
            "and `log` give other standard bends of a 0..1 ramp.",
        },
        {
          id: "periodic-signals",
          title: "Periodic signals",
          text:
            "Remap `sin` or `cos` from -1..1 to 0..1 with `* 0.5 + 0.5`. `fract(x)` is a sawtooth, `floor(x)` a staircase, " +
            "`abs(fract(x) * 2 - 1)` a triangle wave, and `abs(mod(x, 2) - 1)` a ping-pong. Feeding the time uniform " +
            "into these gives oscillation, looping and back-and-forth motion.",
        },
        {
          id: "custom-curves",
          title: "Custom shaping curves",
          text:
            "Quintic smootherstep `x^3 (x (6x - 15) + 10)` has zero first and second derivatives at the ends, so it " +
            "has no visible seams. An exponential impulse `h * exp(1 - h)` with `h = k x` rises fast and decays, good " +
            "for hits. A parabola `pow(4x(1 - x), k)` peaks in the middle. A cubic pulse centred at c with half-width w " +
            "is a smooth bump that is exactly zero outside the window.",
        },
        {
          id: "bands-and-soft-edges",
          title: "Bands and anti-aliased edges",
          text:
            "Subtracting two smoothsteps gives a soft band. For a shape edge, use a narrow smoothstep across the " +
            "boundary (radius plus and minus a small edge width) instead of `step`, so edges stay smooth when moving.",
        },
      ],
    },
    {
      id: "colour",
      title: "Colour and colour spaces",
      entries: [
        {
          id: "rgb-normalised",
          title: "Normalised RGB",
          text:
            "Colours are `vec3` or `vec4` with channels in 0..1. A hex or 8-bit value converts by dividing each byte " +
            "by 255, so `#FF6600` is `(1.0, 0.4, 0.0)`.",
        },
        {
          id: "blend-modes",
          title: "Blend operations",
          text:
            "`mix` interpolates, and a `vec3` weight mixes each channel separately. Multiplying darkens (multiply); " +
            "`1 - (1 - a)(1 - b)` lightens (screen); adding builds glow and needs clamping or tone handling later.",
        },
        {
          id: "gradients",
          title: "Linear, radial and multi-stop gradients",
          text:
            "Mix two colours by `st.x` or `st.y` for linear gradients, by distance from a centre for radial ones. A " +
            "multi-stop ramp splits t into segments and remaps each segment back to 0..1 before mixing its two stops.",
        },
        {
          id: "hsb",
          title: "HSB for intuitive colour control",
          text:
            "Hue, saturation and brightness separate the colour wheel from intensity, so hue cycles, desaturation and " +
            "dimming are single-parameter moves. Convert to RGB at the end. A colour wheel maps the polar angle " +
            "(atan, normalised by TWO_PI) to hue and the radius to saturation.",
        },
        {
          id: "animated-colour",
          title: "Animated colour",
          text:
            "Cycle hue with `fract(time * speed)`, pulse brightness with a remapped sine, or oscillate between two " +
            "colours by mixing with a remapped sine.",
        },
        {
          id: "colour-correction",
          title: "Gamma, contrast, saturation",
          text:
            "Gamma raises the colour to `1 / g`. Contrast scales around mid-grey: `(c - 0.5) * a + 0.5`. Saturation " +
            "mixes between the luma grey and the colour; luma uses the weights below.",
          fields: { lumaWeights: "0.299, 0.587, 0.114" },
        },
      ],
    },
    {
      id: "shapes-sdf",
      title: "Shapes and signed distance fields",
      entries: [
        {
          id: "sdf-sign",
          title: "Signed distance convention",
          text:
            "An SDF returns the distance from a point to the shape's edge: negative inside, zero on the edge, positive " +
            "outside. One field gives fill (d < 0), outline (|d| small), glow (falloff of d) and soft edges " +
            "(smoothstep across 0) without redrawing the shape.",
        },
        {
          id: "circle-sdf",
          title: "Circle",
          text: "`length(p - centre) - radius`. A hard mask is `1 - step(radius, distance)`; prefer the SDF with a smoothstep edge.",
        },
        {
          id: "box-sdf",
          title: "Box and rounded box",
          text:
            "Take `q = abs(p - centre) - halfSize`; the distance is `length(max(q, 0)) + min(max(q.x, q.y), 0)`, exact " +
            "inside and out. A rounded box shrinks the half size by the corner radius and subtracts the radius from the result.",
        },
        {
          id: "segment-sdf",
          title: "Line segment",
          text:
            "Project the point onto the segment with `h = clamp(dot(pa, ba) / dot(ba, ba), 0, 1)` and measure " +
            "`length(pa - ba * h)`. Thickness comes from a smoothstep on that distance.",
        },
        {
          id: "outline-and-fill",
          title: "Outline and fill from one field",
          text:
            "An outline is a smoothstep on `abs(d)`. Fill-with-stroke uses one mask for d < 0 and a second for the " +
            "band around 0, mixing the stroke colour only outside the fill.",
        },
        {
          id: "polygon-and-star",
          title: "Regular polygon and star",
          text:
            "Convert to polar, snap the angle to the nearest of N sector centres and take `cos(sectorAngle - angle) * r`; " +
            "this gives an N-sided polygon distance. A star folds the angle into one sector with `mod` and switches " +
            "between outer and inner radius across the sector's centre line.",
        },
        {
          id: "polar-shapes",
          title: "Polar shapes",
          text:
            "With radius r and angle a about the centre, a shape is `r - f(a)`. `f = base + amp * cos(n a)` makes an " +
            "n-petal flower; switching between two radii on `fract(a * n / TWO_PI)` makes a gear; a rational function " +
            "of |a| makes a heart.",
        },
        {
          id: "sdf-booleans",
          title: "Boolean combinations",
          text:
            "Union is `min(d1, d2)`, intersection `max(d1, d2)`, subtraction `max(d1, -d2)`, and XOR " +
            "`max(min(d1, d2), -max(d1, d2))`.",
        },
        {
          id: "smooth-booleans",
          title: "Smooth booleans",
          text:
            "A smooth union blends the two distances with a clamped weight `h` derived from their difference over a " +
            "radius k and subtracts `k h (1 - h)`, so shapes melt together over width k. Smooth subtraction and " +
            "intersection use the same construction with signs flipped.",
        },
        {
          id: "sdf-modifiers",
          title: "Ring and rounding",
          text: "`abs(d) - thickness` hollows any shape into a ring; `d - r` rounds and grows it by r.",
        },
        {
          id: "transform-the-point",
          title: "Transform the point, not the shape",
          text:
            "To rotate or scale a shape, move the sample point the opposite way: subtract the centre, apply the " +
            "inverse rotation or divide by the scale, add the centre back, then evaluate the SDF. Dividing by a scale " +
            "also scales the distance, so correct it when exact distances matter.",
        },
      ],
    },
    {
      id: "patterns",
      title: "Patterns, tiling and matrices",
      entries: [
        {
          id: "fract-tiling",
          title: "Tile with fract and index with floor",
          text:
            "Scale space by n and take `fract` for the position inside a cell and `floor` for the cell index. The " +
            "index seeds per-cell variation (colour, rotation, which motif).",
        },
        {
          id: "brick-offset",
          title: "Offset rows",
          text: "Shift x by half a cell on odd rows (`mod(row, 2) * 0.5`) before `fract` to get a brick bond.",
        },
        {
          id: "hex-grid",
          title: "Hex grid",
          text:
            "Use two rectangular lattices with aspect 1 : sqrt(3), the second offset by half a cell, and keep whichever " +
            "cell centre is nearer. The result is the local offset inside a hexagonal cell.",
        },
        {
          id: "rotation-scale-matrices",
          title: "Rotation and scale matrices",
          text:
            "A 2D rotation is `mat2(c, -s, s, c)` from cos and sin of the angle; a scale is a diagonal matrix. To rotate " +
            "or scale about a centre, translate to the origin, multiply, translate back.",
        },
        {
          id: "checker-and-stripes",
          title: "Checkerboard and stripes",
          text:
            "A checkerboard is `mod(ix + iy, 2)` of the cell index. Stripes are `step(0.5, fract(y * n))`; rotate the " +
            "coordinates first for diagonal stripes.",
        },
        {
          id: "polar-repeat-and-spiral",
          title: "Radial repeat and spiral",
          text:
            "In polar coordinates, `fract(angle * n / TWO_PI)` repeats a motif n times around the centre. Combining " +
            "radius and angle, `fract(r - angle * turns / TWO_PI)`, gives a spiral.",
        },
      ],
    },
    {
      id: "symmetry-truchet-warping",
      title: "Symmetry, truchet tiles and domain warping",
      entries: [
        {
          id: "mirror-and-kaleidoscope",
          title: "Mirror and kaleidoscope",
          text:
            "`abs(st.x - 0.5) + 0.5` mirrors across the vertical centre line; applying `abs` to both centred axes gives " +
            "four-fold kaleidoscope symmetry.",
        },
        {
          id: "radial-symmetry",
          title: "N-fold radial symmetry",
          text:
            "Fold the polar angle into one sector with `mod(angle, TWO_PI / n)` and rebuild the point from that angle " +
            "and the original radius. Whatever is drawn in one sector repeats n times, as in a snowflake.",
        },
        {
          id: "truchet",
          title: "Truchet tiles",
          text:
            "Give each cell a random value from its index and pick one of four 90-degree orientations (or a flip) from " +
            "it. Draw a motif that connects at cell edges, such as two quarter-circle arcs from opposite corners or a " +
            "diagonal line, and the random orientations join into continuous meanders or mazes.",
        },
        {
          id: "domain-warp",
          title: "Domain warping",
          text:
            "Offset the sample coordinates before evaluating a pattern: add a small sine of the other axis for a wavy " +
            "distortion, add time to the phase to animate it. Iterating, with noise of the current point added back each " +
            "time, turns regular patterns into organic flow.",
        },
      ],
    },
    {
      id: "noise",
      title: "Random and noise",
      entries: [
        {
          id: "hash-random",
          title: "Hash pseudo-random",
          text:
            "A stateless hash maps coordinates to 0..1: `fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453)`. A " +
            "vec2 variant takes two different dot products. It is deterministic per input, needs `highp` to avoid " +
            "visible repetition, and is the seed for every noise below.",
        },
        {
          id: "value-noise",
          title: "Value noise",
          text:
            "Hash the four corners of the integer cell and interpolate them with the Hermite fade `f*f*(3 - 2f)` on the " +
            "fractional position. Cheap, but its grid alignment shows as blocky features.",
        },
        {
          id: "gradient-noise",
          title: "Gradient (Perlin-style) noise",
          text:
            "Hash a random unit gradient at each corner, dot it with the offset from that corner, and interpolate the " +
            "four results with the quintic fade so first and second derivatives are continuous. Features no longer sit " +
            "on the grid points, so it looks smoother and less blocky than value noise.",
        },
        {
          id: "simplex-noise",
          title: "Simplex noise",
          text:
            "Skew space onto a triangular grid, sum radially falling-off contributions from the three corners of the " +
            "containing simplex, and unskew. Fewer corners per sample and fewer axis-aligned artefacts than gradient " +
            "noise; use a vetted implementation rather than retyping the constants.",
        },
        {
          id: "cellular-noise",
          title: "Cellular noise",
          text:
            "Place one jittered feature point per cell (hash of the cell index). For each pixel, search its own and the " +
            "eight neighbouring cells and keep the distance to the nearest point. That 3x3 search is enough when " +
            "points stay inside their cells.",
        },
        {
          id: "voronoi-cell-id",
          title: "Voronoi with cell identity",
          text:
            "Track which feature point was nearest as well as the distance. Hashing that point gives a stable id per " +
            "cell for flat-shaded colours, per-cell variation or masks.",
        },
        {
          id: "worley-f1-f2",
          title: "Worley F1 and F2",
          text:
            "Keep the nearest (F1) and second-nearest (F2) distances. F1 gives round cells, `F2 - F1` gives thin cell " +
            "borders (cracks, cell walls), and `F1 * F2` gives blobs.",
        },
        {
          id: "distance-metrics",
          title: "Distance metrics",
          text: "Euclidean distance gives round cells, Manhattan `|x| + |y|` diamond cells, Chebyshev `max(|x|, |y|)` square cells.",
        },
        {
          id: "animated-noise",
          title: "Animating noise",
          text:
            "Translate the sample point by time for drifting noise, or by sine and cosine of time for swirling. For " +
            "cellular noise, move each feature point on its own phase, `0.5 + 0.5 * sin(time + TWO_PI * point)`, so cells " +
            "breathe without leaving their neighbourhood.",
        },
      ],
    },
    {
      id: "fbm-turbulence",
      title: "fBm and turbulence",
      entries: [
        {
          id: "fbm",
          title: "Fractional Brownian motion",
          text:
            "Sum several octaves of noise, multiplying frequency by the lacunarity and amplitude by the gain each " +
            "octave. Large octaves set the form, small ones add detail, giving the self-similar look of clouds and terrain.",
          fields: { octaves: "4-8 typical", lacunarity: "2.0 typical", gain: "0.5 typical" },
        },
        {
          id: "turbulence",
          title: "Turbulence",
          text:
            "Remap each octave to -1..1 and take its absolute value before summing. The folds create sharp creases, " +
            "good for fire, smoke and veining.",
        },
        {
          id: "ridged",
          title: "Ridged noise",
          text:
            "Invert turbulence (`1 - |n|`), square it to sharpen the ridges, and weight each octave by the previous " +
            "one so detail gathers on the ridges. Use it for mountain crests.",
        },
        {
          id: "warped-fbm",
          title: "Warped fBm",
          text:
            "Feed fBm into its own coordinates: compute a vector q from two fBm samples at offset positions, a second " +
            "vector r from fBm at `p + 4q`, then sample fBm at `p + 4r`. The result is marbled, flowing structure.",
        },
        {
          id: "animated-fbm",
          title: "Animated fBm",
          text:
            "Offset each octave by time at a rate that grows with the octave index, so fine detail moves faster than " +
            "the large forms, as in real smoke.",
        },
        {
          id: "multifractal",
          title: "Multifractal",
          text:
            "Multiply octaves (each `noise * frequency^-H + 1`) instead of adding them. Roughness then varies across " +
            "the surface: calm in some regions, rugged in others.",
        },
      ],
    },
    {
      id: "procedural-textures",
      title: "Procedural textures",
      entries: [
        {
          id: "clouds",
          title: "Clouds",
          text:
            "Drift fBm slowly with time, tighten it with a smoothstep around the middle of its range, and mix sky " +
            "colour to white by the result.",
        },
        {
          id: "marble",
          title: "Marble",
          text: "Perturb the phase of a sine stripe with scaled fBm and remap to 0..1; mix a dark vein colour to a light base.",
        },
        {
          id: "wood",
          title: "Wood grain",
          text:
            "Offset one coordinate by low-frequency fBm and run it through a high-frequency sine for rings, then mix " +
            "two browns by the result.",
        },
        {
          id: "terrain",
          title: "Terrain height and colour bands",
          text:
            "Add ridged noise to fBm for height. Colour by height bands (water, sand, grass, rock, snow), remapping " +
            "height to 0..1 inside each band before mixing its two colours so the bands blend.",
        },
        {
          id: "fire-and-smoke",
          title: "Fire and smoke",
          text:
            "Scroll the coordinates upward with time, sample turbulence for fire or fBm for smoke, and fade out " +
            "towards the top with a smoothstep on height. Fire maps intensity from red to yellow; smoke stays grey and dim.",
        },
        {
          id: "caustics",
          title: "Water caustics",
          text:
            "Sum a few layers of nested sines of x and y (each sine inside another, phases advancing with time at " +
            "slightly different rates), scaling space up each layer and averaging, for bright interference lines.",
        },
        {
          id: "lava",
          title: "Lava",
          text:
            "Slowly drift warped fBm and map it through three colours (cold dark, hot, bright), using a smoothstep to " +
            "decide where the crust gives way to glow.",
        },
        {
          id: "grass-stone-cracks",
          title: "Grass, stone and cracked ground",
          text:
            "High-frequency fBm through a smoothstep reads as blades or fur. Two fBm scales, one thresholded for " +
            "cracks and one for tone, read as stone. Worley `F2 - F1` edges through a narrow smoothstep read as cracked " +
            "ground.",
        },
      ],
    },
    ...SHADER_GLSL_LISTINGS,
  ],
  checks: [
    {
      id: "shader-gl.compiles-in-target",
      kind: "hard",
      level: "asset",
      measure:
        "Compile and link errors when the shader is built in the actual target renderer and GLSL version.",
      metric: { id: "shader-compile-errors", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "shader-gl.rendered-in-target",
      kind: "evidence",
      level: "asset",
      measure: "Frames rendered by the shader in the actual target, across the time range it animates over.",
      judges: ["ai", "human"],
      evidence: ["frame-strip"],
      pass: "The rendered output matches the brief; syntax-only or compile-only validation does not pass.",
    },
    {
      id: "shader-gl.performance-against-brief",
      kind: "evidence",
      level: "asset",
      measure: "Frame cost of the shader measured in the target at the delivery resolution.",
      judges: ["ai", "human"],
      evidence: ["measurement"],
      pass: "The measured cost fits the performance budget stated in the brief.",
    },
    {
      id: "shader-gl.uniform-contract",
      kind: "evidence",
      level: "asset",
      measure: "Uniform names, types, ownership and lifecycle before and after the change.",
      judges: ["ai", "human"],
      evidence: ["document"],
      pass: "Existing uniforms keep their names, types and owner; any change is required by the brief.",
    },
  ],
};
