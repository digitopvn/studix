"""Compile generation prompts from the series bible, and small context packs for one shot.

A prompt is never written from memory: character anchors, handedness, props and palette come from
bible/characters/<id>.json, the location and light from bible/sets/<id>.json, the look from bible/style.json.
That is what keeps a character identical across 40 shots and 12 episodes, and it saves the agent from
re-reading the whole bible for every job.

context_pack gives a fresh agent (or a subagent) just what one shot needs: its beat, its neighbours, the
characters and set in it, continuity state and the latest story digest.
"""
from __future__ import annotations

from pathlib import Path

from . import continuity_transition_validator as ct
from . import reference_roles as rr
from . import shot_boundary_contract as sb
from .common_io_and_paths import load_json

SAFE_MARGIN = ("Compose with an 8% safe margin: no head, hand, foot, blade tip or prop touches or crosses the frame "
               "edge unless the brief says it exits frame.")
SAME_DESIGN = "Keep every character design IDENTICAL to the reference sheets: same face, hair, costume, accessories and weapon."


def _load_bible(series_dir: Path) -> tuple[dict, dict, dict]:
    chars = {p.stem: load_json(p) for p in sorted((series_dir / "bible/characters").glob("*.json")) if not p.stem.startswith("_")}
    sets = {p.stem: load_json(p) for p in sorted((series_dir / "bible/sets").glob("*.json")) if not p.stem.startswith("_")}
    style_p = series_dir / "bible/style.json"
    return chars, sets, (load_json(style_p) if style_p.exists() else {})


def _char_line(c: dict) -> str:
    bits = [", ".join(c.get("anchors", []))]
    if c.get("handedness"):
        bits.append(c["handedness"])
    if c.get("props"):
        bits.append("props: " + "; ".join(f"{k} {v}" for k, v in c["props"].items()))
    return f"{c.get('name', c.get('id'))}: " + "; ".join(b for b in bits if b)


def compile_prompt(series_dir: Path, job: dict, *, max_refs: int = 3) -> dict:
    """job: {kind: keyframe|video|sheet, characters: [...], set, framing, action, staging, emotion, camera,
    acting, boundary {mode, camera?, cut?} + after (previous shot id), dialogue: {speaker, text, language}, prompt (free text), refs (paths or {path, role}), costume {char: look}}.
    Returns {prompt, refs, negative, ref_roles, dropped_refs}; dropped_refs says why each reference was left out."""
    chars, sets, style = _load_bible(series_dir)
    kind = job.get("kind", "keyframe")
    cs = [chars[c] for c in job.get("characters", []) if c in chars]
    missing = [c for c in job.get("characters", []) if c not in chars]
    if missing:
        raise SystemExit(f"characters not in the bible: {', '.join(missing)}")
    st = sets.get(job.get("set", ""), {})
    parts = []
    if job.get("action"):
        parts.append(job["action"].rstrip(".") + ".")
    for key, label in (("framing", "Framing"), ("staging", "Staging"), ("emotion", "Emotion"), ("camera", "Camera"), ("acting", "Acting")):
        if job.get(key):
            parts.append(f"{label}: {job[key].rstrip('.')}.")
    if job.get("boundary"):  # how this shot joins the previous one decides whether framing carries over
        parts.append(sb.prompt_line(job["boundary"], job.get("after")))
    d = job.get("dialogue")
    if d:
        who = chars.get(d.get("speaker", ""), {}).get("name", d.get("speaker", ""))
        lang = d.get("language", "")
        parts.append(f"{who} says{' in ' + lang if lang else ''}: \"{d['text']}\" (clear lip movement matching the words).")
    if job.get("prompt"):
        parts.append(job["prompt"].strip())
    if cs:
        parts.append(SAME_DESIGN + " " + " | ".join(_char_line(c) for c in cs) + ".")
    if st:
        loc = st.get("description", "")
        if st.get("light"):
            loc += f"; light: {st['light']}"
        if st.get("ground"):
            loc += f"; ground: {st['ground']} (feet planted on it, contact shadows)"
        parts.append(f"Location: {loc}.")
    if kind in ("keyframe", "sheet"):
        parts.append(SAFE_MARGIN)
        parts.append(style.get("block", ""))
    else:
        parts.append(style.get("video_block", style.get("block", "")))
    refs = []
    for cid, c in zip([c for c in job.get("characters", []) if c in chars], cs):
        if c.get("sheet"):
            refs.append({"path": str(series_dir / c["sheet"]), "role": "identity", "of": cid})
        # an approved costume or prop version for this shot (helmet off, damaged armour) rides with the identity sheet,
        # so a location or outfit never overrides the face
        look = (job.get("costume") or {}).get(cid)
        if look and look in (c.get("costumes") or {}):
            refs.append({"path": str(series_dir / c["costumes"][look]), "role": "costume-prop", "of": cid})
    if st.get("refs"):
        refs.append({"path": str(series_dir / st["refs"][0]), "role": "environment"})
    for r in job.get("refs", []):
        r = {"path": r, "role": "extra"} if isinstance(r, str) else dict(r)
        refs.append({**r, "path": str(series_dir / r["path"])})
    # fewer refs follow better: past runs drifted with 4+ refs; role precedence keeps character sheets over set refs
    sel = rr.select(refs, {"images": max_refs, "videos": job.get("max_ref_videos", 0)})
    neg = ", ".join(x for x in (style.get("negatives", ""), *[", ".join(c.get("negatives", [])) for c in cs]) if x)
    return {"prompt": " ".join(p for p in parts if p).strip(), "refs": [r["path"] for r in sel["chosen"]], "negative": neg,
            "ref_roles": [{"path": r["path"], "role": r["role"]} for r in sel["chosen"]],
            "dropped_refs": [{"path": r["path"], "role": r["role"], "reason": r["reason"]} for r in sel["dropped"]]}


