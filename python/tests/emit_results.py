"""Execute language-neutral fixtures for the TypeScript/Python parity check."""

import json
from pathlib import Path
from typing import Any

from i5_units import (
    Quantity,
    UnitError,
    add_units,
    convert,
    convert_and_validate,
    divide_units,
    list_units,
    multiply_units,
    possibilities,
    power_unit,
    qty,
    registry_fingerprint,
    subtract_units,
)

FIXTURES = json.loads(
    (Path(__file__).parents[2] / "spec" / "fixtures.json").read_text(encoding="utf-8")
)


def evaluate(expression: dict[str, Any]) -> Quantity:
    """Evaluate a language-neutral quantity expression."""
    if "op" in expression:
        left = evaluate(expression["left"])
        if expression["op"] == "pow":
            result = left.pow(expression["exponent"])
        else:
            result = getattr(left, expression["op"])(evaluate(expression["right"]))
    else:
        result = qty(expression["value"], expression["units"])
    return result.to(expression["to"]) if "to" in expression else result


def analyze_fixture(fixture: dict[str, Any]) -> dict[str, Any]:
    """Run a magnitude-independent operation and produce a JSON signature."""
    operations = {
        "divide": divide_units,
        "multiply": multiply_units,
        "add": add_units,
        "subtract": subtract_units,
    }
    result = (
        power_unit(fixture["left"], fixture["exponent"])
        if fixture["op"] == "power"
        else operations[fixture["op"]](fixture["left"], fixture["right"])
    )
    return {
        "dimensions": dict(result.dimensions),
        "measure": result.measure,
        "unit": result.unit,
        "kind": result.kind,
        "candidates": list(result.candidates),
    }


def emit_results() -> dict[str, Any]:
    """Return inventory, computed values, and error codes for parity testing."""
    failures = []
    for fixture in FIXTURES["failures"]:
        try:
            evaluate(fixture["expression"]).to_dict()
        except UnitError as error:
            failures.append(error.code)
        else:
            failures.append(None)
    constraints = []
    for fixture in FIXTURES["constraints"]:
        try:
            constraints.append(
                {
                    "value": convert_and_validate(
                        fixture["value"],
                        fixture["from"],
                        fixture["to"],
                        fixture["constraints"],
                    )
                }
            )
        except UnitError as error:
            constraints.append({"code": error.code})
    return {
        "fingerprint": registry_fingerprint,
        "constraints": constraints,
        "analyses": [analyze_fixture(fixture) for fixture in FIXTURES["analyses"]],
        "units": possibilities(),
        "descriptions": list_units(),
        "conversions": [
            convert(fixture["value"]).from_(fixture["from"]).to(fixture["to"])
            for fixture in FIXTURES["conversions"]
        ],
        "quantities": [
            evaluate(fixture["expression"]).to_dict()
            for fixture in FIXTURES["quantities"]
        ],
        "failures": failures,
    }


if __name__ == "__main__":
    print(json.dumps(emit_results(), ensure_ascii=False, allow_nan=False))
