"""Find, validate and compose motion-video style profiles.

Usage:
  python scripts/resolve-style.py find "<words>"            # best matching styles for a request
  python scripts/resolve-style.py resolve data/style.json [--script data/script.json] [--json]
  python scripts/resolve-style.py validate                  # schema + index parity for every profile
  python scripts/resolve-style.py index [--write]           # regenerate references/styles/index.yaml

Profiles live in references/styles/profiles/<id>.yaml; the grammar and the
resolution rules are in references/style-system.md. Needs PyYAML.
Exits 1 on validation or resolution errors.
"""
import argparse
import difflib
import json
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - environment guard
    sys.exit("resolve-style.py needs PyYAML: pip install PyYAML (or uv run --with PyYAML ...)")

SKILL = Path(__file__).resolve().parents[1]
STYLES = SKILL / "references" / "styles"

DIMENSIONS = (
    "palette", "typography", "layout", "material", "texture", "camera", "transitions",
    "pacing", "beat_response", "ui_choreography", "diagrams", "character_motion", "captions", "sound",
)
SCENE_TYPES = {
    "cover", "hook", "title", "stats", "feature", "ui-demo", "product-hero", "spec", "diagram", "chart",
    "terminal", "code", "comparison", "timeline", "montage", "quote", "testimonial", "cta", "outro",
}
FAMILIES = {"aesthetic", "brand-inspired", "house"}
REQUIRED = (
    "id", "name", "family", "aliases", "summary", "energy", "best_for", "character", "dimensions",
    "scene_types", "signature_moves", "strengths", "constraints", "avoid", "pairs_well_with",
)
MAX_LAYERS = 4
FILLER = re.compile(r"\b(style|styled|look|inspired|phong cách|kiểu)\b")


class StyleError(Exception):
    pass


def norm(name):
    """Case-, separator- and filler-insensitive key: "Glass_Keynote style" == "glass keynote" == "glass-keynote"."""
    s = FILLER.sub(" ", str(name).lower())
    return re.sub(r"[-_\s]+", "-", s).strip("-")


