"""Canonical units, exact conversion coefficients, and dimensional analysis."""

from __future__ import annotations

import builtins
import json
import math
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from fractions import Fraction
from functools import cache
from importlib.resources import files
from types import MappingProxyType
from typing import Any, TypeGuard

from . import rational as r
from .errors import UnitError
from .rational import MAX_RATIONAL_BITS
from .types_generated import Unit

__all__ = [
    "ConversionPlan",
    "Converter",
    "Dimensions",
    "Quantity",
    "Unit",
    "UnitAnalysis",
    "UnitError",
    "MAX_RATIONAL_BITS",
    "add_units",
    "analyze_dimensions",
    "analyze_unit",
    "can_convert",
    "conversion_plan",
    "convert",
    "convert_and_validate",
    "describe",
    "divide_units",
    "has_unit",
    "list_units",
    "measures",
    "multiply_units",
    "parse_measure",
    "parse_unit",
    "possibilities",
    "power_unit",
    "qty",
    "registry_fingerprint",
    "registry_format_version",
    "registry_version",
    "subtract_units",
    "validate_numeric",
]

_registry = json.loads(
    files(__package__).joinpath("registry.generated.json").read_text(encoding="utf-8")
)
registry_version: str = _registry["version"]
registry_fingerprint: str = _registry["fingerprint"]
registry_format_version: int = _registry["format_version"]
Dimensions = Mapping[str, int]
_MAX_SAFE_INTEGER = 2**53 - 1


