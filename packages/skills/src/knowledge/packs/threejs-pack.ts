import type { KnowledgeEntry, KnowledgePack } from "../knowledge-pack-schema.ts";
import { agentkitSource } from "../knowledge-sources.ts";
import { THREEJS_EXAMPLE_SECTIONS } from "./threejs-examples.ts";

const SKILL = "kits/engineer/skills/ak-threejs";
const source = (path: string) => agentkitSource(`${SKILL}/${path}`, "TJ-02");

/** One row of the API reference table: a class, what it is for, its common members and its neighbours. */
function api(
  id: string,
  cls: string,
  category: string,
  text: string,
  methods: string,
  related: string,
  tags: string[],
): KnowledgeEntry {
  return {
    id,
    title: cls,
    text,
    fields: { category, class: cls, commonMethods: methods, relatedClasses: related },
    tags,
  };
}

/** One row of the example category table. */
function category(
  id: string,
  title: string,
  text: string,
  complexity: string,
  exampleCount: string,
  primaryUseCases: string,
  related: string,
  tags: string[],
): KnowledgeEntry {
  return {
    id,
    title,
    text,
    fields: { complexity, exampleCount, primaryUseCases, relatedCategories: related },
    tags,
  };
}

/** One row of the project use-case table: what to build it with and which upstream examples to study. */
function useCase(
  id: string,
  title: string,
  text: string,
  complexity: string,
  technologies: string,
  examples: string,
  tags: string[],
): KnowledgeEntry {
  return { id, title, text, fields: { complexity, technologies, recommendedExamples: examples }, tags };
}

