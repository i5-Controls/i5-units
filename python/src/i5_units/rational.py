"""Bounded exact arithmetic; reduce/cross-cancel before allocating results."""

from fractions import Fraction
from math import gcd

from .errors import UnitError

MAX_RATIONAL_BITS = 100000
_MAX_WORK_BITS = 2 * MAX_RATIONAL_BITS + 1
_MAX_MAGNITUDE = (1 << MAX_RATIONAL_BITS) - 1
_MAX_DIGITS = 30104


def _fail() -> None:
    raise UnitError(
        "INVALID_VALUE",
        f"Rational work limit exceeded ({MAX_RATIONAL_BITS} bits per reduced part)",
    )


def _parts(n: int, d: int) -> None:
    if max(abs(n).bit_length(), abs(d).bit_length()) > MAX_RATIONAL_BITS:
        _fail()


def checked(value: Fraction) -> Fraction:
    """Check already reduced operands before performing any operation."""
    _parts(value.numerator, value.denominator)
    return value


def fraction(n: int, d: int = 1) -> Fraction:
    """Construct from bounded integers without accepting oversized raw inputs."""
    _parts(n, d)
    return Fraction(n, d)


def _product(a: int, b: int, limit: int = MAX_RATIONAL_BITS) -> int:
    if a == 0 or b == 0:
        return 0
    size = abs(a).bit_length() + abs(b).bit_length()
    if size - 1 > limit:
        _fail()
    if size > limit:
        maximum = _MAX_MAGNITUDE if limit == MAX_RATIONAL_BITS else (1 << limit) - 1
        if abs(a) > maximum // abs(b):
            _fail()
    return a * b


def _sum(a: Fraction, b: Fraction, sign: int) -> Fraction:
    checked(a)
    checked(b)
    common = gcd(a.denominator, b.denominator)
    left = _product(a.numerator, b.denominator // common, _MAX_WORK_BITS - 1)
    right = _product(b.numerator, a.denominator // common, _MAX_WORK_BITS - 1)
    numerator = left + sign * right
    if abs(numerator).bit_length() > _MAX_WORK_BITS:
        _fail()
    if numerator == 0:
        return Fraction(0)
    cancellation = gcd(numerator, common)
    reduced = numerator // cancellation
    _parts(reduced, 1)
    denominator = _product(a.denominator // common, b.denominator // cancellation)
    return fraction(reduced, denominator)


def add(a: Fraction, b: Fraction) -> Fraction:
    """Use denominator gcd and bounded temporaries to preserve cancellation."""
    return _sum(a, b, 1)


def subtract(a: Fraction, b: Fraction) -> Fraction:
    """Subtract without allocating an unbounded common denominator."""
    return _sum(a, b, -1)


def multiply(a: Fraction, b: Fraction) -> Fraction:
    """Cross-cancel, then check result sizes before multiplying integers."""
    checked(a)
    checked(b)
    if a == 0 or b == 0:
        return Fraction(0)
    left = gcd(a.numerator, b.denominator)
    right = gcd(b.numerator, a.denominator)
    return fraction(
        _product(a.numerator // left, b.numerator // right),
        _product(a.denominator // right, b.denominator // left),
    )


def divide(a: Fraction, b: Fraction) -> Fraction:
    """Invert a bounded denominator and reuse cross-cancelled multiplication."""
    checked(a)
    checked(b)
    return multiply(a, fraction(b.denominator, b.numerator))


def power(a: Fraction, exponent: int) -> Fraction:
    """Preflight power size using the same representation budget."""
    checked(a)
    if (
        max(abs(a.numerator).bit_length(), a.denominator.bit_length()) * abs(exponent)
        > MAX_RATIONAL_BITS
    ):
        _fail()
    return checked(a**exponent)


def _parse_integer(value: str) -> int:
    # Chunking avoids Python's process-wide decimal digit limit; it is never changed.
    negative = value.startswith("-")
    digits = value[1:] if negative else value
    if len(digits) > _MAX_DIGITS:
        _fail()
    if not digits or not digits.isascii() or not digits.isdigit():
        raise ValueError("Invalid rational integer")
    result = 0
    for index in range(0, len(digits), 9):
        chunk = digits[index : index + 9]
        result = result * 10 ** len(chunk) + int(chunk)
        _parts(result, 1)
    return -result if negative else result


def from_wire(value: dict[str, str]) -> Fraction:
    """Read bounded decimal strings without unbounded parsing allocations."""
    return fraction(
        _parse_integer(value["numerator"]), _parse_integer(value["denominator"])
    )


def _format_integer(value: int) -> str:
    _parts(value, 1)
    negative = value < 0
    value = abs(value)
    if value == 0:
        return "0"
    chunks = []
    while value:
        value, chunk = divmod(value, 1000000000)
        chunks.append(chunk)
    text = str(chunks[-1]) + "".join(f"{chunk:09d}" for chunk in reversed(chunks[:-1]))
    return "-" + text if negative else text


def to_wire(value: Fraction) -> dict[str, str]:
    """Serialize within the budget independently of Python's decimal digit cap."""
    checked(value)
    return {
        "numerator": _format_integer(value.numerator),
        "denominator": _format_integer(value.denominator),
    }
