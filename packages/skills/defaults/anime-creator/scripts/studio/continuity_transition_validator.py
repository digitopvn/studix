"""Continuity across cuts: does each shot start in the state the previous shot ended in?

story/continuity.json `shots` is keyed "<episode>/<scene>/<shot>". An entry is either the legacy flat map
({"taoyao.sword": "drawn, right hand"}, meaning the same state before and after) or
  {state_before: {...}, state_after: {...}, invariants: ["mira.hand=right", ...], changes: {key: reason},
   overrides: [{key, reason, reviewer}]}
check() walks the EDL order of one scene (and into the next scene's first shot when given, in this episode or the
next one) carrying state forward: a key a shot leaves out keeps its last value, and a key a shot names is compared
with the last value any earlier shot gave it (a first mention has nothing to compare with). Every difference is
  definite   both shots name the key in the before/after format and the values differ, with no override
  suspected  a difference involving a legacy free-text entry or the series state, or an invariant a shot breaks
  allowed    the next shot lists the key in `changes` (it happens on screen) or an override with reason and reviewer
The series `state` block (the state after `after_episode`) joins the walk after this scene's last shot when the
handoff crosses into another episode or series_state is asked for: the episode's last shot is checked against it, and
the next episode's first shot is checked against the series state as it was handed over.
An override without a reason or a reviewer does not count. Offline, no frame is read: this checks the written
intent; qa-shot-boundaries.py checks the pixels.
"""
from __future__ import annotations

CLASSES = ("definite", "suspected", "allowed")


def states(entry: dict | None) -> tuple[dict, dict, list[str]]:
    """-> (before, after, invariants) for a legacy flat entry or a before/after entry."""
    e = entry or {}
    if "state_before" in e or "state_after" in e:
        before = dict(e.get("state_before") or {})
        after = {**before, **(e.get("state_after") or {})}
        return before, after, list(e.get("invariants") or [])
    flat = {k: v for k, v in e.items() if not k.startswith("_") and k not in ("invariants", "changes", "overrides")}
    return flat, dict(flat), list(e.get("invariants") or [])


def _structured(entry: dict | None) -> bool:
    return bool(entry) and ("state_before" in entry or "state_after" in entry)


def _override(entry: dict, key: str) -> dict | None:
    for o in (entry or {}).get("overrides") or []:
        if o.get("key") == key and o.get("reason") and o.get("reviewer"):
            return o
    return None


def _invariant_breaks(inv: list[str], state: dict) -> list[str]:
    out = []
    for rule in inv:
        if "=" not in rule:
            continue
        k, want = (x.strip() for x in rule.split("=", 1))
        if k in state and want.lower() not in str(state[k]).lower():
            out.append(f"{k} is {state[k]!r}, invariant says {want!r}")
    return out


def parse_next(spec: str, episode: str) -> tuple[str, str, str]:
    """--next "sc02/s01" (this episode) or "ep02/sc01/s01" -> (episode, scene, shot)."""
    parts = [p for p in spec.strip("/").split("/") if p]
    if len(parts) == 2:
        return episode, parts[0], parts[1]
    if len(parts) == 3:
        return parts[0], parts[1], parts[2]
    raise ValueError(f"--next takes <scene>/<shot> or <episode>/<scene>/<shot>, not {spec!r}")


def check(cont: dict, episode: str, scene: str, shot_ids: list[str], *, next_first: tuple[str, ...] | None = None,
          series_state: bool = False) -> list[dict]:
    """-> findings [{class, from, to, key, detail}] in EDL order. next_first=(scene, shot) or (episode, scene, shot)
    adds the boundary into that shot; series_state (implied when next_first is in another episode) puts the series
    `state` block after this scene's last shot."""
    shots = cont.get("shots") or {}
    walk = [(f"{episode}/{scene}/{s}", shots.get(f"{episode}/{scene}/{s}")) for s in shot_ids]
    nxt = (episode, *next_first) if next_first and len(next_first) == 2 else next_first
    out = []
    if (series_state or (nxt and nxt[0] != episode)) and not isinstance(cont.get("state"), dict):
        out.append({"class": "suspected", "from": "series state", "to": f"{episode}/{scene}", "key": "state",
                    "detail": "story/continuity.json has no series `state` block: the episode handoff is not checked"})
    if nxt and "/".join(nxt) not in shots:
        out.append({"class": "suspected", "from": f"{episode}/{scene}", "to": "/".join(nxt), "key": "next",
                    "detail": f"no continuity entry for {'/'.join(nxt)}: check the --next spelling or add its state"})
    if (series_state or (nxt and nxt[0] != episode)) and isinstance(cont.get("state"), dict):
        after_ep = cont.get("after_episode") or ""
        if after_ep != episode:  # the block describes another episode's end, or no end at all: compare, but say so
            seen = f"after {after_ep}" if after_ep else "not marked with an after_episode"
            out.append({"class": "suspected", "from": "series state", "to": f"{episode}/{scene}", "key": "after_episode",
                        "detail": f"the series state is {seen}, not after {episode}: update story/continuity.json after this episode"})
        walk.append((f"series state after {after_ep or episode}", dict(cont["state"])))
    if nxt:
        walk.append(("/".join(nxt), shots.get("/".join(nxt))))
    known: dict[str, tuple] = {}  # key -> (last value, where it was set, from a before/after entry)
    for k, e in walk:
        if e is None:  # a shot with no continuity entry says nothing: the carried state passes through it
            continue
        before, after, inv = states(e)
        series = k.startswith("series state")
        if not series:  # invariants hold for the carried state too, not only the keys this shot names
            carried = {key: v[0] for key, v in known.items()}
            for d in sorted(set(_invariant_breaks(inv, {**carried, **before})) | set(_invariant_breaks(inv, {**carried, **after}))):
                out.append({"class": "suspected", "from": k, "to": k, "key": d.split(" ", 1)[0], "detail": "invariant: " + d})
            for key in sorted(k2 for k2 in after if k2 not in before and k2 in known):
                # state_after alone moves a carried key: the shot never says where it starts, so the change is unstated
                if after[key] == known[key][0] or key in (e.get("changes") or {}) or _override(e, key):
                    continue
                out.append({"class": "suspected", "from": known[key][1], "to": k, "key": key,
                            "detail": f"{known[key][0]!r} -> {after[key]!r} only in state_after (name it in state_before or changes)"})
        for key in sorted(before):  # an omitted key carries over unchanged; a first mention has nothing to compare
            if key not in known or known[key][0] == before[key]:
                continue
            va, src, structured = known[key]
            vb_ = before[key]
            ov = None if series else _override(e, key)
            if not series and (key in (e.get("changes") or {}) or ov):
                why = (e.get("changes") or {}).get(key) or f"override by {ov['reviewer']}: {ov['reason']}"
                out.append({"class": "allowed", "from": src, "to": k, "key": key, "detail": why})
            elif structured and _structured(e):
                out.append({"class": "definite", "from": src, "to": k, "key": key, "detail": f"{va!r} -> {vb_!r}"})
            else:  # legacy free text and the series summary: wording differs more often than state
                what = "series state" if series or src.startswith("series state") else "legacy entry"
                out.append({"class": "suspected", "from": src, "to": k, "key": key, "detail": f"{va!r} -> {vb_!r} ({what}, check by eye)"})
        for key, v in after.items():
            if series and key in known:
                continue  # the shots outrank the summary: a disagreement was reported above, the next shot meets the last one
            known[key] = (v, k, _structured(e) and not series)
    return out


def summary(findings: list[dict]) -> dict:
    return {c: sum(1 for f in findings if f["class"] == c) for c in CLASSES}