export const threejsPack: KnowledgePack = {
  id: "threejs",
  version: "1.1.0",
  title: "Three.js real-time 3D",
  summary:
    "Scenes, cameras, lights, PBR materials, glTF loading, animation, post-processing, TSL/WebGPU, shaders, XR.",
  purpose:
    "Build and review real-time 3D scenes rendered with Three.js: pick the right class for the job, set up colour, " +
    "light and camera correctly, keep the frame budget and release GPU memory. The source does not pin a Three.js " +
    "version; it relies on the r152 colour-management API but mixes idioms from older and newer releases, so read " +
    "the installed version and renderer before applying any recipe here. The `examples-*` sections index the " +
    "upstream three.js examples by category, as working references to study.",
  sources: [
    source("SKILL.md"),
    source("data/api-reference.csv"),
    source("data/categories.csv"),
    source("data/use-cases.csv"),
    source("references/00-fundamentals.md"),
    source("references/01-getting-started.md"),
    source("references/02-loaders.md"),
    source("references/03-textures.md"),
    source("references/04-cameras.md"),
    source("references/05-lights.md"),
    source("references/06-animations.md"),
    source("references/07-math.md"),
    source("references/08-interaction.md"),
    source("references/09-postprocessing.md"),
    source("references/10-controls.md"),
    source("references/11-materials.md"),
    source("references/11-materials-advanced.md"),
    source("references/12-performance.md"),
    source("references/13-node-materials.md"),
    source("references/14-physics-vr.md"),
    source("references/15-specialized-loaders.md"),
    source("references/16-webgpu.md"),
    source("references/17-shader.md"),
    source("references/18-geometry.md"),
    agentkitSource(
      `${SKILL}/data/examples-all.csv`,
      "TJ-03",
      "Index of the three.js examples (names and file names); three.js is MIT License, Copyright three.js authors.",
    ),
  ],
  phases: ["design", "motion", "composition", "qa"],
  loadWhen: [
    "three.js",
    "threejs",
    "3d",
    "webgl",
    "webgpu",
    "gltf",
    "glb",
    "shader",
    "glsl",
    "tsl",
    "pbr",
    "particles",
    "postprocessing",
    "webxr",
    "3d scene",
  ],
  useCases: [
    "A product configurator: a glTF model with PBR materials, an HDR environment and orbit controls.",
    "A data visualisation with thousands of points or instances drawn in a handful of draw calls.",
    "A 3D shot rendered in the browser: camera path, animated clips, bloom and tone mapping, then captured.",
    "A custom look (rim light, dissolve, procedural pattern) written as a GLSL shader or a TSL node material.",
    "A 360 panorama or VR/AR scene driven by the WebXR session loop.",
    "Reviewing a scene for frame budget, colour handling and resource cleanup before it ships.",
  ],
  antiPatterns: [
    "Copying a recipe without checking the installed Three.js version and renderer; WebGL, WebGPU and TSL APIs are not interchangeable.",
    "Using the raw device pixel ratio on high-density screens instead of capping it, which multiplies the fill cost.",
    "Removing objects from the scene and assuming GPU memory is freed; geometry, materials, textures and render targets need dispose().",
    "Leaving colour textures in linear space (or data maps in sRGB), so the picture looks washed out or too dark.",
    "Rendering with renderer.render after building an EffectComposer, or omitting the final OutputPass.",
    "Creating one Mesh per copy for thousands of identical objects instead of an InstancedMesh.",
    "Changing fov, aspect or near/far without calling updateProjectionMatrix, so the image stretches.",
    "Enabling damping or auto-rotate on OrbitControls but never calling controls.update() in the loop.",
    "Turning on shadows for every light and object with a loose shadow camera, giving blurry shadows at high cost.",
    "Driving XR or WebGPU rendering with requestAnimationFrame instead of renderer.setAnimationLoop.",
  ],
  sections: [
    {
      id: "compatibility",
      title: "Version and compatibility",
      entries: [
        {
          id: "three-version",
          title: "Three.js version targeted by this pack",
          text:
            "Version not stated by the source. It uses outputColorSpace and texture colorSpace, introduced in r152, " +
            "so r152 is the implied floor, but it also shows older idioms (a uv2 attribute for aoMap, " +
            "physicallyCorrectLights, TextGeometry height) next to newer node-material and WebGPU code. Treat every " +
            "import path and property as something to confirm against the installed release.",
          fields: { threeVersion: "not stated by the source (r152 or later implied)" },
          tags: ["version", "compatibility"],
        },
        {
          id: "renderer-families",
          title: "WebGL, WebGPU and TSL are separate surfaces",
          text:
            "Pick the renderer before the recipe. GLSL ShaderMaterial and onBeforeCompile work with WebGLRenderer; " +
            "node materials and compute target WebGPURenderer. Verify add-on import paths and browser capabilities " +
            "for the chosen version and give unsupported devices the product's fallback.",
          tags: ["webgl", "webgpu", "tsl"],
        },
        {
          id: "definition-of-done",
          title: "Done means rendered, interactive and cleaned up",
          text:
            "Check the actual render and interaction, not just that the code runs. On teardown cancel the animation " +
            "loop, remove listeners and dispose owned geometry, materials, textures and render targets. Measure " +
            "frame time or memory whenever performance is part of the outcome.",
          tags: ["qa", "dispose"],
        },
      ],
    },
    {
      id: "api",
      title: "API reference",
      // biome-ignore format: one row per line, mirroring the source table
      entries: [
        api("scene", "Scene", "Core", "Root container of the scene graph: objects, lights and cameras hang off it.", "add(), remove(), traverse(), getObjectByName()", "Object3D; Group", ["scene", "container", "root", "hierarchy"]),
        api("camera", "Camera", "Core", "Base class every camera type extends.", "lookAt(), updateProjectionMatrix()", "PerspectiveCamera; OrthographicCamera", ["camera", "view", "projection"]),
        api("perspective-camera", "PerspectiveCamera", "Core", "Camera with perspective projection, the default choice.", "setFocalLength(), updateProjectionMatrix()", "Camera; OrthographicCamera", ["perspective", "fov", "aspect", "near", "far"]),
        api("orthographic-camera", "OrthographicCamera", "Core", "Camera with parallel projection, for 2D, isometric and CAD views.", "updateProjectionMatrix(), zoom", "Camera; PerspectiveCamera", ["orthographic", "2d", "isometric", "parallel"]),
        api("webgl-renderer", "WebGLRenderer", "Core", "Draws the scene with WebGL into a canvas.", "render(), setSize(), setPixelRatio(), dispose()", "Scene; Camera", ["renderer", "webgl", "canvas", "draw"]),
        api("webgpu-renderer", "WebGPURenderer", "Core", "Draws the scene with WebGPU and runs compute work.", "render(), setSize(), compute()", "WebGLRenderer; Scene", ["renderer", "webgpu", "modern", "compute"]),
        api("buffer-geometry", "BufferGeometry", "Geometry", "Geometry stored as typed-array attributes, the base of every geometry.", "setAttribute(), setIndex(), computeVertexNormals()", "Mesh; BufferAttribute", ["geometry", "vertices", "faces", "mesh"]),
        api("box-geometry", "BoxGeometry", "Geometry", "Box or cube primitive.", "parameters: width, height, depth, segments", "BufferGeometry; SphereGeometry", ["box", "cube", "rectangular"]),
        api("sphere-geometry", "SphereGeometry", "Geometry", "Sphere primitive.", "parameters: radius, widthSegments, heightSegments", "BufferGeometry; BoxGeometry", ["sphere", "ball", "globe"]),
        api("plane-geometry", "PlaneGeometry", "Geometry", "Flat rectangle primitive, for grounds and screens.", "parameters: width, height, widthSegments", "BufferGeometry; CircleGeometry", ["plane", "flat", "ground", "floor"]),
        api("cylinder-geometry", "CylinderGeometry", "Geometry", "Cylinder primitive; a zero top radius makes a cone.", "parameters: radiusTop, radiusBottom, height", "BufferGeometry; ConeGeometry", ["cylinder", "tube", "pillar"]),
        api("torus-geometry", "TorusGeometry", "Geometry", "Ring-shaped (doughnut) primitive.", "parameters: radius, tube, radialSegments", "BufferGeometry; TorusKnotGeometry", ["torus", "donut", "ring"]),
        api("material", "Material", "Material", "Base class of all materials.", "dispose(), clone(), needsUpdate", "MeshStandardMaterial; ShaderMaterial", ["material", "appearance", "surface"]),
        api("mesh-standard-material", "MeshStandardMaterial", "Material", "Metallic-roughness PBR material; the default for realistic surfaces.", "color, metalness, roughness, map, normalMap", "Material; MeshPhysicalMaterial", ["standard", "pbr", "metalness", "roughness"]),
        api("mesh-physical-material", "MeshPhysicalMaterial", "Material", "PBR material with extra layers: transmission, clearcoat, sheen.", "transmission, thickness, clearcoat, sheen, ior", "MeshStandardMaterial; Material", ["physical", "transmission", "clearcoat", "sheen"]),
        api("mesh-basic-material", "MeshBasicMaterial", "Material", "Unlit material: flat colour or texture, ignores lights.", "color, map, wireframe, transparent", "Material; MeshLambertMaterial", ["basic", "unlit", "simple", "fast"]),
        api("mesh-lambert-material", "MeshLambertMaterial", "Material", "Cheap diffuse-only lit material, no highlights.", "color, map, emissive, reflectivity", "Material; MeshPhongMaterial", ["lambert", "diffuse", "non-shiny"]),
        api("mesh-phong-material", "MeshPhongMaterial", "Material", "Lit material with specular highlights.", "color, specular, shininess, map", "Material; MeshStandardMaterial", ["phong", "specular", "shiny", "highlight"]),
        api("mesh-toon-material", "MeshToonMaterial", "Material", "Cel-shaded material with banded lighting.", "color, gradientMap, map", "Material; MeshLambertMaterial", ["toon", "cartoon", "cel", "stylized"]),
        api("shader-material", "ShaderMaterial", "Material", "Material with your own GLSL vertex and fragment shaders.", "vertexShader, fragmentShader, uniforms", "Material; RawShaderMaterial", ["shader", "custom", "glsl", "vertex", "fragment"]),
        api("points-material", "PointsMaterial", "Material", "Material for point clouds and particles.", "color, size, sizeAttenuation, map", "Material; SpriteMaterial", ["points", "particles", "sprites"]),
        api("light", "Light", "Light", "Base class of all lights.", "color, intensity", "DirectionalLight; PointLight", ["light", "illumination", "source"]),
        api("directional-light", "DirectionalLight", "Light", "Parallel rays from far away, like the sun; can cast shadows.", "position, target, shadow, castShadow", "Light; SpotLight", ["directional", "sun", "parallel", "shadow"]),
        api("point-light", "PointLight", "Light", "Light radiating in all directions from a point, like a bulb.", "position, distance, decay, shadow", "Light; SpotLight", ["point", "bulb", "omnidirectional"]),
        api("spot-light", "SpotLight", "Light", "Cone of light with a soft edge.", "position, target, angle, penumbra, shadow", "Light; DirectionalLight", ["spotlight", "cone", "focused", "shadow"]),
        api("ambient-light", "AmbientLight", "Light", "Uniform fill light on every surface, no direction.", "color, intensity", "Light; HemisphereLight", ["ambient", "fill", "global"]),
        api("hemisphere-light", "HemisphereLight", "Light", "Sky-to-ground colour gradient fill, good outdoors.", "skyColor, groundColor, intensity", "Light; AmbientLight", ["hemisphere", "sky", "ground", "outdoor"]),
        api("rect-area-light", "RectAreaLight", "Light", "Soft light emitted from a rectangle, studio style.", "width, height, intensity, lookAt()", "Light; SpotLight", ["rectarea", "area", "soft", "studio"]),
        api("mesh", "Mesh", "Object", "Renderable object pairing a geometry with a material.", "geometry, material, position, rotation, scale", "Object3D; SkinnedMesh", ["mesh", "geometry", "material", "object"]),
        api("skinned-mesh", "SkinnedMesh", "Object", "Mesh deformed by a skeleton of bones.", "skeleton, bind(), pose()", "Mesh; Bone", ["skinned", "rigged", "animation", "bones"]),
        api("instanced-mesh", "InstancedMesh", "Object", "Draws many copies of one geometry and material in a single call.", "count, setMatrixAt(), setColorAt()", "Mesh; BatchedMesh", ["instanced", "performance", "many", "clone"]),
        api("group", "Group", "Object", "Empty node to transform several objects together.", "add(), remove(), children", "Object3D; Scene", ["group", "container", "parent", "hierarchy"]),
        api("points", "Points", "Object", "Renders every vertex as a point.", "geometry, material", "Mesh; Line", ["points", "particles", "cloud"]),
        api("line", "Line", "Object", "Renders vertices as a connected line.", "geometry, material", "Points; LineSegments", ["line", "path", "wire"]),
        api("sprite", "Sprite", "Object", "Plane that always faces the camera (billboard).", "material, center, scale", "Points; Mesh", ["sprite", "billboard", "always-facing"]),
        api("animation-mixer", "AnimationMixer", "Animation", "Plays animation clips on one object hierarchy.", "clipAction(), update(), stopAllAction()", "AnimationClip; AnimationAction", ["mixer", "animation", "playback", "control"]),
        api("animation-clip", "AnimationClip", "Animation", "Named set of keyframe tracks with a duration.", "tracks, duration, resetDuration()", "AnimationMixer; KeyframeTrack", ["clip", "keyframes", "track", "animation data"]),
        api("animation-action", "AnimationAction", "Animation", "Playback state of one clip: play, loop, fade, weight.", "play(), stop(), crossFadeTo(), setEffectiveWeight()", "AnimationMixer; AnimationClip", ["action", "play", "pause", "loop"]),
        api("gltf-loader", "GLTFLoader", "Loader", "Loads glTF and GLB models with materials, skins and animations.", "load(), parse(), setDRACOLoader()", "Loader; DRACOLoader", ["gltf", "glb", "loader", "model"]),
        api("fbx-loader", "FBXLoader", "Loader", "Loads FBX models, often used for animated characters.", "load(), parse()", "Loader; GLTFLoader", ["fbx", "animation"]),
        api("obj-loader", "OBJLoader", "Loader", "Loads plain OBJ geometry, optionally with an MTL material library.", "load(), parse(), setMaterials()", "Loader; MTLLoader", ["obj", "wavefront", "simple"]),
        api("texture-loader", "TextureLoader", "Loader", "Loads an image into a Texture.", "load(), loadAsync()", "Loader; CubeTextureLoader", ["texture", "image", "map"]),
        api("draco-loader", "DRACOLoader", "Loader", "Decodes Draco-compressed mesh data for GLTFLoader.", "setDecoderPath(), preload()", "GLTFLoader; Loader", ["draco", "compression", "mesh"]),
        api("orbit-controls", "OrbitControls", "Control", "Orbit, zoom and pan the camera around a target.", "update(), target, enableDamping", "Controls; TrackballControls", ["orbit", "rotate", "zoom", "pan", "camera"]),
        api("map-controls", "MapControls", "Control", "Top-down map navigation; pans with the primary button.", "update(), target, screenSpacePanning", "OrbitControls; Controls", ["map", "overhead", "2d", "navigation"]),
        api("first-person-controls", "FirstPersonControls", "Control", "Walk-and-look camera movement.", "update(), movementSpeed, lookSpeed", "Controls; PointerLockControls", ["fps", "first person", "walk"]),
        api("transform-controls", "TransformControls", "Control", "On-screen gizmo to move, rotate and scale an object.", "attach(), detach(), setMode()", "Controls; DragControls", ["transform", "gizmo", "move", "rotate", "scale"]),
        api("vector3", "Vector3", "Math", "3D vector for positions, directions and scales.", "add(), sub(), multiply(), normalize(), length()", "Vector2; Quaternion", ["vector", "position", "direction", "xyz"]),
        api("quaternion", "Quaternion", "Math", "Rotation without gimbal lock; interpolates smoothly.", "setFromEuler(), slerp(), multiply()", "Vector3; Euler", ["quaternion", "rotation", "orientation"]),
        api("matrix4", "Matrix4", "Math", "4x4 transform matrix.", "multiply(), invert(), decompose()", "Matrix3; Vector3", ["matrix", "transform", "4x4"]),
        api("box3", "Box3", "Math", "Axis-aligned bounding box for bounds and overlap tests.", "setFromObject(), containsPoint(), intersectsBox()", "Sphere; Raycaster", ["box", "aabb", "bounds", "collision"]),
        api("raycaster", "Raycaster", "Math", "Casts a ray and returns the objects it hits, for picking.", "setFromCamera(), intersectObjects()", "Box3; Vector3", ["raycast", "pick", "intersect", "mouse"]),
        api("axes-helper", "AxesHelper", "Helper", "Draws the X, Y and Z axes for orientation while debugging.", "size parameter", "Helper; GridHelper", ["axes", "xyz", "debug", "orientation"]),
        api("grid-helper", "GridHelper", "Helper", "Draws a reference grid on the ground plane.", "size, divisions, colors", "Helper; AxesHelper", ["grid", "floor", "debug", "reference"]),
        api("box-helper", "BoxHelper", "Helper", "Draws an object's bounding box as wireframe.", "setFromObject(), update()", "Helper; Box3Helper", ["box", "bounds", "debug", "wireframe"]),
        api("effect-composer", "EffectComposer", "Effect", "Runs a chain of post-processing passes.", "addPass(), render(), setSize()", "Pass; ShaderPass", ["composer", "postprocessing", "chain"]),
        api("render-pass", "RenderPass", "Effect", "First pass of a chain: renders the scene into the composer.", "scene, camera", "Pass; EffectComposer", ["render", "scene", "camera", "base"]),
        api("unreal-bloom-pass", "UnrealBloomPass", "Effect", "Bloom glow around bright and emissive areas.", "strength, radius, threshold", "Pass; EffectComposer", ["bloom", "glow", "emissive", "hdr"]),
        api("ssao-pass", "SSAOPass", "Effect", "Screen-space ambient occlusion: contact darkening in creases.", "kernelRadius, minDistance, maxDistance", "Pass; GTAOPass", ["ssao", "ao", "ambient occlusion"]),
        api("outline-pass", "OutlinePass", "Effect", "Draws outlines around selected objects.", "selectedObjects, visibleEdgeColor", "Pass; EffectComposer", ["outline", "selection", "highlight"]),
      ],
    },
    {
      id: "categories",
      title: "Example categories",
      // biome-ignore format: one row per line, mirroring the source table
      entries: [
        category("category-webgl", "webgl", "Standard WebGL rendering with the core feature set.", "Low-High", "216", "games, visualization, interactive", "webgl / postprocessing; webgl / advanced", ["webgl", "rendering", "standard", "basic"]),
        category("category-webgl-postprocessing", "webgl / postprocessing", "Post-processing effects and image manipulation.", "Medium-High", "27", "cinematic, stylized, photo-realistic", "webgl; webgl / advanced", ["postprocessing", "effects", "bloom", "ao", "fxaa"]),
        category("category-webgl-advanced", "webgl / advanced", "Low-level GPU access and advanced rendering techniques.", "High", "48", "optimization, custom rendering, research", "webgl; webgpu", ["advanced", "buffergeometry", "custom", "shader", "gpu"]),
        category("category-webgpu", "webgpu (wip)", "WebGPU rendering and compute shaders; still marked work in progress upstream.", "Medium-High", "190", "future-proof, compute, modern browsers", "webgl / advanced", ["webgpu", "compute", "modern", "next-gen", "tsl"]),
        category("category-webaudio", "webaudio", "Spatial audio and sound visualisation.", "Medium", "4", "games, immersive, vr", "webxr", ["audio", "spatial", "3d sound", "positional"]),
        category("category-webxr", "webxr", "Virtual and augmented reality experiences.", "Medium-High", "26", "vr games, ar apps, immersive", "webaudio; webgpu", ["vr", "ar", "xr", "immersive", "headset"]),
        category("category-games", "games", "Game-like examples and mechanics.", "Medium-High", "1", "game development, interactive", "webxr; physics", ["games", "gameplay", "interactive"]),
        category("category-physics", "physics", "Rigid-body simulation and collision.", "High", "13", "games, simulation, realistic", "games; webgpu", ["physics", "simulation", "rigid body", "collision"]),
        category("category-misc", "misc", "Experiments and special techniques.", "Varies", "20", "experimentation, learning", "All", ["misc", "experiments", "special"]),
        category("category-css2d", "css2d", "HTML labels overlaid on a 3D scene.", "Low", "1", "ui, labels, annotations", "css3d", ["css2d", "labels", "html overlay"]),
        category("category-css3d", "css3d", "DOM elements placed with CSS 3D transforms.", "Medium", "6", "ui, transitions, websites", "css2d", ["css3d", "dom", "html", "3d transform"]),
        category("category-svg", "svg", "SVG output and vector graphics.", "Low-Medium", "2", "icons, diagrams, 2d graphics", "css2d", ["svg", "vector", "2d"]),
        category("category-tests", "tests", "Testing and debugging utilities.", "Low-Medium", "2", "development, debugging", "All", ["tests", "debug", "development"]),
      ],
    },
    {
      id: "use-cases",
      title: "Project use cases",
      // biome-ignore format: one row per line, mirroring the source table
      entries: [
        useCase("product-configurator", "Product configurator", "Interactive product view with material and colour options.", "Medium", "GLTF, PBR Materials, Environment Maps", "webgl_loader_gltf; webgl_materials_variations_physical; webgl_lights_rectarealight", ["configurator", "e-commerce", "product", "3d viewer"]),
        useCase("data-visualization", "Data visualisation", "3D charts and interactive data views.", "Medium", "BufferGeometry, Points, Custom Shaders", "webgl_buffergeometry_points; webgl_interactive_points; webgl_geometry_dynamic", ["data viz", "charts", "3d graphs", "analytics"]),
        useCase("architectural-visualization", "Architectural visualisation", "Buildings and interiors with realistic light and reflections.", "High", "GLTF, HDR, CSM Shadows, SSR", "webgl_loader_gltf; webgl_materials_envmaps_hdr; webgl_shadowmap_csm; webgl_postprocessing_ssr", ["archviz", "building", "interior", "real estate"]),
        useCase("game-development", "Game development", "Game mechanics and interactive play.", "High", "Animation, Physics, Compute, Controls", "webgl_animation_skinning_blending; physics; webgpu_compute_birds; webgl_portal", ["game", "fps", "rpg", "interactive"]),
        useCase("medical-visualization", "Medical visualisation", "Volume and anatomy viewing from imaging data.", "High", "Volume Rendering, NRRD, PDB", "webgl_loader_nrrd; webgl_volume_cloud; webgl_loader_pdb", ["medical", "anatomy", "ct scan", "volume"]),
        useCase("scientific-visualization", "Scientific visualisation", "Simulation and research data on the GPU.", "High", "GPGPU, Compute Shaders, Simulation", "webgl_gpgpu_protoplanet; webgl_gpgpu_water; webgpu_compute_particles", ["scientific", "simulation", "physics", "research"]),
        useCase("panorama-viewer", "360 panorama viewer", "360-degree photo and video viewing, optionally in a headset.", "Low-Medium", "Equirectangular, Video, WebXR", "webgl_panorama_equirectangular; webgl_video_panorama_equirectangular; webxr_vr_panorama", ["360", "panorama", "vr", "virtual tour"]),
        useCase("ecommerce-3d", "E-commerce 3D", "Product viewing for online shops, with an AR export path.", "Medium", "GLTF, USDZ, Transmission", "webgl_loader_gltf; webgl_loader_usdz; webgl_materials_physical_transmission", ["e-commerce", "shopping", "ar", "product view"]),
        useCase("character-animation", "Character animation", "Rigged characters, inverse kinematics and facial blend shapes.", "Medium-High", "Animation, IK, Morph Targets", "webgl_animation_keyframes; webgl_animation_skinning_ik; webgl_morphtargets_face", ["character", "avatar", "animation", "rigging"]),
        useCase("particle-effects", "Particle effects", "Particle systems and visual effects.", "Medium-High", "GPGPU, Points, Compute", "webgl_gpgpu_birds; webgl_points_dynamic; webgpu_compute_particles_rain", ["particles", "effects", "vfx", "simulation"]),
        useCase("cad-viewer", "CAD viewer", "Engineering model viewing with section clipping.", "Medium", "Loaders, NURBS, Clipping", "webgl_loader_3mf; webgl_loader_stl; webgl_geometry_nurbs; webgl_clipping", ["cad", "engineering", "step", "iges"]),
        useCase("virtual-reality", "Virtual reality", "Headset experiences with controllers and hand tracking.", "High", "WebXR, Controllers, Hand Tracking", "webxr_vr_sandbox; webxr_vr_teleport; webxr_vr_rollercoaster", ["vr", "immersive", "headset"]),
        useCase("augmented-reality", "Augmented reality", "Mobile AR with hit testing and light estimation.", "High", "WebXR AR, Hit Test, Lighting Estimation", "webxr_ar_cones; webxr_ar_hittest; webxr_ar_lighting", ["ar", "mobile", "camera", "overlay"]),
        useCase("portfolio-website", "Portfolio website", "Creative showcases built on shaders and post effects.", "Medium", "Post-processing, Custom Shaders, Effects", "webgl_postprocessing_unreal_bloom; webgl_shaders_ocean; webgl_trails", ["portfolio", "creative", "art", "showcase"]),
        useCase("realtime-collaboration", "Real-time collaboration", "Several views or users on shared 3D state.", "Medium", "Multiple Scenes, Sync, State", "webgl_multiple_scenes_comparison; webgl_multiple_views", ["collaboration", "multiplayer", "networking"]),
        useCase("point-cloud-visualization", "Point cloud visualisation", "Scanned and photogrammetry point data.", "Medium", "PCD, PLY, Point Rendering", "webgl_loader_pcd; webgl_loader_ply; webgl_points_sprites", ["point cloud", "lidar", "scan", "photogrammetry"]),
        useCase("terrain-landscape", "Terrain and landscape", "Outdoor terrain from height maps, with water.", "Medium", "Heightmap, LOD, Water", "webgl_geometry_terrain; webgl_water", ["terrain", "landscape", "heightmap", "outdoor"]),
        useCase("car-configurator", "Car configurator", "Vehicle paint and trim configuration with reflections.", "High", "Clearcoat, Environment, Reflection", "webgl_materials_car; webgl_materials_physical_clearcoat; webgl_materials_envmaps_groundprojected", ["car", "automotive", "paint", "configurator"]),
        useCase("educational-3d", "Educational 3D", "Learning applications with models and simple interaction.", "Low-Medium", "Models, Animation, Interaction", "webgl_loader_pdb; webgl_morphtargets; webgl_geometry_text", ["education", "learning", "interactive", "simulation"]),
        useCase("webgpu-modern", "WebGPU application", "Applications built on WebGPU, TSL and compute.", "High", "WebGPU, TSL, Compute Shaders", "webgpu_compute_birds; webgpu_tsl_editor; webgpu_postprocessing_bloom", ["webgpu", "modern", "compute", "next-gen"]),
      ],
    },
    {
      id: "fundamentals",
      title: "Fundamentals",
      entries: [
        {
          id: "scene-graph",
          title: "Object3D hierarchy",
          text:
            "Mesh, Group, Light and Camera all extend Object3D. Transforms are relative to the parent; read world " +
            "values with getWorldPosition, getWorldQuaternion and getWorldDirection. traverse() walks a subtree, " +
            "layers select what a camera renders or a ray hits, renderOrder forces draw order.",
        },
        {
          id: "coordinate-system",
          title: "Right-handed, Y up, radians",
          text:
            "+X right, +Y up, +Z toward the viewer. AxesHelper draws X red, Y green, Z blue. Rotations are in " +
            "radians; convert with MathUtils.degToRad.",
        },
        {
          id: "renderer-setup",
          title: "Renderer configuration",
          text:
            "WebGLRenderer options: antialias, alpha for a transparent canvas, powerPreference, preserveDrawingBuffer " +
            "for screenshots. Set toneMapping (for example ACESFilmicToneMapping) with toneMappingExposure, " +
            "outputColorSpace to SRGBColorSpace, and cap the pixel ratio: renderer.setPixelRatio(Math.min(devicePixelRatio, 2)).",
          tags: ["pixel ratio", "tone mapping", "color space"],
        },
        {
          id: "scene-environment",
          title: "Background, environment and fog",
          text:
            "scene.background takes a colour, texture or cube map; scene.environment lights every PBR material from " +
            "one map. Fog is linear between near and far; FogExp2 thickens with distance by a density.",
        },
        {
          id: "frame-independent-motion",
          title: "Time-based motion",
          text:
            "Scale per-frame changes by Clock.getDelta() so speed does not depend on frame rate; use " +
            "getElapsedTime() for periodic motion. Fixed increments per frame run faster on fast displays.",
        },
        {
          id: "disposal",
          title: "Release GPU resources explicitly",
          text:
            "scene.remove() does not free GPU memory. Call dispose() on geometry, on each material (arrays too), on " +
            "textures and render targets, and on the renderer when the view is torn down.",
          tags: ["dispose", "memory"],
        },
      ],
    },
    {
      id: "getting-started",
      title: "Getting started",
      entries: [
        {
          id: "three-essentials",
          title: "Scene, camera, renderer",
          text:
            "Every app needs the three: a Scene to hold objects, a camera to view it, a renderer whose domElement " +
            "is added to the page. A Mesh joins a geometry and a material and is added to the scene.",
        },
        {
          id: "lit-materials-need-light",
          title: "Lit materials render black without lights",
          text:
            "Only unlit materials such as MeshBasicMaterial show without lights. Standard, Phong and Lambert need at " +
            "least a fill light plus a key light, or an environment map.",
        },
        {
          id: "render-loop",
          title: "The render loop",
          text:
            "Update objects and call renderer.render(scene, camera) every frame from requestAnimationFrame, or from " +
            "renderer.setAnimationLoop, which XR and WebGPU require.",
        },
        {
          id: "resize-handling",
          title: "Keep the aspect correct on resize",
          text:
            "On resize set camera.aspect, call camera.updateProjectionMatrix() and renderer.setSize(). Forgetting the " +
            "projection update stretches the image. One guide passes the raw devicePixelRatio; prefer the capped value.",
        },
      ],
    },
    {
      id: "loaders",
      title: "Loaders",
      entries: [
        {
          id: "gltf-first",
          title: "Prefer glTF/GLB",
          text:
            "glTF carries PBR materials, skins and animations and is the recommended web format. GLTFLoader returns " +
            "gltf.scene to add and gltf.animations for an AnimationMixer.",
        },
        {
          id: "compressed-assets",
          title: "Draco geometry and KTX2 textures",
          text:
            "Attach a DRACOLoader (setDecoderPath) with setDRACOLoader for compressed meshes. KTX2Loader needs " +
            "setTranscoderPath and detectSupport(renderer) before loading GPU-compressed textures. Both decoders must " +
            "be served by the app.",
        },
        {
          id: "other-model-formats",
          title: "FBX, OBJ and older formats",
          text:
            "FBXLoader, OBJLoader (with MTLLoader: preload the materials, then setMaterials), STLLoader, ColladaLoader " +
            "and TDSLoader cover legacy pipelines. Convert to glTF when you control the asset.",
        },
        {
          id: "load-feedback",
          title: "Progress, errors and caching",
          text:
            "Share one LoadingManager across loaders to track onStart, onProgress, onLoad and onError, show progress " +
            "to the user and handle the error callback. THREE.Cache.enabled = true reuses fetched files.",
        },
      ],
    },
    {
      id: "textures",
      title: "Textures",
      entries: [
        {
          id: "texture-sources",
          title: "Texture kinds",
          text:
            "Texture, CanvasTexture, VideoTexture, DataTexture, CubeTexture, Data3DTexture, DepthTexture and " +
            "CompressedTexture. A manually built Texture or DataTexture needs needsUpdate = true; loaders set it for you.",
        },
        {
          id: "texture-color-space",
          title: "Colour space per map",
          text:
            "Colour maps (map, emissiveMap) use SRGBColorSpace; data maps (normal, roughness, metalness, AO) stay " +
            "NoColorSpace or linear. A wrong choice washes the picture out or darkens it.",
          tags: ["color space", "srgb"],
        },
        {
          id: "wrapping-filtering",
          title: "Wrapping, repeat and filtering",
          text:
            "wrapS/wrapT take RepeatWrapping, ClampToEdgeWrapping or MirroredRepeatWrapping; repeat, offset, rotation " +
            "and center move the UVs. LinearMipmapLinearFilter gives the best minification, NearestFilter a pixelated " +
            "look, and anisotropy = renderer.capabilities.getMaxAnisotropy() sharpens surfaces seen at an angle.",
        },
        {
          id: "material-map-slots",
          title: "Material map slots",
          text:
            "map, normalMap, roughnessMap, metalnessMap, aoMap, emissiveMap, alphaMap, bumpMap and displacementMap " +
            "(which needs enough segments to move). The source copies uv into uv2 for aoMap; newer releases choose " +
            "the UV channel per texture, so check the installed version.",
        },
      ],
    },
    {
      id: "cameras",
      title: "Cameras",
      entries: [
        {
          id: "perspective-setup",
          title: "Perspective camera defaults",
          text:
            "Field of view in degrees, typically 45 to 75; near usually 0.1 and far 1000. Position it, then lookAt " +
            "the subject; set camera.up to change which way is up.",
        },
        {
          id: "orthographic-setup",
          title: "Orthographic frustum",
          text:
            "Derive left/right from a frustum size times the aspect and top/bottom from the size alone. On resize " +
            "recompute left and right, then update the projection. Use for 2D, CAD and isometric views.",
        },
        {
          id: "projection-update",
          title: "Update the projection after changes",
          text: "Changing fov, aspect, near, far or zoom has no effect until updateProjectionMatrix() is called.",
        },
        {
          id: "multi-view",
          title: "Layers, viewports and special cameras",
          text:
            "Camera layers render subsets of the scene. setViewport draws several cameras into one canvas (for a " +
            "minimap). ArrayCamera holds sub-camera viewports; CubeCamera renders a reflection cube map but is costly " +
            "when updated every frame.",
        },
        {
          id: "screen-world",
          title: "Screen and world coordinates",
          text:
            "vector.project(camera) maps world to normalised device coordinates (-1 to 1) and unproject reverses it; " +
            "Raycaster.setFromCamera turns a pointer position into a ray.",
        },
      ],
    },
    {
      id: "lights",
      title: "Lights and shadows",
      entries: [
        {
          id: "light-roles",
          title: "Which light for which role",
          text:
            "AmbientLight and HemisphereLight are directionless fill (hemisphere suits outdoors). DirectionalLight " +
            "is the sun; add its target to the scene. PointLight has distance (0 is unlimited) and decay. SpotLight " +
            "adds angle and penumbra (0 to 1). RectAreaLight is a soft panel aimed with lookAt.",
        },
        {
          id: "shadow-setup",
          title: "Shadow setup",
          text:
            "Enable renderer.shadowMap and choose a type: BasicShadowMap (fast, aliased), PCFShadowMap, " +
            "PCFSoftShadowMap or VSMShadowMap. Each object opts in with castShadow and receiveShadow. Fit a " +
            "directional light's shadow camera bounds to the scene and inspect them with CameraHelper.",
          tags: ["shadow"],
        },
        {
          id: "light-budget",
          title: "Light budget",
          text:
            "Keep three to five lights; outdoors, ambient plus one or two directional lights is enough. Bake static " +
            "lighting into light maps and use shadows selectively, at lower map resolution where possible.",
          tags: ["performance"],
        },
        {
          id: "intensity-ranges",
          title: "Intensity ranges",
          text:
            "As a starting point: about 0.1 to 1 for ambient and hemisphere, 1 to 10 for directional, point and spot, " +
            "10 to 100 or more for small area lights. The physicallyCorrectLights switch shown in the source is " +
            "deprecated in later releases.",
        },
        {
          id: "light-helpers",
          title: "Light helpers",
          text:
            "DirectionalLightHelper, PointLightHelper, SpotLightHelper, HemisphereLightHelper and the " +
            "RectAreaLightHelper add-on show where lights sit and point.",
        },
      ],
    },
    {
      id: "animations",
      title: "Animation",
      entries: [
        {
          id: "mixer-model",
          title: "Mixer, clip, action",
          text:
            "Create one AnimationMixer per animated root, get an AnimationAction with clipAction(clip), play it and " +
            "call mixer.update(delta) every frame; without the update nothing moves. AnimationClip.findByName picks " +
            "a clip from gltf.animations.",
        },
        {
          id: "action-playback",
          title: "Playback control",
          text:
            "play, stop, pause and reset; setLoop with LoopRepeat, LoopOnce or LoopPingPong; timeScale changes speed " +
            "and a negative value reverses; setEffectiveWeight sets the blend share.",
        },
        {
          id: "action-blending",
          title: "Blending between clips",
          text:
            "currentAction.crossFadeTo(next, seconds, warp), or fade the old action out and call " +
            "next.reset().fadeIn(seconds).play().",
        },
        {
          id: "keyframe-tracks",
          title: "Building clips from tracks",
          text:
            "VectorKeyframeTrack for '.position' or '.scale', QuaternionKeyframeTrack for '.quaternion', " +
            "ColorKeyframeTrack, NumberKeyframeTrack (for example '.material.opacity') and BooleanKeyframeTrack; " +
            "combine them in new AnimationClip(name, duration, tracks). Keyframe times are seconds.",
        },
        {
          id: "skeletal-and-morph",
          title: "Skeletons and morph targets",
          text:
            "A SkinnedMesh exposes skeleton.bones for direct posing; SkeletonHelper draws the rig. Morph targets are " +
            "weighted by morphTargetInfluences[i] and can be keyed with a '.morphTargetInfluences[0]' track.",
        },
        {
          id: "procedural-motion",
          title: "Procedural motion and easing",
          text:
            "Simple motion can be driven from elapsed time (sine for bobbing or pulsing). For eased tweens of " +
            "position or camera moves, use an external tween library.",
        },
      ],
    },
    {
      id: "math",
      title: "Math",
      entries: [
        {
          id: "vector-ops",
          title: "Vectors mutate in place",
          text:
            "Vector2, Vector3 and Vector4 methods such as add, sub, normalize and lerp change the vector itself; " +
            "clone() first to keep the original. lengthSq() avoids a square root when only comparing lengths.",
        },
        {
          id: "rotations",
          title: "Euler versus quaternion",
          text:
            "Euler angles are radians with an order ('XYZ' by default) that changes the result. Quaternion avoids " +
            "gimbal lock and interpolates with slerp; build it with setFromEuler, setFromAxisAngle or " +
            "setFromRotationMatrix. One source guide labels Euler angles as degrees; they are radians.",
        },
        {
          id: "matrix-ops",
          title: "Matrix4",
          text:
            "compose and decompose convert between a matrix and position, quaternion and scale. multiply(m) " +
            "post-multiplies and premultiply(m) pre-multiplies; invert, makeTranslation, makeRotationX/Y/Z and " +
            "makeScale build transforms.",
        },
        {
          id: "bounds-and-planes",
          title: "Bounds, spheres and planes",
          text:
            "Box3.setFromObject, getCenter, getSize, containsPoint and intersectsBox; Sphere for bounding spheres; " +
            "Plane.distanceToPoint and projectPoint for planar tests.",
        },
        {
          id: "curves",
          title: "Curves",
          text:
            "CubicBezierCurve3 and CatmullRomCurve3 sample with getPoints(n) into BufferGeometry.setFromPoints, or " +
            "give a point at getPoint(t) with t from 0 to 1, useful for camera and object paths.",
        },
        {
          id: "color-and-utils",
          title: "Color and MathUtils",
          text:
            "Color accepts hex, CSS strings or RGB in 0 to 1; setHSL and lerp adjust it. MathUtils offers clamp, " +
            "lerp, mapLinear, degToRad, radToDeg, randFloat, smoothstep and smootherstep.",
        },
      ],
    },
    {
      id: "interaction",
      title: "Interaction and picking",
      entries: [
        {
          id: "raycast-picking",
          title: "Picking with a ray",
          text:
            "Convert the pointer to device coordinates (x = clientX / width * 2 - 1, y = -(clientY / height) * 2 + 1), " +
            "call setFromCamera, then intersectObjects on a list of pickable objects. Each hit gives object, point, " +
            "distance and face. Use the canvas size, not the window, when the canvas does not fill the page.",
        },
        {
          id: "hover-feedback",
          title: "Hover feedback",
          text:
            "Save the hovered object's original emissive colour, highlight it, restore it when the pointer leaves " +
            "and switch the cursor to a pointer while over a target.",
        },
        {
          id: "manipulation",
          title: "Drag and transform gizmos",
          text:
            "DragControls emits dragstart, drag and dragend; TransformControls attaches to an object with " +
            "setMode (translate, rotate, scale) and setSpace (world, local). Disable OrbitControls while dragging, " +
            "via the 'dragging-changed' event. SelectionBox with SelectionHelper selects by rectangle.",
        },
        {
          id: "keyboard-and-pointer-lock",
          title: "Keyboard and pointer lock",
          text:
            "Keep a map of pressed keys and apply movement in the loop rather than in the key handler. " +
            "PointerLockControls locks on click and moves with moveForward and moveRight while isLocked.",
        },
        {
          id: "html-overlay",
          title: "HTML labels at 3D positions",
          text:
            "Project the world position with project(camera) and map device coordinates to pixels to place a " +
            "tooltip; the css2d approach does this for you.",
        },
      ],
    },
    {
      id: "postprocessing",
      title: "Post-processing",
      entries: [
        {
          id: "composer-chain",
          title: "Composer chain",
          text:
            "EffectComposer starts with a RenderPass and ends with an OutputPass (tone mapping and colour space). " +
            "Call composer.render() instead of renderer.render() and composer.setSize() on resize.",
        },
        {
          id: "effect-passes",
          title: "Common passes",
          text:
            "UnrealBloomPass (strength, radius, threshold), SSAOPass (kernelRadius, minDistance, maxDistance), " +
            "SSRPass, BokehPass depth of field (focus, aperture, maxblur), OutlinePass (selectedObjects, edge " +
            "colours), FilmPass, GlitchPass, and FXAA as a ShaderPass whose resolution uniform is 1 / size.",
        },
        {
          id: "custom-shader-pass",
          title: "Custom full-screen effect",
          text: "A ShaderPass takes a shader whose tDiffuse uniform receives the previous pass's image.",
        },
        {
          id: "post-budget",
          title: "Post-processing budget",
          text:
            "Effects are GPU-heavy: keep to three to five passes, run SSAO and SSR at lower resolution, disable " +
            "passes that are not visible, prefer FXAA over MSAA and test on target devices.",
          tags: ["performance"],
        },
      ],
    },
    {
      id: "controls",
      title: "Camera controls",
      entries: [
        {
          id: "orbit-controls-setup",
          title: "OrbitControls setup",
          text:
            "Set target, min/max distance, maxPolarAngle = Math.PI / 2 to stay above the ground and azimuth limits " +
            "if needed. enableDamping and autoRotate only work when controls.update() runs every frame.",
        },
        {
          id: "controls-by-use",
          title: "Choosing a control scheme",
          text:
            "OrbitControls for product and model viewers, MapControls for top-down maps, FirstPersonControls for " +
            "walkthroughs, FlyControls for free flight, PointerLockControls for first-person games, " +
            "TrackballControls for CAD, ArcballControls for scientific views.",
        },
        {
          id: "delta-controls",
          title: "Controls that need delta time",
          text: "FirstPersonControls and FlyControls must be updated with the frame delta from a Clock.",
        },
        {
          id: "camera-moves",
          title: "Animated camera moves",
          text:
            "Tween camera.position and controls.target together and call controls.update() on each step; " +
            "controls.reset() returns to the saved state. For static scenes, render on the 'change' event instead of " +
            "every frame.",
        },
      ],
    },
    {
      id: "materials",
      title: "Materials",
      entries: [
        {
          id: "material-ladder",
          title: "Material cost ladder",
          text:
            "From cheapest to most expensive: Basic (unlit), Lambert (diffuse), Phong (specular), Standard (PBR), " +
            "Physical. Toon gives cel shading with a gradientMap; Normal and Depth materials are for debugging and " +
            "depth effects.",
        },
        {
          id: "pbr-parameters",
          title: "PBR parameters and environment",
          text:
            "roughness 0 is a mirror and 1 fully diffuse; metalness 0 is dielectric and 1 metal. Metals need an " +
            "environment: load an HDR with RGBELoader, set EquirectangularReflectionMapping and assign " +
            "scene.environment.",
        },
        {
          id: "needs-update",
          title: "When needsUpdate is required",
          text:
            "Set material.needsUpdate after changing flatShading, swapping in or removing a texture, toggling " +
            "transparent or editing shader code. Colour and numeric uniform changes do not need it.",
        },
        {
          id: "transparency-and-depth",
          title: "Transparency, depth and z-fighting",
          text:
            "Transparent materials must be sorted and cost more; use alphaTest for cut-outs. depthTest, depthWrite and " +
            "renderOrder control layering; polygonOffset separates coplanar surfaces.",
        },
        {
          id: "lines-and-points",
          title: "Lines and points",
          text:
            "LineBasicMaterial ignores linewidth above 1 on most platforms. LineDashedMaterial needs " +
            "line.computeLineDistances(). PointsMaterial has size, sizeAttenuation, alphaTest and vertexColors.",
        },
        {
          id: "multi-material",
          title: "Several materials on one geometry",
          text:
            "Pass an array of materials; each geometry group (addGroup(start, count, materialIndex)) selects one. " +
            "BoxGeometry already has six groups, one per face.",
        },
        {
          id: "material-reuse",
          title: "Share and cache materials",
          text:
            "Reuse one material across meshes and cache materials by key instead of creating one per object; " +
            "dispose them when no mesh uses them.",
          tags: ["performance"],
        },
      ],
    },
    {
      id: "advanced-materials",
      title: "Advanced materials",
      entries: [
        {
          id: "physical-layers",
          title: "MeshPhysicalMaterial layers",
          text:
            "clearcoat and clearcoatRoughness (lacquer, car paint), transmission with thickness and ior from 1 to " +
            "2.333 (glass is about 1.5), attenuationColor and attenuationDistance, sheen (fabric), iridescence with " +
            "its ior and thickness range, anisotropy (brushed metal) and specularIntensity/specularColor.",
        },
        {
          id: "material-recipes",
          title: "Glass and paint starting points",
          text:
            "Glass: metalness 0, roughness 0, transmission 1, some thickness, ior 1.5. Car paint: a metallic base " +
            "with clearcoat 1 and a low clearcoatRoughness.",
        },
        {
          id: "blending-modes",
          title: "Blending modes",
          text:
            "NoBlending, NormalBlending (default), AdditiveBlending for glow, SubtractiveBlending, MultiplyBlending; " +
            "CustomBlending with blendEquation, blendSrc and blendDst for anything else.",
        },
        {
          id: "physical-cost",
          title: "Use Physical sparingly",
          text:
            "MeshStandardMaterial is the balanced default; MeshPhysicalMaterial is expensive, so reserve it for " +
            "surfaces that need its layers. Minimise uniform updates and share materials.",
          tags: ["performance"],
        },
      ],
    },
    {
      id: "performance",
      title: "Performance",
      entries: [
        {
          id: "draw-calls",
          title: "Cut draw calls",
          text:
            "Use InstancedMesh for repeated objects (setMatrixAt, then instanceMatrix.needsUpdate = true), " +
            "mergeGeometries for static meshes and texture atlases. renderer.info reports calls, triangles, " +
            "geometries, textures and programs.",
          tags: ["draw calls", "instancing"],
        },
        {
          id: "level-of-detail",
          title: "Level of detail",
          text:
            "THREE.LOD switches meshes by camera distance (addLevel(mesh, distance)); SimplifyModifier reduces a " +
            "mesh's vertex count.",
        },
        {
          id: "culling",
          title: "Frustum culling",
          text:
            "Objects outside the view are skipped by default, which relies on correct bounding volumes. Set " +
            "frustumCulled = false only for objects whose bounds are known to be wrong.",
        },
        {
          id: "texture-memory",
          title: "Texture memory",
          text:
            "Use power-of-two sizes (512, 1024, 2048), KTX2 compression and mipmaps, lower resolution for distant " +
            "objects, and dispose textures no longer used.",
        },
        {
          id: "shadow-cost",
          title: "Shadow cost",
          text:
            "Lower shadow mapSize (1024 instead of 2048), tighten the shadow camera near/far and bounds, turn off " +
            "castShadow on small or distant objects and prefer PCFShadowMap over PCFSoftShadowMap when softness " +
            "is not needed.",
        },
        {
          id: "allocation-in-loop",
          title: "No allocation in the frame loop",
          text:
            "Pool frequently spawned objects, reuse scratch vectors and matrices, and cache world positions instead " +
            "of recomputing them in loops. Render post effects at reduced resolution and dispose render targets.",
        },
        {
          id: "measure-on-device",
          title: "Measure on target devices",
          text:
            "Watch frame time with a stats panel and renderer.info, use the GPU timer query extension where " +
            "available and profile on the devices you ship to.",
        },
      ],
    },
    {
      id: "node-materials",
      title: "Node materials (TSL)",
      entries: [
        {
          id: "tsl-model",
          title: "What TSL is",
          text:
            "The Three Shading Language builds shaders as a typed node graph in JavaScript and emits GLSL or WGSL, " +
            "so one material works on both backends. Node materials (MeshStandardNodeMaterial, " +
            "MeshPhysicalNodeMaterial, MeshBasicNodeMaterial, PointsNodeMaterial, SpriteNodeMaterial) expose slots " +
            "such as colorNode, normalNode, roughnessNode, metalnessNode, emissiveNode and positionNode.",
        },
        {
          id: "tsl-building-blocks",
          title: "Building blocks",
          text:
            "Inputs: uniform, attribute, texture, uv, cubeTexture, storage. Maths chains as methods (.mul, .add, " +
            ".sin). Fn wraps a reusable function; built-ins such as positionLocal, normalLocal and normalView feed " +
            "displacement and fresnel. Idiom: material.colorNode = texture(map).mul(color(0xffffff)).",
        },
        {
          id: "tsl-imports",
          title: "Import paths change between releases",
          text:
            "The source imports TSL from 'three/nodes' and the renderer from 'three/webgpu'; later releases moved the " +
            "TSL entry point and renamed some nodes such as the timer helpers. Check the installed release's exports " +
            "before copying a recipe.",
          tags: ["version"],
        },
        {
          id: "tsl-when",
          title: "When to choose node materials",
          text:
            "Procedural or reusable materials, code that must run on WebGL and WebGPU, and anything feeding compute. " +
            "Compute nodes need the WebGPU backend; GLSL ShaderMaterial code does not port automatically.",
        },
      ],
    },
    {
      id: "physics-xr",
      title: "Physics and XR",
      entries: [
        {
          id: "physics-addons",
          title: "Physics through add-ons",
          text:
            "Three.js has no physics engine. The RapierPhysics, AmmoPhysics and JoltPhysics add-ons initialise " +
            "asynchronously, then addMesh(mesh, mass) registers a body; no mass means static. Advance the " +
            "simulation as the wrapper's API requires and keep render meshes driven by it.",
        },
        {
          id: "xr-session",
          title: "XR session loop",
          text:
            "Set renderer.xr.enabled, add VRButton, ARButton or XRButton, and render from renderer.setAnimationLoop. " +
            "renderer.xr.isPresenting tells XR from desktop; renderer.xr.getCamera gives the headset camera.",
        },
        {
          id: "xr-input",
          title: "Controllers and hands",
          text:
            "renderer.xr.getController(i) emits selectstart and selectend; getControllerGrip with " +
            "XRControllerModelFactory shows the device model; getHand(i) with a hand-model add-on shows tracked " +
            "hands. Teleport by casting a ray from the controller's world matrix.",
        },
        {
          id: "xr-performance",
          title: "XR frame budget",
          text:
            "Target 90 frames per second, 11.1 ms per frame: fewer polygons, cheaper shadows, little " +
            "post-processing, instancing, foveated rendering where the device offers it, and testing on the headset.",
          tags: ["performance"],
        },
        {
          id: "spatial-audio",
          title: "Positional audio",
          text:
            "Attach an AudioListener to the camera and a PositionalAudio (loaded with AudioLoader, tuned with " +
            "setRefDistance) to the emitting object.",
        },
      ],
    },
    {
      id: "specialized-loaders",
      title: "Specialised loaders",
      entries: [
        {
          id: "svg-to-mesh",
          title: "SVG to shapes",
          text:
            "SVGLoader returns paths; SVGLoader.createShapes(path) feeds ShapeGeometry for flat shapes or " +
            "ExtrudeGeometry for depth. Use DoubleSide and depthWrite false for flat layered artwork.",
        },
        {
          id: "technical-formats",
          title: "Print, scan and science formats",
          text:
            "STL has no normals, so call computeVertexNormals. PLY may carry vertex colours (use vertexColors when " +
            "the colour attribute exists). VTK, PDB (atom and bond geometries), VRML, LDraw (needs the parts " +
            "library path) and Collada (with animations) have loaders. The 3MF loader class is ThreeMFLoader; the " +
            "source's import name starting with a digit is not valid JavaScript.",
        },
        {
          id: "hdr-environment",
          title: "HDR environments",
          text:
            "RGBELoader (.hdr) or EXRLoader with EquirectangularReflectionMapping; prefilter through " +
            "PMREMGenerator.fromEquirectangular for scene.environment, then dispose the source texture and generator.",
        },
        {
          id: "text-geometry",
          title: "3D text",
          text:
            "FontLoader loads a typeface JSON font for TextGeometry. Extrusion is 'depth' (older releases called it " +
            "'height'); computeBoundingBox and center() place it at the origin.",
        },
        {
          id: "usdz-export",
          title: "USDZ export for mobile AR",
          text: "USDZExporter.parse(scene) produces a USDZ file that can be downloaded and opened in a mobile AR viewer.",
        },
        {
          id: "fit-imported-model",
          title: "Centre and scale an import",
          text:
            "Take Box3.setFromObject(model), subtract its centre from the position and scale by the target size " +
            "over the largest dimension.",
        },
      ],
    },
    {
      id: "webgpu",
      title: "WebGPU",
      entries: [
        {
          id: "webgpu-renderer-setup",
          title: "Renderer and support check",
          text:
            "Feature-detect WebGPU (the WebGPU capability helper's isAvailable) before creating WebGPURenderer, " +
            "render through setAnimationLoop and give unsupported browsers a fallback. Support was still uneven " +
            "across browsers when the source was written (2025).",
        },
        {
          id: "compute",
          title: "Compute work",
          text:
            "Write a compute function with Fn over storage buffers indexed by instanceIndex (use If for branches), " +
            "build it with .compute(count) and run renderer.compute(node) each frame before rendering. Good fits are " +
            "particles and simulations over large data.",
        },
        {
          id: "compile-ahead",
          title: "Compile before the first frame",
          text: "await renderer.compileAsync(scene, camera) before starting the loop avoids hitches on first draw.",
        },
        {
          id: "webgl-migration",
          title: "Porting from WebGL",
          text:
            "Most scene code carries over. Custom GLSL (ShaderMaterial, onBeforeCompile) must be rewritten as node " +
            "materials or WGSL, some extensions are missing, and compute exists only on WebGPU. Multiple render " +
            "targets, timestamp queries and indirect drawing are release-specific; verify their API before use.",
        },
      ],
    },
    {
      id: "shaders",
      title: "GLSL shaders",
      entries: [
        {
          id: "shader-vs-raw",
          title: "ShaderMaterial versus RawShaderMaterial",
          text:
            "ShaderMaterial injects modelMatrix, modelViewMatrix, projectionMatrix, viewMatrix, normalMatrix, " +
            "cameraPosition and the position, normal and uv attributes. RawShaderMaterial injects nothing: declare " +
            "precision, attributes and uniforms yourself.",
        },
        {
          id: "uniforms-and-varyings",
          title: "Uniforms and varyings",
          text:
            "Uniforms are { value } objects: a Color arrives as vec3, a Texture as sampler2D, arrays as GLSL arrays. " +
            "Update .value each frame (mutate vectors in place). Varyings carry uv, normalMatrix * normal and view " +
            "position from the vertex to the fragment stage.",
        },
        {
          id: "shader-patterns",
          title: "Common effects",
          text:
            "Fresnel or rim light from pow(1 - dot(viewDir, normal), k); vertex waves by offsetting position with " +
            "sin; value noise from hashed grid corners; gradients with mix and smoothstep on uv; dissolve by " +
            "discarding below a noise threshold with a glowing edge band.",
        },
        {
          id: "extend-builtins",
          title: "Extending built-in materials",
          text:
            "onBeforeCompile lets you add uniforms and replace chunks such as '#include <begin_vertex>' or " +
            "'#include <color_fragment>'. Keep the shader object in material.userData to update its uniforms later.",
        },
        {
          id: "glsl-versions",
          title: "GLSL 1 versus GLSL 3",
          text:
            "By default write texture2D and gl_FragColor; with glslVersion: THREE.GLSL3 use texture() and declare an " +
            "out vec4 for the colour.",
        },
        {
          id: "shader-performance",
          title: "Shader performance and debugging",
          text:
            "Pack uniforms into vectors, replace branches with mix and step, precompute on the CPU, use lookup " +
            "textures and limit overdraw. Debug by writing uv or normals as colour and enable " +
            "renderer.debug.checkShaderErrors.",
        },
      ],
    },
    {
      id: "geometry",
      title: "Geometry",
      entries: [
        {
          id: "primitives",
          title: "Built-in primitives",
          text:
            "Box, Sphere (partial with phi/theta ranges), Plane, Circle, Cylinder (radiusTop 0 gives a cone, six " +
            "segments a hexagonal prism), Cone, Torus, TorusKnot, Ring, Capsule and the polyhedra whose detail " +
            "parameter adds subdivisions.",
        },
        {
          id: "path-shapes",
          title: "Shapes from paths",
          text:
            "LatheGeometry spins a 2D profile; Shape plus ExtrudeGeometry gives depth and bevels; TubeGeometry follows " +
            "a CatmullRomCurve3.",
        },
        {
          id: "custom-buffer-geometry",
          title: "Custom BufferGeometry",
          text:
            "setAttribute position (3), normal (3, needed for lighting), uv (2) and color (3 or 4, used with " +
            "vertexColors), and setIndex to reuse vertices. Uint16 indices address up to 65535 vertices; larger " +
            "meshes need Uint32. InterleavedBuffer packs attributes into one array.",
        },
        {
          id: "editing-geometry",
          title: "Editing vertices",
          text:
            "Change values with setXYZ, set needsUpdate on the attribute, then recompute normals and the bounding " +
            "box and sphere so lighting, culling and raycasts stay right. center(), rotateX, translate and scale " +
            "bake transforms into the vertices.",
        },
        {
          id: "instanced-geometry",
          title: "Instanced geometry",
          text:
            "With InstancedMesh, set a scratch Object3D's transform, updateMatrix(), setMatrixAt(i, dummy.matrix) " +
            "and flag instanceMatrix (and instanceColor) for update; raycast hits report instanceId. " +
            "InstancedBufferGeometry with InstancedBufferAttribute adds custom per-instance data for shaders.",
        },
        {
          id: "lines-edges-points",
          title: "Lines, edges and points",
          text:
            "EdgesGeometry keeps edges above a threshold angle and WireframeGeometry every triangle edge, both drawn " +
            "with LineSegments. Line, LineLoop and LineSegments connect points; Points renders a cloud.",
        },
        {
          id: "geometry-utils",
          title: "Geometry utilities",
          text:
            "BufferGeometryUtils.mergeGeometries needs matching attributes and can keep groups for multi-material; " +
            "computeTangents prepares normal maps; interleaveAttributes packs data. Morph targets go in " +
            "geometry.morphAttributes.position.",
        },
        {
          id: "segment-counts",
          title: "Segment counts",
          text:
            "More segments are smoother and slower: for a sphere, 16 by 16 for performance, 32 by 32 for good " +
            "quality, 64 by 64 for close-ups. Dispose geometry you no longer use.",
        },
      ],
    },
    ...THREEJS_EXAMPLE_SECTIONS,
  ],
  checks: [
    {
      id: "threejs.pixel-ratio-cap",
      kind: "hard",
      level: "asset",
      measure: "Pixel ratio the renderer is set to (renderer.getPixelRatio()) on a high-density display.",
      metric: { id: "renderer-pixel-ratio", unit: "ratio" },
      threshold: { op: "<=", value: 2 },
    },
    {
      id: "threejs.light-count",
      kind: "hard",
      level: "asset",
      measure: "Light objects in the scene graph, helpers excluded.",
      metric: { id: "scene-light-count", unit: "count" },
      threshold: { op: "<=", value: 5 },
    },
    {
      id: "threejs.post-pass-count",
      kind: "hard",
      level: "asset",
      measure: "Passes added to the EffectComposer, render and output passes included.",
      metric: { id: "composer-pass-count", unit: "count" },
      threshold: { op: "<=", value: 5 },
    },
    {
      id: "threejs.xr-frame-time",
      kind: "hard",
      level: "asset",
      measure: "Frame time while an XR session is presenting, measured on the target headset.",
      metric: { id: "xr-frame-time-ms", unit: "ms" },
      threshold: { op: "<=", value: 11.1 },
      params: { targetFps: 90 },
    },
    {
      id: "threejs.uint16-index-range",
      kind: "hard",
      level: "asset",
      measure: "Geometries with a Uint16 index whose vertex count exceeds what a Uint16 index can address.",
      metric: { id: "uint16-index-overflow", unit: "count" },
      threshold: { op: "==", value: 0 },
      params: { uint16MaxVertices: 65535 },
    },
    {
      id: "threejs.version-checked",
      kind: "evidence",
      level: "job",
      measure:
        "The installed Three.js version and renderer, set against the classes and import paths the scene uses.",
      judges: ["ai", "human"],
      evidence: ["document"],
      pass: "Every class, property and import path used exists in the installed release for the chosen renderer.",
    },
    {
      id: "threejs.teardown-releases",
      kind: "evidence",
      level: "asset",
      measure:
        "renderer.info memory counts and running loops or listeners before mounting and after teardown.",
      judges: ["ai", "human"],
      evidence: ["measurement", "document"],
      pass: "After teardown no loop or listener remains and geometry and texture counts return to the baseline.",
    },
    {
      id: "threejs.texture-color-space",
      kind: "evidence",
      level: "asset",
      measure: "Colour space of each texture by role, and a rendered frame.",
      judges: ["ai", "human"],
      evidence: ["document", "frame"],
      pass: "Colour maps are sRGB, data maps are not, and the frame looks neither washed out nor crushed.",
    },
    {
      id: "threejs.resize-no-stretch",
      kind: "evidence",
      level: "asset",
      measure: "Frames captured before and after resizing the viewport to a different aspect.",
      judges: ["ai", "human"],
      evidence: ["frame"],
      pass: "Objects keep their proportions and the canvas fills its container after the resize.",
    },
    {
      id: "threejs.render-and-interaction",
      kind: "evidence",
      level: "asset",
      measure: "A clip of the running scene while its interactions are exercised.",
      judges: ["ai", "human"],
      evidence: ["clip"],
      pass: "The scene renders as specified and every specified interaction responds.",
    },
    {
      id: "threejs.renderer-fallback",
      kind: "evidence",
      level: "asset",
      measure: "Behaviour on a device or browser without the chosen renderer's support.",
      judges: ["ai", "human"],
      evidence: ["clip", "document"],
      pass: "The product's fallback appears instead of a blank or broken canvas.",
    },
    {
      id: "threejs.shadow-fit",
      kind: "evidence",
      level: "asset",
      measure: "A frame with shadows on, and the shadow camera bounds shown with CameraHelper.",
      judges: ["ai", "human"],
      evidence: ["frame"],
      pass: "Shadows are neither clipped at the bounds nor visibly blocky, and only objects that need them cast.",
    },
  ],
};
