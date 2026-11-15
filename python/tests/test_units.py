"""Shared conversion and dimensional-arithmetic behavior and Python APIs."""

import json
import math
import random
from dataclasses import FrozenInstanceError
from fractions import Fraction
from pathlib import Path

import pytest
from emit_results import FIXTURES, analyze_fixture, evaluate
from jsonschema import Draft202012Validator

from i5_units import (
    UnitError,
    can_convert,
    conversion_plan,
    convert,
    convert_and_validate,
    describe,
    divide_units,
    has_unit,
    list_units,
    measures,
    possibilities,
    qty,
    registry_fingerprint,
    validate_numeric,
)


def test_source_definitions_match_the_published_json_schema() -> None:
    root = Path(__file__).parents[2]
    schema = json.loads((root / "spec/definition.schema.json").read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    for path in sorted((root / "definitions").glob("*.json")):
        validator.validate(json.loads(path.read_text()))


@pytest.mark.parametrize("fixture", FIXTURES["conversions"])
def test_conversion(fixture: dict) -> None:
    result = convert(fixture["value"]).from_(fixture["from"]).to(fixture["to"])
    assert result == pytest.approx(
        fixture["expected"], rel=1e-12, abs=1e-12 if fixture["expected"] == 0 else 0
    )


@pytest.mark.parametrize("fixture", FIXTURES["quantities"], ids=lambda f: f["name"])
def test_quantity(fixture: dict) -> None:
    result = evaluate(fixture["expression"]).to_dict()
    assert result["units"] == fixture["expected"]["units"]
    assert result["value"] == pytest.approx(
        fixture["expected"]["value"],
        rel=1e-12,
        abs=1e-12 if fixture["expected"]["value"] == 0 else 0,
    )


@pytest.mark.parametrize("fixture", FIXTURES["failures"], ids=lambda f: f["name"])
def test_rejected_quantity(fixture: dict) -> None:
    with pytest.raises(UnitError) as error:
        evaluate(fixture["expression"]).to_dict()
    assert error.value.code == fixture["code"]


def test_discovery_and_exact_spelling() -> None:
    assert has_unit("µs")
    for spelling in ["us", "μs", "mms", "Bar", "seconds", " ms", "ms "]:
        assert not has_unit(spelling)
    assert describe("µs")["singular"] == "microsecond"
    assert describe("µs")["base_unit"] == "s"
    assert describe("µs")["prefix"] == "µ"
    assert convert().list("time") == list_units("time")
    assert convert().measures() == measures()
    assert convert().from_("ms").possibilities() == possibilities("time")
    assert can_convert("ms", "µs")
    assert not can_convert("J", "N*m")
    assert not can_convert("C", "ΔK")
    assert not can_convert("unknown", "s")
    with pytest.raises(UnitError, match="Unknown measure"):
        list_units("unknown")
    with pytest.raises(UnitError, match="Call from_"):
        convert(1).to("s")
    with pytest.raises(UnitError, match="Cannot convert"):
        convert(1).from_("m").to("s")


def test_immutable_quantities_and_metadata() -> None:
    original = qty(1, "m")
    converted = original.to("cm")
    assert original.value == 1
    assert converted.value == 100
    with pytest.raises(FrozenInstanceError):
        original.units = "s"
    with pytest.raises(TypeError):
        original.dimensions["length"] = 2
    description = describe("m")
    description["dimensions"]["length"] = 9
    assert qty(1, "m").dimensions == {"length": 1}
    request = convert(1).from_("s")
    request.from_("m")
    assert request.to("ms") == 1000
    assert json.loads(json.dumps(converted.to_dict())) == {"value": 100, "units": "cm"}


def test_python_operators_and_ambiguous_dimensions() -> None:
    assert (qty(10, "m") / qty(2, "s")).to_dict() == {"value": 5, "units": "m/s"}
    assert (qty(1, "m") + qty(50, "cm")).value == 1.5
    assert (qty(1, "m") - qty(50, "cm")).value == 0.5
    assert (qty(2, "cm") ** 2).to("cm2").value == 4
    result = qty(2, "N") * qty(3, "m")
    assert result.measure is None
    assert result.units is None
    assert result.dimensions == {"length": 2, "mass": 1, "time": -2}
    assert result.to("J").value == 6
    assert result.to("N*m").value == 6
    with pytest.raises(UnitError) as error:
        result.to_dict()
    assert error.value.code == "UNRESOLVED_UNIT"


def test_all_units_roundtrip_through_their_measure_reference_unit() -> None:
    registry = json.loads(
        (Path(__file__).parents[2] / "registry.generated.json").read_text()
    )
    for measure in measures():
        units = possibilities(measure)
        for unit in units:
            target = registry["measures"][measure]["reference_unit"]
            converted = convert(12.5).from_(unit).to(target)
            result = convert(converted).from_(target).to(unit)
            assert result == pytest.approx(12.5, rel=1e-12, abs=1e-12)


def test_nonfinite_inputs_and_overflow() -> None:
    for value in [math.nan, math.inf, -math.inf, True, 10**1000]:
        with pytest.raises(UnitError) as error:
            qty(value, "s")
        assert error.value.code == "INVALID_VALUE"
        with pytest.raises(UnitError):
            convert(value)
    with pytest.raises(UnitError):
        convert(1e308).from_("Qs").to("qs")
    with pytest.raises(UnitError):
        qty(1e308, "m") * qty(2, "m")
    with pytest.raises(UnitError) as error:
        qty(1, "m").pow(2**53)
    assert error.value.code == "INVALID_OPERATION"


@pytest.mark.parametrize("fixture", FIXTURES["constraints"])
def test_conversion_and_destination_constraints(fixture: dict) -> None:
    def run() -> float:
        return convert_and_validate(
            fixture["value"], fixture["from"], fixture["to"], fixture["constraints"]
        )

    if "code" in fixture:
        with pytest.raises(UnitError) as error:
            run()
        assert error.value.code == fixture["code"]
    else:
        assert run() == fixture["expected"]


@pytest.mark.parametrize("fixture", FIXTURES["analyses"])
def test_metadata_only_analysis(fixture: dict) -> None:
    result = analyze_fixture(fixture)
    assert result["dimensions"] == fixture["dimensions"]
    assert result["measure"] == fixture["measure"]
    assert result["unit"] == fixture["unit"]


def test_exact_plans_and_registry_identity() -> None:
    assert conversion_plan("ms", "µs").scale_ratio == {
        "numerator": "1000",
        "denominator": "1",
    }
    assert conversion_plan("F", "C").offset_ratio == {
        "numerator": "-160",
        "denominator": "9",
    }
    assert divide_units("m", "s").unit == "m/s"
    assert len(registry_fingerprint) == 71


def test_multiple_lattices_preserve_valid_values_across_binary_exponents() -> None:
    """Exact binary multiples stay valid even when their index exceeds float range."""
    for exponent in (-1074, -1000, -500, -100, -10, 0, 10, 100, 500, 1000):
        multiple = math.ldexp(1.0, exponent)
        for index in (-17, -1, 0, 1, 17):
            value = math.ldexp(float(index), exponent)
            constraints = {
                "multiple_of": multiple,
                "minimum": value,
                "maximum": value,
            }
            result = validate_numeric(value, constraints)
            assert result.hex() == value.hex()
            assert validate_numeric(result, constraints).hex() == result.hex()
    for value in (1.0, -1.0, 1e300, -1e300):
        assert validate_numeric(value, {"multiple_of": math.ulp(0.0)}) == value


def test_multiple_validation_matches_exact_fraction_oracle() -> None:
    """Random double pairs exercise quotient underflow, overflow, and index caps."""
    random_source = random.Random(258271)
    for _ in range(200):
        value = math.ldexp(
            random_source.uniform(-2, 2), random_source.randrange(-1070, 1020)
        )
        multiple = math.ldexp(
            random_source.uniform(1, 2), random_source.randrange(-1070, 1020)
        )
        quotient = Fraction(value) / Fraction(multiple)
        nearest = round(quotient)
        tolerance = min(
            Fraction(1e-9),
            Fraction(1, 2**50) * max(abs(quotient), abs(nearest)),
        )
        if abs(quotient - nearest) <= tolerance:
            assert validate_numeric(value, {"multiple_of": multiple}) == value
        else:
            with pytest.raises(UnitError) as error:
                validate_numeric(value, {"multiple_of": multiple})
            assert error.value.code == "CONSTRAINT_VIOLATION"


def test_inclusive_normalization_preserves_valid_interiors_and_is_idempotent() -> None:
    for boundary in (-100.0, -3.0, -1.0, 1.0, 3.0, 100.0):
        below = math.nextafter(boundary, -math.inf)
        above = math.nextafter(boundary, math.inf)
        for value, constraints in (
            (below, {"maximum": boundary, "exclusive_maximum": boundary}),
            (above, {"minimum": boundary, "exclusive_minimum": boundary}),
        ):
            assert validate_numeric(value, constraints) == value
        for value, constraints in (
            (below, {"minimum": boundary}),
            (above, {"maximum": boundary}),
        ):
            result = validate_numeric(value, constraints)
            assert result == boundary
            assert validate_numeric(result, constraints) == result


def test_normalization_candidates_must_satisfy_every_constraint() -> None:
    constraints = {"integer": True, "exclusive_minimum": 1.0}
    with pytest.raises(UnitError) as error:
        validate_numeric(math.nextafter(1.0, math.inf), constraints)
    assert error.value.code == "CONSTRAINT_VIOLATION"
    for constraints in (
        {"minimum": 1.0, "maximum": 1.0, "exclusive_maximum": 1.0},
        {"minimum": 1.0, "maximum": 1.0, "exclusive_minimum": 1.0},
    ):
        with pytest.raises(UnitError) as error:
            validate_numeric(math.nextafter(1.0, math.inf), constraints)
        assert error.value.code == "CONSTRAINT_VIOLATION"
    for constraints, code in (
        ({"integer": 1}, "INVALID_OPERATION"),
        ({"minimum": math.inf}, "INVALID_VALUE"),
        ({"multiple_of": math.nan}, "INVALID_VALUE"),
    ):
        with pytest.raises(UnitError) as error:
            validate_numeric(1, constraints)
        assert error.value.code == code
