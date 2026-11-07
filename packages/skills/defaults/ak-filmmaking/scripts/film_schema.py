"""Validate production-graph JSON against the bundled schemas (standard library only).

The schemas in ../schemas are the executable contract, so this module implements
the JSON Schema subset they use instead of pulling in a third-party validator:
$ref (local and sibling-file), type, const, enum, pattern, minLength, minimum,
exclusiveMinimum, maximum, required, properties, additionalProperties, items,
minItems, uniqueItems and anyOf. An unsupported keyword raises instead of being
silently ignored, so a schema edit cannot weaken validation unnoticed.
"""

import json
import math
import re
from pathlib import Path

SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schemas"

_ANNOTATIONS = {"$schema", "$id", "$defs", "title", "description"}
_SUPPORTED = _ANNOTATIONS | {
    "$ref", "type", "const", "enum", "pattern", "minLength", "minimum", "exclusiveMinimum",
    "maximum", "required", "properties", "additionalProperties", "items", "minItems",
    "uniqueItems", "anyOf",
}


class SchemaError(Exception):
    """The schema itself is malformed or uses an unsupported keyword."""


def load_json(path):
    """Parse JSON strictly: duplicate keys and NaN/Infinity are rejected."""

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate key {key!r}")
            result[key] = value
        return result

    def reject_constant(name):
        raise ValueError(f"non-finite number {name} is not valid JSON")

    with Path(path).open(encoding="utf-8") as handle:
        return json.load(handle, object_pairs_hook=unique, parse_constant=reject_constant)


class SchemaSet:
    """Loads schema documents lazily from one directory and validates instances."""

    def __init__(self, directory=SCHEMA_DIR):
        self.directory = Path(directory)
        self._docs = {}

    def document(self, name):
        if name not in self._docs:
            path = self.directory / name
            if not path.is_file():
                raise SchemaError(f"schema {name} not found in {self.directory}")
            self._docs[name] = load_json(path)
        return self._docs[name]

    def validate(self, instance, schema_name):
        """Return a list of 'json/pointer: message' strings; empty means valid."""
        errors = []
        self._check(instance, self.document(schema_name), schema_name, "", errors)
        return errors

    def _resolve(self, ref, doc_name):
        file_part, _, pointer = ref.partition("#")
        target_doc = file_part or doc_name
        node = self.document(target_doc)
        for token in [t for t in pointer.split("/") if t]:
            token = token.replace("~1", "/").replace("~0", "~")
            if not isinstance(node, dict) or token not in node:
                raise SchemaError(f"unresolvable $ref {ref!r} from {doc_name}")
            node = node[token]
        return node, target_doc

    def _check(self, value, schema, doc, where, errors):
        unknown = set(schema) - _SUPPORTED
        if unknown:
            raise SchemaError(f"{doc}: unsupported keyword(s) {sorted(unknown)} at {where or '/'}")
        label = where or "/"
        if "$ref" in schema:
            target, target_doc = self._resolve(schema["$ref"], doc)
            self._check(value, target, target_doc, where, errors)
        if "anyOf" in schema:
            if not any(not self._collect(value, option, doc, where) for option in schema["anyOf"]):
                errors.append(f"{label}: does not match any allowed form")
        if "type" in schema and not _type_ok(value, schema["type"]):
            errors.append(f"{label}: expected {schema['type']}, got {_type_name(value)}")
            return
        if "const" in schema and value != schema["const"]:
            errors.append(f"{label}: must equal {schema['const']!r}")
        if "enum" in schema and value not in schema["enum"]:
            errors.append(f"{label}: {value!r} is not one of {schema['enum']}")
        if isinstance(value, str):
            if len(value) < schema.get("minLength", 0):
                errors.append(f"{label}: shorter than {schema['minLength']} characters")
            if "pattern" in schema and not re.search(schema["pattern"], value):
                errors.append(f"{label}: {value!r} does not match the required pattern")
        if _is_number(value):
            if "minimum" in schema and value < schema["minimum"]:
                errors.append(f"{label}: {value} is below the minimum {schema['minimum']}")
            if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
                errors.append(f"{label}: {value} must be greater than {schema['exclusiveMinimum']}")
            if "maximum" in schema and value > schema["maximum"]:
                errors.append(f"{label}: {value} exceeds the maximum {schema['maximum']}")
        if isinstance(value, list):
            self._check_array(value, schema, doc, where, errors)
        if isinstance(value, dict):
            self._check_object(value, schema, doc, where, errors)

    def _collect(self, value, schema, doc, where):
        found = []
        self._check(value, schema, doc, where, found)
        return found

    def _check_array(self, value, schema, doc, where, errors):
        label = where or "/"
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{label}: needs at least {schema['minItems']} item(s)")
        if schema.get("uniqueItems"):
            seen = [json.dumps(item, sort_keys=True) for item in value]
            if len(seen) != len(set(seen)):
                errors.append(f"{label}: items must be unique")
        if "items" in schema:
            for index, item in enumerate(value):
                self._check(item, schema["items"], doc, f"{where}/{index}", errors)

    def _check_object(self, value, schema, doc, where, errors):
        label = where or "/"
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{label}: missing required field {key!r}")
        properties = schema.get("properties", {})
        extra = schema.get("additionalProperties", True)
        for key, item in value.items():
            path = f"{where}/{key}"
            if key in properties:
                self._check(item, properties[key], doc, path, errors)
            elif extra is False:
                errors.append(f"{label}: unknown field {key!r}")
            elif isinstance(extra, dict):
                self._check(item, extra, doc, path, errors)


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _type_name(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number" if math.isfinite(value) else "non-finite number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    return "object"


def _type_ok(value, expected):
    if isinstance(expected, list):
        return any(_type_ok(value, option) for option in expected)
    actual = _type_name(value)
    if expected == "number":
        return actual in ("integer", "number")
    return actual == expected