def load_profiles(styles=STYLES):
    profiles = {}
    for path in sorted((styles / "profiles").glob("*.yaml")):
        with path.open(encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
        profiles[path.stem] = data if isinstance(data, dict) else {}
    return profiles


def name_table(profiles):
    table = {}
    for pid, p in profiles.items():
        table[norm(pid)] = pid
        for alias in p.get("aliases") or []:
            table.setdefault(norm(alias), pid)
    return table


def lookup(name, profiles):
    """Exact id or alias (case-insensitive); anything else is an error naming the nearest ids."""
    pid = name_table(profiles).get(norm(name))
    if pid:
        return pid
    near = [m["id"] for m in find(name, profiles, limit=3)]
    raise StyleError(f"unknown style {name!r}; nearest: {', '.join(near) or 'none'}")


def find(query, profiles, limit=5):
    q = norm(query)
    exact = name_table(profiles).get(q)
    words = set(re.findall(r"[a-z0-9]+", q))
    ranked = []
    for pid, p in profiles.items():
        names = [pid, p.get("name", "")] + list(p.get("aliases") or [])
        name_score = max(difflib.SequenceMatcher(None, q, norm(n)).ratio() for n in names)
        text = " ".join([p.get("summary", ""), " ".join(p.get("best_for") or []), p.get("character", "")]).lower()
        overlap = len(words & set(re.findall(r"[a-z0-9]+", text))) / max(len(words), 1)
        score = 1.0 if pid == exact else round(0.7 * name_score + 0.3 * overlap, 3)
        ranked.append({"id": pid, "score": score, "summary": p.get("summary", "")})
    ranked.sort(key=lambda r: (-r["score"], r["id"]))
    return ranked[:limit]


def build_index(profiles):
    lines = [
        "# Generated from profiles/*.yaml by `python scripts/resolve-style.py index --write`; do not edit by hand.",
        "# depth: reference = has a detailed style-*.md, profile = profile only.",
        "styles:",
    ]
    for pid, p in sorted(profiles.items(), key=lambda kv: (kv[1].get("family", ""), kv[0])):
        entry = {
            "id": pid,
            "name": p.get("name"),
            "family": p.get("family"),
            "aliases": list(p.get("aliases") or []),
            "energy": p.get("energy"),
            "best_for": list(p.get("best_for") or []),
            "depth": "reference" if p.get("detail") else "profile",
            "summary": p.get("summary"),
        }
        dumped = yaml.safe_dump(entry, sort_keys=False, allow_unicode=True, default_flow_style=None, width=1000)
        body = dumped.rstrip("\n").split("\n")
        lines.append("  - " + body[0])
        lines.extend("    " + line for line in body[1:])
    return "\n".join(lines) + "\n"


def validate(profiles, styles=STYLES, skill=SKILL):
    errors = []
    owners = {}
    for pid, p in profiles.items():
        def err(msg):
            errors.append(f"{pid}: {msg}")

        for key in REQUIRED:
            if key not in p:
                err(f"missing key {key}")
        if p.get("id") != pid:
            err(f"id {p.get('id')!r} does not match file name")
        if p.get("family") not in FAMILIES:
            err(f"family must be one of {sorted(FAMILIES)}")
        if not isinstance(p.get("energy"), int) or not 1 <= p["energy"] <= 5:
            err("energy must be an integer 1-5")
        if not 1 <= len(p.get("best_for") or []) <= 4:
            err("best_for needs 1-4 tags")
        if len(str(p.get("summary", ""))) > 120:
            err("summary longer than 120 characters")
        dims = p.get("dimensions") or {}
        missing, extra = set(DIMENSIONS) - set(dims), set(dims) - set(DIMENSIONS)
        if missing:
            err(f"missing dimensions {sorted(missing)}")
        if extra:
            err(f"unknown dimensions {sorted(extra)}")
        palette = dims.get("palette") or {}
        if palette.get("mode") not in {"dark", "light", "mixed"}:
            err("palette.mode must be dark, light or mixed")
        if not {"bg", "ink", "accent"} <= set(palette.get("colors") or {}):
            err("palette.colors needs bg, ink and accent")
        bpm = (dims.get("pacing") or {}).get("bpm")
        if not (isinstance(bpm, list) and len(bpm) == 2 and all(isinstance(b, int) for b in bpm)
                and 40 <= bpm[0] <= bpm[1] <= 200):
            err("pacing.bpm must be [lo, hi] integers within 40-200")
        for dim in set(DIMENSIONS) - {"palette", "pacing"}:
            value = dims.get(dim)
            if dim in dims and not (isinstance(value, list) and value and all(isinstance(v, str) for v in value)):
                err(f"dimension {dim} must be a non-empty list of strings")
        scene_types = p.get("scene_types") or {}
        for bucket in ("prefer", "avoid"):
            unknown = set(scene_types.get(bucket) or []) - SCENE_TYPES
            if unknown:
                err(f"scene_types.{bucket} has unknown types {sorted(unknown)}")
        for other in p.get("pairs_well_with") or []:
            if other not in profiles:
                err(f"pairs_well_with names unknown style {other!r}")
        detail = p.get("detail")
        if detail and not (skill / detail).is_file():
            err(f"detail file {detail} not found")
        for name in [pid] + list(p.get("aliases") or []):
            key = norm(name)
            if not key:
                err(f"name {name!r} is empty once filler words are removed")
                continue
            if key in owners and owners[key] != pid:
                err(f"name {name!r} collides with {owners[key]}")
            owners.setdefault(key, pid)
    index = styles / "index.yaml"
    if not index.is_file() or index.read_text(encoding="utf-8") != build_index(profiles):
        errors.append("index.yaml is stale: run `python scripts/resolve-style.py index --write`")
    return errors


SPEC_KEYS = {"base", "layers", "scenes"}
LAYER_KEYS = {"style", "dimensions", "scenes", "palette_mode"}
SELECTOR_KEYS = {"ids", "types"}
PALETTE_MODES = {"accent", "full"}


def scene_list(spec, script):
    """Spec-level `scenes` (drafts) win over the script's scenes."""
    scenes = spec.get("scenes") or (script or {}).get("scenes") or []
    if not isinstance(scenes, list):
        raise StyleError("scenes must be a list of {id, type}")
    out = []
    for s in scenes:
        if isinstance(s, dict) and s.get("id"):
            if s.get("type") is not None and s["type"] not in SCENE_TYPES:
                raise StyleError(f"scene {s['id']}: unknown type {s['type']!r}; use one of {sorted(SCENE_TYPES)}")
            out.append({"id": s["id"], "type": s.get("type")})
    return out


def check_selector(selector, where):
    if selector is None:
        return
    if not isinstance(selector, dict) or not selector or set(selector) - SELECTOR_KEYS:
        raise StyleError(f"{where}: scenes must be an object with `ids` and/or `types` lists")
    for key in selector:
        if not isinstance(selector[key], list) or not all(isinstance(v, str) for v in selector[key]):
            raise StyleError(f"{where}: scenes.{key} must be a list of strings")
    unknown = set(selector.get("types") or []) - SCENE_TYPES
    if unknown:
        raise StyleError(f"{where}: unknown scene types {sorted(unknown)}; use one of {sorted(SCENE_TYPES)}")


def selects(selector, scene):
    if not selector:
        return True
    ids = selector.get("ids") or []
    prefix = scene["id"].split("-", 1)[0]
    return scene["id"] in ids or prefix in ids or (scene["type"] in (selector.get("types") or []))


def resolve(spec, profiles, script=None):
    if not isinstance(spec, dict) or not spec.get("base"):
        raise StyleError("composition spec needs a base style")
    extra = set(spec) - SPEC_KEYS
    if extra:
        raise StyleError(f"unknown spec keys {sorted(extra)}; allowed: {sorted(SPEC_KEYS)}")
    base = lookup(spec["base"], profiles)
    layers = spec.get("layers") or []
    if not isinstance(layers, list):
        raise StyleError("layers must be a list")
    if len(layers) > MAX_LAYERS:
        raise StyleError(f"{len(layers)} layers; at most {MAX_LAYERS} are allowed")
    scenes = scene_list(spec, script) or [{"id": "(whole video)", "type": None}]
    warnings, resolved_layers = [], []
    for i, layer in enumerate(layers, 1):
        if not isinstance(layer, dict) or not layer.get("style"):
            raise StyleError(f"layer {i}: must be an object with a style")
        extra = set(layer) - LAYER_KEYS
        if extra:
            raise StyleError(f"layer {i}: unknown keys {sorted(extra)}; allowed: {sorted(LAYER_KEYS)}")
        sid = lookup(layer["style"], profiles)
        dims = layer.get("dimensions")
        if not isinstance(dims, list) or not dims or any(d not in DIMENSIONS for d in dims):
            raise StyleError(f"layer {i} ({sid}): dimensions must be a non-empty subset of {list(DIMENSIONS)}; got {dims}")
        palette_mode = layer.get("palette_mode", "accent")
        if palette_mode not in PALETTE_MODES:
            raise StyleError(f"layer {i} ({sid}): palette_mode must be one of {sorted(PALETTE_MODES)}")
        selector = layer.get("scenes")
        check_selector(selector, f"layer {i} ({sid})")
        hit = [s["id"] for s in scenes if selects(selector, s)]
        if not hit:
            warnings.append(f"layer {i} ({sid}) selects no scene; pass --script or list the scenes")
        resolved_layers.append({"style": sid, "dimensions": dims, "scenes": hit, "palette_mode": palette_mode})
    rows = []
    for scene in scenes:
        dims = {d: base for d in DIMENSIONS}
        for layer in resolved_layers:
            if scene["id"] in layer["scenes"]:
                for d in layer["dimensions"]:
                    dims[d] = layer["style"] if (d != "palette" or layer["palette_mode"] == "full") \
                        else f"{base} + {layer['style']} accents"
        rows.append({"id": scene["id"], "type": scene["type"], "dimensions": dims})
    transition_sources = {r["dimensions"]["transitions"] for r in rows}
    if len(transition_sources) > 2:
        warnings.append(f"{len(transition_sources)} transition languages in one video ({', '.join(sorted(transition_sources))}); keep it to 2")
    constraints = [{"style": base, "scenes": "all", "rules": profiles[base].get("constraints") or []}]
    constraints += [{"style": l["style"], "scenes": l["scenes"], "rules": profiles[l["style"]].get("constraints") or []}
                    for l in resolved_layers if l["scenes"]]
    return {"base": base, "layers": resolved_layers, "scenes": rows, "constraints": constraints,
            "detail": profiles[base].get("detail"), "warnings": warnings}


def render_table(result):
    changed = [d for d in DIMENSIONS if any(r["dimensions"][d] != result["base"] for r in result["scenes"])]
    out = [f"Base: {result['base']}" + (f" (detail: {result['detail']})" if result["detail"] else "")]
    if changed:
        out.append("")
        out.append("| scene | type | " + " | ".join(changed) + " |")
        out.append("|---|---|" + "---|" * len(changed))
        for r in result["scenes"]:
            cells = [r["dimensions"][d] if r["dimensions"][d] != result["base"] else "base" for d in changed]
            out.append(f"| {r['id']} | {r['type'] or '-'} | " + " | ".join(cells) + " |")
        out.append("")
        out.append("Every dimension not shown comes from the base in every scene.")
    else:
        out.append("No layers: every dimension comes from the base.")
    out.append("")
    out.append("Binding constraints (plus the invariant layer in style-system.md):")
    for c in result["constraints"]:
        where = "all scenes" if c["scenes"] == "all" else ", ".join(c["scenes"]) or "no scene"
        for rule in c["rules"]:
            out.append(f"- [{c['style']} | {where}] {rule}")
    for w in result["warnings"]:
        out.append(f"WARNING: {w}")
    return "\n".join(out)


def read_data(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return yaml.safe_load(fh)
    except OSError as exc:
        raise StyleError(f"cannot read {path}: {exc.strerror}") from exc
    except yaml.YAMLError as exc:
        raise StyleError(f"cannot parse {path}: {exc}") from exc


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("find")
    f.add_argument("query", nargs="+")
    r = sub.add_parser("resolve")
    r.add_argument("spec")
    r.add_argument("--script")
    r.add_argument("--json", action="store_true")
    sub.add_parser("validate")
    i = sub.add_parser("index")
    i.add_argument("--write", action="store_true")
    args = ap.parse_args(argv)
    profiles = load_profiles()
    try:
        if args.cmd == "find":
            for m in find(" ".join(args.query), profiles):
                print(f"{m['score']:.3f}  {m['id']:<28} {m['summary']}")
        elif args.cmd == "resolve":
            script = read_data(args.script) if args.script else None
            result = resolve(read_data(args.spec), profiles, script)
            print(json.dumps(result, indent=2, ensure_ascii=False) if args.json else render_table(result))
        elif args.cmd == "validate":
            errors = validate(profiles)
            for e in errors:
                print(f"ERROR: {e}")
            print(f"{len(profiles)} profiles, {len(errors)} errors")
            return 1 if errors else 0
        elif args.cmd == "index":
            text = build_index(profiles)
            if args.write:
                (STYLES / "index.yaml").write_text(text, encoding="utf-8", newline="\n")
                print(f"wrote {STYLES / 'index.yaml'} ({len(profiles)} styles)")
            else:
                sys.stdout.write(text)
    except StyleError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
