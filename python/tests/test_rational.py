"""Arithmetic budgets cover composition and preserve bounded cancellations."""

import sys
from fractions import Fraction

import pytest

from i5_units import MAX_RATIONAL_BITS, UnitError, qty
from i5_units import rational as r


def test_constructor_and_wire_budget_without_changing_python_digit_limits() -> None:
    digit_limit = sys.get_int_max_str_digits()
    boundary = 1 << (MAX_RATIONAL_BITS - 1)
    for value in (Fraction(boundary), Fraction(-boundary), Fraction(1, boundary)):
        assert r.from_wire(r.to_wire(value)) == value
    assert sys.get_int_max_str_digits() == digit_limit
    with pytest.raises(UnitError) as error:
        r.fraction(1 << MAX_RATIONAL_BITS)
    assert error.value.code == "INVALID_VALUE"
    with pytest.raises(UnitError):
        r.from_wire({"numerator": "1" + "0" * 30104, "denominator": "1"})


def test_products_cross_cancel_before_size_checks() -> None:
    boundary = 1 << (MAX_RATIONAL_BITS - 1)
    value = Fraction(boundary - 1, boundary)
    inverse = Fraction(boundary, boundary - 1)
    assert r.multiply(value, inverse) == 1
    assert r.divide(value, value) == 1
    assert r.multiply(-value, inverse) == -1
    assert r.divide(-inverse, inverse) == -1
    assert r.multiply(value, Fraction(0)) == 0
    large = Fraction(1 << (MAX_RATIONAL_BITS // 2))
    for operation in (
        lambda: r.multiply(large, large),
        lambda: r.divide(large, 1 / large),
    ):
        with pytest.raises(UnitError) as error:
            operation()
        assert error.value.code == "INVALID_VALUE"


def test_addition_reduces_common_denominators_and_rejects_oversized_results() -> None:
    boundary = 1 << (MAX_RATIONAL_BITS - 1)
    almost = Fraction(boundary - 1, boundary)
    assert r.add(almost, Fraction(1, boundary)) == 1
    assert r.subtract(almost, Fraction(-1, boundary)) == 1
    assert r.add(Fraction(boundary), Fraction(-boundary)) == 0
    assert r.add(Fraction(boundary), Fraction(1 - boundary)) == 1
    # Temporary numerators can need one more bit even though the reduced result fits.
    assert r.add(almost, almost) == Fraction(boundary - 1, boundary // 2)
    for operation in (
        lambda: r.add(Fraction(boundary), Fraction(boundary)),
        lambda: r.subtract(Fraction(-boundary), Fraction(boundary)),
    ):
        with pytest.raises(UnitError):
            operation()


def test_power_and_all_quantity_operations_share_the_budget() -> None:
    boundary = Fraction(-(1 << (MAX_RATIONAL_BITS - 1)))
    assert r.power(boundary, 1) == boundary
    assert r.power(boundary, -1) == 1 / boundary
    assert r.power(boundary, 0) == 1
    value = qty(1 + sys.float_info.epsilon, "1")
    for _ in range(10):
        value = value * value
    assert value.divide(value).to_dict() == {"value": 1, "units": "1"}
    assert value.subtract(value).value == 0
    assert value.multiply(qty(0, "1")).value == 0
    with pytest.raises(UnitError) as error:
        value.multiply(value)
    assert error.value.code == "INVALID_VALUE"