def _finite(value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise UnitError("INVALID_VALUE", "Quantity values must be finite numbers")
    try:
        result = float(value)
    except OverflowError as error:
        raise UnitError(
            "INVALID_VALUE", "Quantity value exceeds finite range"
        ) from error
    if not math.isfinite(result):
        raise UnitError("INVALID_VALUE", "Quantity values and results must be finite")
    return result


def _float(value: Fraction) -> float:
    r.checked(value)
    try:
        return _finite(float(value))
    except OverflowError as error:
        raise UnitError(
            "INVALID_VALUE", "Quantity result exceeds finite range"
        ) from error


def has_unit(unit: object) -> TypeGuard[Unit]:
    """Return whether the exact spelling is registered."""
    return isinstance(unit, str) and unit in _registry["units"]


def parse_unit(input: object) -> Unit:
    """Validate an external string and return its canonical typed unit."""
    if not has_unit(input):
        raise UnitError("UNKNOWN_UNIT", f"Unknown unit {input!r}")
    return input


def parse_measure(input: object) -> str:
    """Validate an external measure name."""
    if not isinstance(input, str) or input not in _registry["measures"]:
        raise UnitError("UNKNOWN_MEASURE", f"Unknown measure {input!r}")
    return input


def _unit(unit: Unit) -> dict[str, Any]:
    return _registry["units"][parse_unit(unit)]


@cache
def _exact(unit: Unit) -> tuple[Fraction, Fraction]:
    definition = _unit(unit)
    return r.from_wire(definition["scale_ratio"]), r.from_wire(
        definition["offset_ratio"]
    )


def describe(unit: Unit) -> dict[str, Any]:
    """Return unit metadata, including its coherent scale, offset, and kind."""
    definition = _unit(unit)
    measure = _registry["measures"][definition["measure"]]
    result = {
        "abbr": unit,
        "measure": definition["measure"],
        "system": definition["system"],
        "singular": definition["name"]["singular"],
        "plural": definition["name"]["plural"],
        "dimensions": dict(measure["dimensions"]),
        "reference_unit": measure["reference_unit"],
        "kind": measure["kind"],
        "scale": definition["scale"],
        "offset": definition["offset"],
    }
    for key in ("prefix", "base_unit", "components"):
        if key in definition:
            result[key] = (
                dict(definition[key]) if key == "components" else definition[key]
            )
    return result


def measures() -> list[str]:
    """List all registered measures."""
    return list(_registry["measures"])


def list_units(measure: str | None = None) -> list[dict[str, Any]]:
    """List metadata for all units, optionally restricted to one measure."""
    if measure is not None:
        parse_measure(measure)
    return [
        describe(parse_unit(symbol))
        for symbol, definition in _registry["units"].items()
        if measure is None or definition["measure"] == measure
    ]


def possibilities(measure: str | None = None) -> list[Unit]:
    """List canonical spellings for a measure, or for the entire registry."""
    return [unit["abbr"] for unit in list_units(measure)]


def can_convert(source: object, target: object) -> bool:
    """Return whether registered units belong to the same measure."""
    return (
        has_unit(source)
        and has_unit(target)
        and _unit(source)["measure"] == _unit(target)["measure"]
    )


@dataclass(frozen=True)
class ConversionPlan:
    """A precomputed unit pair with exact affine conversion coefficients."""

    source: Unit
    target: Unit
    _scale: Fraction
    _offset: Fraction

    @property
    def scale_ratio(self) -> dict[str, str]:
        """Return the exact multiplicative coefficient."""
        return r.to_wire(self._scale)

    @property
    def offset_ratio(self) -> dict[str, str]:
        """Return the exact additive coefficient."""
        return r.to_wire(self._offset)

    def convert(self, value: float) -> float:
        """Convert a value, rounding only the final result to a float."""
        value = _finite(value)
        if self.source == self.target:
            return value
        return _float(r.add(r.multiply(Fraction(value), self._scale), self._offset))


def conversion_plan(source: Unit, target: Unit) -> ConversionPlan:
    """Resolve a fixed unit pair without requiring a numeric magnitude."""
    origin_scale, origin_offset = _exact(source)
    target_scale, target_offset = _exact(target)
    if not can_convert(source, target):
        raise UnitError("INCOMPATIBLE_UNITS", f"Cannot convert {source} to {target}")
    return ConversionPlan(
        source,
        target,
        r.divide(origin_scale, target_scale),
        r.divide(r.subtract(origin_offset, target_offset), target_scale),
    )


@dataclass(frozen=True)
class Converter:
    """A reusable fluent conversion request."""

    _amount: float = 0
    _source: Unit | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "_amount", _finite(self._amount))
        if self._source is not None:
            parse_unit(self._source)

    def from_(self, source: Unit) -> Converter:
        """Select a source unit, preserving the original request."""
        parse_unit(source)
        return Converter(self._amount, source)

    def to(self, target: Unit) -> float:
        """Convert to a registered unit in the same measure."""
        if self._source is None:
            raise UnitError("INVALID_OPERATION", "Call from_ before to")
        return conversion_plan(self._source, target).convert(self._amount)

    def describe(self, unit: Unit) -> dict[str, Any]:
        """Return metadata for a registered unit."""
        return describe(unit)

    def list(self, measure: str | None = None) -> builtins.list[dict[str, Any]]:
        """List metadata for registered units."""
        return list_units(measure)

    def measures(self) -> builtins.list[str]:
        """List registered measures."""
        return measures()

    def possibilities(self, measure: str | None = None) -> builtins.list[Unit]:
        """List units for the selected source measure, or all units."""
        if measure is None and self._source is not None:
            measure = _unit(self._source)["measure"]
        return possibilities(measure)


def convert(value: float = 0) -> Converter:
    """Start a fluent conversion request."""
    return Converter(value)


def _near(a: Fraction, b: Fraction) -> bool:
    """Compare the documented tolerance without rounded quotient intermediates."""
    tolerance = min(
        Fraction(1e-9),
        Fraction(4 * sys.float_info.epsilon) * max(abs(a), abs(b)),
    )
    return abs(a - b) <= tolerance


