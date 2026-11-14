"""Validator for the JSON Schema subset used by Atlas tool definitions.

Supported keywords: type, properties, required, additionalProperties (bool), enum,
items, minLength, maxLength, minimum, maximum, minItems, maxItems.
"""

from __future__ import annotations

from typing import Any

_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
    "integer": int,
    "number": (int, float),
    "null": type(None),
}


class ValidationError(ValueError):
    pass


def validate(value: Any, schema: dict, path: str = "$") -> None:
    t = schema.get("type")
    if t is not None:
        types = t if isinstance(t, list) else [t]
        ok = False
        for name in types:
            py = _TYPES[name]
            if name in ("integer", "number") and isinstance(value, bool):
                continue
            if isinstance(value, py):
                ok = True
                break
        if not ok:
            raise ValidationError(f"{path}: expected {t}, got {type(value).__name__}")
    if "enum" in schema and value not in schema["enum"]:
        raise ValidationError(f"{path}: must be one of {schema['enum']}")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            raise ValidationError(f"{path}: shorter than {schema['minLength']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            raise ValidationError(f"{path}: longer than {schema['maxLength']}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            raise ValidationError(f"{path}: below minimum {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            raise ValidationError(f"{path}: above maximum {schema['maximum']}")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            raise ValidationError(f"{path}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            raise ValidationError(f"{path}: more than {schema['maxItems']} items")
        if "items" in schema:
            for i, item in enumerate(value):
                validate(item, schema["items"], f"{path}[{i}]")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for req in schema.get("required", []):
            if req not in value:
                raise ValidationError(f"{path}: missing required property '{req}'")
        if schema.get("additionalProperties") is False:
            extra = set(value) - set(props)
            if extra:
                raise ValidationError(f"{path}: unexpected properties {sorted(extra)}")
        for k, v in value.items():
            if k in props:
                validate(v, props[k], f"{path}.{k}")
