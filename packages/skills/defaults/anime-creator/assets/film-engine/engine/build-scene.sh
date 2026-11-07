#!/bin/bash
# Bundle one scene of a series against the shared engine.
# usage: engine/build-scene.sh <scene-dir>   -> <scene-dir>/dist/film.js
# Aliases: "three" -> engine/vendor/three.module.js, "engine/..." -> engine/src/..., "edl" -> <scene-dir>/edl.json,
# so every scene of the series runs the same engine code and only owns its config, cues and EDL.
set -euo pipefail
ENGINE="$(cd "$(dirname "$0")" && pwd)"
SCENE="$(cd "${1:?scene dir}" && pwd)"
[ -f "$ENGINE/vendor/three.module.js" ] || { echo "missing $ENGINE/vendor/three.module.js (run anime-studio.py init-series)" >&2; exit 1; }
cd "$SCENE"
npx -y esbuild@0.25.10 src/main.js --bundle --format=iife --target=chrome120 --log-level=warning \
  --alias:three="$ENGINE/vendor/three.module.js" --alias:engine="$ENGINE/src" --alias:edl="./edl.json" \
  --outfile=dist/film.js
echo "built $SCENE/dist/film.js"