def validate_numeric(
    value: float, constraints: Mapping[str, Any] | None = None
) -> float:
    """Validate exactly, then normalize only candidates satisfying every constraint.

    Multiple indices and tolerance comparisons stay rational so floating-point
    division cannot turn a nonzero index into zero or a valid index into infinity.
    Valid values retain their original representation, including values close to
    an inclusive boundary that is also excluded by another constraint.
    """
    value = _finite(value)
    constraints = dict(constraints or {})
    allowed = {
        "integer",
        "minimum",
        "maximum",
        "exclusive_minimum",
        "exclusive_maximum",
        "multiple_of",
    }
    for key, boundary in constraints.items():
        if key not in allowed:
            raise UnitError("INVALID_OPERATION", f"Unknown constraint {key}")
        if key == "integer":
            if not isinstance(boundary, bool):
                raise UnitError("INVALID_OPERATION", "integer must be boolean")
        else:
            constraints[key] = _finite(boundary)
    integer = constraints.get("integer", False)
    multiple = constraints.get("multiple_of")
    minimum, maximum = constraints.get("minimum"), constraints.get("maximum")
    if multiple is not None and multiple <= 0:
        raise UnitError("INVALID_OPERATION", "multiple_of must be positive")
    if minimum is not None and maximum is not None and minimum > maximum:
        raise UnitError("INVALID_OPERATION", "minimum must not exceed maximum")
    boundaries = {
        key: Fraction(boundary)
        for key, boundary in constraints.items()
        if key != "integer"
    }
    exact_multiple = boundaries.get("multiple_of")

    def satisfies(candidate: Fraction) -> bool:
        if integer and (
            candidate.denominator != 1 or abs(candidate) > _MAX_SAFE_INTEGER
        ):
            return False
        if "minimum" in boundaries and candidate < boundaries["minimum"]:
            return False
        if "maximum" in boundaries and candidate > boundaries["maximum"]:
            return False
        if (
            "exclusive_minimum" in boundaries
            and candidate <= boundaries["exclusive_minimum"]
        ):
            return False
        if (
            "exclusive_maximum" in boundaries
            and candidate >= boundaries["exclusive_maximum"]
        ):
            return False
        if exact_multiple is not None:
            index = candidate / exact_multiple
            if not _near(index, Fraction(round(index))):
                return False
        return True

    original = Fraction(value)
    if satisfies(original):
        return value

    candidates = []
    if integer:
        rounded = Fraction(round(original))
        if _near(original, rounded):
            candidates.append(rounded)
    if exact_multiple is not None:
        index = original / exact_multiple
        rounded_index = Fraction(round(index))
        if _near(index, rounded_index):
            candidates.append(rounded_index * exact_multiple)
    for key in ("minimum", "maximum"):
        if key in boundaries and _near(original, boundaries[key]):
            candidates.append(boundaries[key])

    for candidate in candidates:
        try:
            rounded_value = _float(candidate)
        except UnitError:
            continue
        if satisfies(Fraction(rounded_value)):
            return rounded_value
    raise UnitError(
        "CONSTRAINT_VIOLATION", "Converted value violates destination constraints"
    )


def convert_and_validate(
    value: float,
    source: Unit,
    target: Unit,
    constraints: Mapping[str, Any] | None = None,
) -> float:
    """Convert first, then validate constraints expressed in destination units."""
    return validate_numeric(conversion_plan(source, target).convert(value), constraints)


def _checked(dimensions: Dimensions) -> Dimensions:
    result = {}
    for key, exponent in dimensions.items():
        if (
            key not in _registry["dimensions"]
            or isinstance(exponent, bool)
            or not isinstance(exponent, int)
            or abs(exponent) > _MAX_SAFE_INTEGER
        ):
            raise UnitError(
                "INVALID_OPERATION",
                "Dimensions require known names and safe integer exponents",
            )
        if exponent:
            result[key] = exponent
    return MappingProxyType(result)


def _combine(a: Dimensions, b: Dimensions, sign: int) -> Dimensions:
    return _checked(
        {
            dimension: a.get(dimension, 0) + sign * b.get(dimension, 0)
            for dimension in _registry["dimensions"]
        }
    )


@dataclass(frozen=True)
class UnitAnalysis:
    """A magnitude-independent dimensional signature for compiler use."""

    dimensions: Dimensions
    measure: str | None
    unit: Unit | None
    kind: str | None
    candidates: tuple[str, ...]


