use num_bigint::BigInt;
use num_rational::BigRational;
use num_traits::{Signed, ToPrimitive, Zero};
use serde::{Deserialize, Serialize};

use crate::{error, Result};

pub const MAX_RATIONAL_BITS: u64 = 100_000;
pub(crate) type Rational = BigRational;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Ratio {
    pub numerator: String,
    pub denominator: String,
}

pub(crate) fn checked(value: Rational) -> Result<Rational> {
    if value.numer().bits().max(value.denom().bits()) > MAX_RATIONAL_BITS {
        return Err(error("INVALID_VALUE", "Rational work limit exceeded"));
    }
    Ok(value)
}

pub(crate) fn from_float(value: f64) -> Result<Rational> {
    Rational::from_float(value)
        .ok_or_else(|| error("INVALID_VALUE", "Quantity values must be finite"))
}

pub(crate) fn to_float(value: &Rational) -> Result<f64> {
    value
        .to_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| error("INVALID_VALUE", "Quantity result must be finite"))
}

pub(crate) fn from_wire(value: &Ratio) -> Result<Rational> {
    let parse = |text: &str| -> Result<BigInt> {
        if text.len() > 30_105 {
            return Err(error("INVALID_VALUE", "Rational work limit exceeded"));
        }
        let integer: BigInt = text
            .parse()
            .map_err(|_| error("INVALID_VALUE", "Invalid rational integer"))?;
        if integer.bits() > MAX_RATIONAL_BITS {
            return Err(error("INVALID_VALUE", "Rational work limit exceeded"));
        }
        Ok(integer)
    };
    let denominator = parse(&value.denominator)?;
    if denominator.is_zero() {
        return Err(error("INVALID_VALUE", "Zero rational denominator"));
    }
    checked(Rational::new(parse(&value.numerator)?, denominator))
}

pub(crate) fn to_wire(value: &Rational) -> Ratio {
    Ratio {
        numerator: value.numer().to_string(),
        denominator: value.denom().to_string(),
    }
}

// Operands are bounded. num-rational reduces and cross-cancels; even temporary
// products are bounded by twice the operand budget before the result is checked.
pub(crate) fn add(a: &Rational, b: &Rational) -> Result<Rational> {
    checked(a + b)
}
pub(crate) fn subtract(a: &Rational, b: &Rational) -> Result<Rational> {
    checked(a - b)
}
pub(crate) fn multiply(a: &Rational, b: &Rational) -> Result<Rational> {
    checked(a * b)
}
pub(crate) fn divide(a: &Rational, b: &Rational) -> Result<Rational> {
    if b.is_zero() {
        return Err(error("INVALID_OPERATION", "Cannot divide by zero"));
    }
    checked(a / b)
}
pub(crate) fn power(value: &Rational, exponent: i32) -> Result<Rational> {
    if value.numer().bits().max(value.denom().bits()) * u64::from(exponent.unsigned_abs())
        > MAX_RATIONAL_BITS
    {
        return Err(error("INVALID_VALUE", "Rational work limit exceeded"));
    }
    if value.is_zero() && exponent < 0 {
        return Err(error(
            "INVALID_OPERATION",
            "Cannot raise zero to a negative power",
        ));
    }
    checked(value.pow(exponent))
}

pub(crate) fn nearest_integer(value: &Rational) -> Rational {
    // Round ties to even, matching the TypeScript and Python rational cores.
    let magnitude = value.abs();
    let mut integer = magnitude.to_integer();
    let remainder = magnitude.numer() % magnitude.denom();
    let twice = remainder * 2;
    if twice > *magnitude.denom() || (twice == *magnitude.denom() && &integer % 2 != BigInt::zero())
    {
        integer += 1;
    }
    Rational::from_integer(if value.is_negative() {
        -integer
    } else {
        integer
    })
}