def context_pack(series_dir: Path, episode_dir: Path, scene: str, shot_id: str, *, story_chars: int = 1800) -> str:
    """A short markdown brief for one shot: everything a fresh context needs, nothing it does not."""
    chars, sets, style = _load_bible(series_dir)
    edl = load_json(episode_dir / "scenes" / scene / "edl.json")
    shots = edl["shots"]
    idx = next((i for i, s in enumerate(shots) if s["id"] == shot_id), None)
    if idx is None:
        raise SystemExit(f"{shot_id} not in {scene}/edl.json")
    s = shots[idx]
    out = [f"# {episode_dir.name}/{scene}/{shot_id} ({s.get('kind')}, {s.get('tier', '?')}, {s['end'] - s['start']:.2f}s)",
           f"Beat: {s.get('beat', '')}"]
    if idx > 0:
        out.append(f"Previous: {shots[idx - 1]['id']} - {shots[idx - 1].get('beat', '')}")
    if idx + 1 < len(shots):
        out.append(f"Next: {shots[idx + 1]['id']} - {shots[idx + 1].get('beat', '')}")
    for line in s.get("dialogue") or []:
        out.append(f"Line ({line.get('speaker')}): {line['text']}" + (f" / {line['tr']}" if line.get("tr") else ""))
    names = s.get("characters") or [c for c in chars if c in str(s)]
    for c in names:
        if c in chars:
            ch = chars[c]
            out.append(f"Character {_char_line(ch)}" + (f"; voice {ch['voice'].get('voice_id', '')} ({ch['voice'].get('language', '')})" if ch.get("voice") else ""))
    if s.get("set") in sets:
        out.append(f"Set {s['set']}: {sets[s['set']].get('description', '')}")
    cont_p = series_dir / "story/continuity.json"
    if cont_p.exists():
        cont = load_json(cont_p)
        state = cont.get("state", {})
        if state:
            out.append("Continuity: " + "; ".join(f"{k}: {v}" for k, v in state.items()))
        # per-shot prop and decal state, keyed "<episode>/<scene>/<shot>", so a decal the script needs is never dropped
        before, after, inv = ct.states((cont.get("shots") or {}).get(f"{episode_dir.name}/{scene}/{shot_id}"))
        if before:
            out.append("Shot state (must be visible): " + "; ".join(f"{k}: {v}" for k, v in before.items()))
        changed = {k: v for k, v in after.items() if before.get(k) != v}
        if changed:
            out.append("Ends with: " + "; ".join(f"{k}: {v}" for k, v in changed.items()))
        if inv:
            out.append("Never changes: " + "; ".join(inv))
    story_p = series_dir / "story/story-so-far.md"
    if story_p.exists():
        txt = story_p.read_text(encoding="utf-8").strip()
        out.append("Story so far (latest): " + (txt[-story_chars:] if len(txt) > story_chars else txt))
    if style.get("name"):
        out.append(f"Look: {style['name']}")
    return "\n".join(out) + "\n"