def analyze_dimensions(dimensions: Dimensions) -> UnitAnalysis:
    """Resolve only explicitly designated default arithmetic measures."""
    dimensions = _checked(dimensions)
    candidates = tuple(
        name
        for name, definition in _registry["measures"].items()
        if definition["kind"] != "absolute" and definition["dimensions"] == dimensions
    )
    measure = next(
        (name for name in candidates if _registry["measures"][name]["default_result"]),
        None,
    )
    return UnitAnalysis(
        dimensions,
        measure,
        _registry["measures"][measure]["reference_unit"] if measure else None,
        _registry["measures"][measure]["kind"] if measure else None,
        candidates,
    )


def analyze_unit(unit: Unit) -> UnitAnalysis:
    """Describe a unit as a magnitude-independent dimensional signature."""
    description = describe(unit)
    result = analyze_dimensions(description["dimensions"])
    return UnitAnalysis(
        result.dimensions,
        description["measure"],
        unit,
        description["kind"],
        result.candidates,
    )


Operand = Unit | UnitAnalysis


def _analysis(operand: Operand) -> UnitAnalysis:
    return (
        operand
        if isinstance(operand, UnitAnalysis)
        else analyze_unit(parse_unit(operand))
    )


def _product_analysis(left: Operand, right: Operand, divide: bool) -> UnitAnalysis:
    a, b = _analysis(left), _analysis(right)
    if a.kind == "absolute" or b.kind == "absolute":
        raise UnitError("INVALID_OPERATION", "Use temperature differences")
    result = analyze_dimensions(
        _combine(a.dimensions, b.dimensions, -1 if divide else 1)
    )
    preserved = (
        a if not b.dimensions else b if not divide and not a.dimensions else None
    )
    if preserved and preserved.measure:
        return UnitAnalysis(
            result.dimensions,
            preserved.measure,
            _registry["measures"][preserved.measure]["reference_unit"],
            preserved.kind,
            result.candidates,
        )
    return result


def multiply_units(left: Operand, right: Operand) -> UnitAnalysis:
    """Add dimensional exponents without evaluating numeric values."""
    return _product_analysis(left, right, False)


def divide_units(left: Operand, right: Operand) -> UnitAnalysis:
    """Subtract dimensional exponents without evaluating numeric values."""
    return _product_analysis(left, right, True)


def power_unit(unit: Operand, exponent: float) -> UnitAnalysis:
    """Multiply dimensional exponents by a safe integer."""
    result = _analysis(unit)
    if (
        isinstance(exponent, bool)
        or not isinstance(exponent, (int, float))
        or abs(exponent) > _MAX_SAFE_INTEGER
        or not math.isfinite(exponent)
        or int(exponent) != exponent
        or result.kind == "absolute"
    ):
        raise UnitError(
            "INVALID_OPERATION",
            "Powers require an integer exponent and a non-absolute quantity",
        )
    return (
        result
        if exponent == 1
        else analyze_dimensions(_combine({}, result.dimensions, int(exponent)))
    )


def _sum_analysis(left: Operand, right: Operand, subtract: bool) -> UnitAnalysis:
    a, b = _analysis(left), _analysis(right)
    if a.dimensions != b.dimensions:
        raise UnitError("INCOMPATIBLE_UNITS", "Addition requires matching dimensions")
    if a.kind == "absolute" and b.kind == "absolute" and a.measure == b.measure:
        if not subtract:
            raise UnitError("INVALID_OPERATION", "Cannot add two absolute temperatures")
        return analyze_dimensions(a.dimensions)
    if a.kind == "absolute" and b.kind == "difference":
        return a
    if a.kind == "difference" and b.kind == "absolute" and not subtract:
        return b
    if a.measure is not None and b.measure is not None and a.measure != b.measure:
        raise UnitError("INCOMPATIBLE_UNITS", "Addition requires matching measures")
    return a if a.measure else b


def add_units(left: Operand, right: Operand) -> UnitAnalysis:
    """Check addition compatibility independently of magnitudes."""
    return _sum_analysis(left, right, False)


def subtract_units(left: Operand, right: Operand) -> UnitAnalysis:
    """Check subtraction compatibility independently of magnitudes."""
    return _sum_analysis(left, right, True)


