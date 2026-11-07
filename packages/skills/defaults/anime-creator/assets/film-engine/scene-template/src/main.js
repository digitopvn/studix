// Scene entry: the shared engine boots with this scene's config, GL FX cues and DOM edit cues.
// Built by engine/build-scene.sh (aliases "engine", "three", "edl").
import { bootFilm } from "engine/boot-film-engine.js";
import { SCENE } from "./scene/scene-config.js";
import { fxCues } from "./scene/fx-cues.js";
import { editCues } from "./scene/edit-cues.js";

bootFilm({ scene: SCENE, fxCues, editCues });
