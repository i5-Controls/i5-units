use num_traits::{Signed, Zero};
use serde::{Deserialize, Serialize};

use crate::{
    convert, error,
    rational::{self, Rational},
    Result, MAX_SAFE_INTEGER,
};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct NumericConstraints {
    pub integer: bool,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    pub exclusive_minimum: Option<f64>,
    pub exclusive_maximum: Option<f64>,
    pub multiple_of: Option<f64>,
}

fn near(a: &Rational, b: &Rational) -> bool {
    let largest = a.abs().max(b.abs());
    let tolerance = (rational::from_float(4.0 * f64::EPSILON).unwrap() * largest)
        .min(rational::from_float(1e-9).unwrap());
    (a - b).abs() <= tolerance
}

pub fn validate_numeric(value: f64, constraints: &NumericConstraints) -> Result<f64> {
    let original = rational::from_float(value)?;
    let bounds = [
        constraints.minimum,
        constraints.maximum,
        constraints.exclusive_minimum,
        constraints.exclusive_maximum,
        constraints.multiple_of,
    ]
    .map(|bound| bound.map(rational::from_float).transpose());
    let [minimum, maximum, exclusive_minimum, exclusive_maximum, multiple] = bounds;
    let (minimum, maximum, exclusive_minimum, exclusive_maximum, multiple) = (
        minimum?,
        maximum?,
        exclusive_minimum?,
        exclusive_maximum?,
        multiple?,
    );
    if multiple.as_ref().is_some_and(|v| v <= &Rational::zero()) {
        return Err(error("INVALID_OPERATION", "multiple_of must be positive"));
    }
    if minimum
        .as_ref()
        .zip(maximum.as_ref())
        .is_some_and(|(a, b)| a > b)
    {
        return Err(error(
            "INVALID_OPERATION",
            "minimum must not exceed maximum",
        ));
    }
    let satisfies = |candidate: &Rational| {
        if constraints.integer
            && (!candidate.is_integer()
                || candidate.abs() > Rational::from_integer(MAX_SAFE_INTEGER.into()))
        {
            return false;
        }
        if minimum.as_ref().is_some_and(|v| candidate < v)
            || maximum.as_ref().is_some_and(|v| candidate > v)
            || exclusive_minimum.as_ref().is_some_and(|v| candidate <= v)
            || exclusive_maximum.as_ref().is_some_and(|v| candidate >= v)
        {
            return false;
        }
        if let Some(multiple) = &multiple {
            let index = candidate / multiple;
            if !near(&index, &rational::nearest_integer(&index)) {
                return false;
            }
        }
        true
    };
    if satisfies(&original) {
        return Ok(value);
    }
    let mut candidates = Vec::new();
    if constraints.integer {
        let rounded = rational::nearest_integer(&original);
        if near(&original, &rounded) {
            candidates.push(rounded);
        }
    }
    if let Some(multiple) = &multiple {
        let index = &original / multiple;
        let rounded = rational::nearest_integer(&index);
        if near(&index, &rounded) {
            candidates.push(rounded * multiple);
        }
    }
    for bound in [minimum.as_ref(), maximum.as_ref()].into_iter().flatten() {
        if near(&original, bound) {
            candidates.push(bound.clone());
        }
    }
    for candidate in candidates {
        if let Ok(rounded) = rational::to_float(&candidate) {
            if satisfies(&rational::from_float(rounded)?) {
                return Ok(rounded);
            }
        }
    }
    Err(error(
        "CONSTRAINT_VIOLATION",
        "Converted value violates destination constraints",
    ))
}

pub fn convert_and_validate(
    value: f64,
    source: &str,
    target: &str,
    constraints: &NumericConstraints,
) -> Result<f64> {
    validate_numeric(convert(value, source, target)?, constraints)
}