@dataclass(frozen=True, init=False)
class Quantity:
    """An immutable quantity with exact internal reference magnitude."""

    _base_value: Fraction
    dimensions: Dimensions
    measure: str | None
    units: Unit | None

    def __init__(self, value: float, unit: Unit) -> None:
        metadata = analyze_unit(unit)
        scale, offset = _exact(unit)
        object.__setattr__(
            self,
            "_base_value",
            r.add(r.multiply(Fraction(_finite(value)), scale), offset),
        )
        object.__setattr__(self, "dimensions", metadata.dimensions)
        object.__setattr__(self, "measure", metadata.measure)
        object.__setattr__(self, "units", unit)

    @classmethod
    def _from_base(cls, value: Fraction, metadata: UnitAnalysis) -> Quantity:
        result = object.__new__(cls)
        object.__setattr__(result, "_base_value", value)
        object.__setattr__(result, "dimensions", metadata.dimensions)
        object.__setattr__(result, "measure", metadata.measure)
        object.__setattr__(result, "units", metadata.unit)
        if result.units:
            _ = result.value
        return result

    @property
    def value(self) -> float:
        """Return a magnitude, rounding only the final selected representation."""
        if self.units is None:
            raise UnitError("UNRESOLVED_UNIT", "Choose a result unit with to(unit)")
        scale, offset = _exact(self.units)
        return _float(r.divide(r.subtract(self._base_value, offset), scale))

    def _metadata(self) -> UnitAnalysis:
        return (
            analyze_unit(self.units)
            if self.units
            else analyze_dimensions(self.dimensions)
        )

    def to(self, target: Unit) -> Quantity:
        """Select a compatible registered result unit without mutating self."""
        metadata = analyze_unit(target)
        if self.dimensions != metadata.dimensions or (
            self.measure is not None and self.measure != metadata.measure
        ):
            raise UnitError(
                "INCOMPATIBLE_UNITS", f"Cannot express quantity in {target}"
            )
        return self._from_base(self._base_value, metadata)

    def add(self, other: Quantity) -> Quantity:
        """Add compatible magnitudes in exact reference units."""
        return self._from_base(
            r.add(self._base_value, other._base_value),
            add_units(self._metadata(), other._metadata()),
        )

    def subtract(self, other: Quantity) -> Quantity:
        """Subtract compatible magnitudes in exact reference units."""
        return self._from_base(
            r.subtract(self._base_value, other._base_value),
            subtract_units(self._metadata(), other._metadata()),
        )

    def multiply(self, other: Quantity) -> Quantity:
        """Multiply magnitudes and add dimensional exponents."""
        return self._from_base(
            r.multiply(self._base_value, other._base_value),
            multiply_units(self._metadata(), other._metadata()),
        )

    def divide(self, other: Quantity) -> Quantity:
        """Divide magnitudes and subtract dimensional exponents."""
        if other._base_value == 0:
            raise UnitError("INVALID_OPERATION", "Cannot divide by zero")
        return self._from_base(
            r.divide(self._base_value, other._base_value),
            divide_units(self._metadata(), other._metadata()),
        )

    def pow(self, exponent: float) -> Quantity:
        """Raise a non-absolute quantity to a safe integer power."""
        metadata = power_unit(self._metadata(), exponent)
        exponent = int(exponent)
        try:
            value = r.power(self._base_value, exponent)
        except ZeroDivisionError as error:
            raise UnitError("INVALID_VALUE", "Cannot divide by zero") from error
        return self._from_base(value, metadata)

    def to_dict(self) -> dict[str, Any]:
        """Serialize the i5 value/units wrapper, requiring a registered unit."""
        return {"value": self.value, "units": self.units}

    def __add__(self, other: Quantity) -> Quantity:
        return self.add(other)

    def __sub__(self, other: Quantity) -> Quantity:
        return self.subtract(other)

    def __mul__(self, other: Quantity) -> Quantity:
        return self.multiply(other)

    def __truediv__(self, other: Quantity) -> Quantity:
        return self.divide(other)

    def __pow__(self, exponent: float) -> Quantity:
        return self.pow(exponent)


def qty(value: float, unit: Unit) -> Quantity:
    """Create a quantity from a finite value and a canonical typed unit."""
    return Quantity(value, unit)
