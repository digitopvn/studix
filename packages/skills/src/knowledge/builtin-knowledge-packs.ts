import type { KnowledgePack } from "./knowledge-pack-schema.ts";
import { artDirectionPack } from "./packs/art-direction-pack.ts";
import { compositionTimingPack } from "./packs/composition-timing-pack.ts";
import { creativeDirectionPack } from "./packs/creative-direction-pack.ts";
import { dopCameraPack } from "./packs/dop-camera-pack.ts";
import { motionCraftPack } from "./packs/motion-craft-pack.ts";
import { motionDesignPack } from "./packs/motion-design-pack.ts";
import { narrativePack } from "./packs/narrative-pack.ts";
import { performancePack } from "./packs/performance-pack.ts";
import { physicsLitePack } from "./packs/physics-lite-pack.ts";
import { productionFailureModesPack } from "./packs/production-failure-modes-pack.ts";
import { shaderGlPack } from "./packs/shader-gl-pack.ts";
import { signatureMotionStylesPack } from "./packs/signature-motion-styles-pack.ts";
import { soundPack } from "./packs/sound-pack.ts";
import { threejsPack } from "./packs/threejs-pack.ts";
import { voicePerformancePack } from "./packs/voice-performance-pack.ts";
import { wardrobePropsPack } from "./packs/wardrobe-props-pack.ts";

/** Knowledge packs shipped with Studix, in a stable order. */
export const BUILTIN_KNOWLEDGE_PACKS: readonly KnowledgePack[] = [
  narrativePack,
  performancePack,
  artDirectionPack,
  dopCameraPack,
  wardrobePropsPack,
  physicsLitePack,
  soundPack,
  productionFailureModesPack,
  creativeDirectionPack,
  voicePerformancePack,
  motionDesignPack,
  motionCraftPack,
  compositionTimingPack,
  shaderGlPack,
  threejsPack,
  signatureMotionStylesPack,
];
