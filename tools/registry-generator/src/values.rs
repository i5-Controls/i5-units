use num_bigint::BigInt;
use num_rational::BigRational;
use num_traits::{One, ToPrimitive, Zero};
use serde_json::{Map, Value};

pub type Result<T> = std::result::Result<T, String>;
pub type Ratio = BigRational;
pub const MAX_BITS: u64 = 100_000;
pub fn fail<T>(path: &str, message: &str) -> Result<T> {
    Err(format!("{path}: {message}"))
}
pub fn object<'a>(value: &'a Value, path: &str, keys: &[&str]) -> Result<&'a Map<String, Value>> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{path}: must be an object"))?;
    for key in object.keys() {
        if !keys.contains(&key.as_str()) {
            return fail(&format!("{path}.{key}"), "unknown property");
        }
    }
    Ok(object)
}
pub fn any_object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| format!("{path}: must be an object"))
}
pub fn string<'a>(value: &'a Value, path: &str) -> Result<&'a str> {
    value
        .as_str()
        .filter(|v| !v.is_empty() && v.trim() == *v)
        .ok_or_else(|| format!("{path}: must be a nonempty string without surrounding whitespace"))
}
pub fn number(value: &Value, path: &str) -> Result<f64> {
    value
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("{path}: must be a finite number"))
}
pub fn safe_integer(value: &Value) -> Option<i64> {
    value
        .as_f64()
        .filter(|v| v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0)
        .map(|v| v as i64)
}
pub fn coefficient(value: &Value, path: &str) -> Result<f64> {
    if value.is_number() {
        return number(value, path);
    }
    object(value, path, &["numerator", "denominator"])?;
    let n = number(&value["numerator"], &format!("{path}.numerator"))?;
    let d = number(&value["denominator"], &format!("{path}.denominator"))?;
    if d == 0.0 {
        return fail(path, "denominator must not be zero");
    }
    let result = n / d;
    if !result.is_finite() {
        return fail(path, "must be a finite number");
    }
    Ok(result)
}
pub fn checked(value: Ratio, path: &str) -> Result<Ratio> {
    if value.numer().bits().max(value.denom().bits()) > MAX_BITS {
        return fail(
            path,
            "Rational work limit exceeded (100000 bits per reduced part)",
        );
    }
    Ok(value)
}
fn decimal(value: &Value, path: &str) -> Result<Ratio> {
    number(value, path)?;
    let text = value.to_string().to_lowercase();
    let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
    let places = mantissa
        .split_once('.')
        .map_or(0, |(_, tail)| tail.len() as i32);
    let exponent = exponent.parse::<i32>().map_err(|e| e.to_string())? - places;
    let digits = mantissa.replace('.', "");
    let integer = digits.parse::<BigInt>().map_err(|e| e.to_string())?;
    let ten = BigInt::from(10).pow(exponent.unsigned_abs());
    checked(
        if exponent >= 0 {
            Ratio::from_integer(integer * ten)
        } else {
            Ratio::new(integer, ten)
        },
        path,
    )
}
pub fn coefficient_ratio(value: &Value, path: &str) -> Result<Ratio> {
    coefficient(value, path)?;
    if value.is_number() {
        decimal(value, path)
    } else {
        checked(
            decimal(&value["numerator"], path)? / decimal(&value["denominator"], path)?,
            path,
        )
    }
}
pub fn pow(value: &Ratio, exponent: i64, path: &str) -> Result<Ratio> {
    let size = value.numer().bits().max(value.denom().bits());
    if size.saturating_mul(exponent.unsigned_abs()) > MAX_BITS {
        return fail(path, "Rational work limit exceeded");
    }
    let exponent =
        i32::try_from(exponent).map_err(|_| format!("{path}: Rational work limit exceeded"))?;
    if value.is_zero() && exponent < 0 {
        return fail(path, "Cannot divide by zero");
    }
    checked(value.pow(exponent), path)
}
pub fn one() -> Ratio {
    Ratio::one()
}
pub fn zero() -> Ratio {
    Ratio::zero()
}
pub fn wire(value: &Ratio) -> Value {
    serde_json::json!({"numerator": value.numer().to_string(), "denominator": value.denom().to_string()})
}
pub fn numeric(value: &Ratio, path: &str) -> Result<Value> {
    let result = value
        .to_f64()
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("{path}: must be a finite number"))?;
    Ok(
        if result.fract() == 0.0 && result.abs() <= 9_007_199_254_740_991.0 {
            Value::from(result as i64)
        } else {
            Value::from(result)
        },
    )
}
pub fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), canonical(&map[key])))
                    .collect(),
            )
        }
        Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}
pub fn dimension_key(value: &Value) -> String {
    canonical(value).to_string()
}

pub fn ordered_entries(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut entries: Vec<_> = map.iter().collect();
    entries.sort_by_key(|(key, _)| {
        key.parse::<u32>()
            .ok()
            .filter(|n| *n != u32::MAX && n.to_string() == **key)
            .map_or((1, 0), |n| (0, n))
    });
    entries
}

pub fn js_order(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            ordered_entries(map)
                .into_iter()
                .map(|(k, v)| (k.clone(), js_order(v)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(js_order).collect()),
        _ => value.clone(),
    }
}

/// JSON with ECMAScript number spelling preserves existing registry fingerprints.
pub fn compact(value: &Value) -> String {
    match value {
        Value::Number(n) => ryu_js::Buffer::new().format(n.as_f64().unwrap()).to_owned(),
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(compact).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => {
            // ECMAScript enumerates array-index property names before other keys.
            let entries = ordered_entries(map);
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        compact(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fingerprint_json_preserves_ecmascript_number_and_property_order() {
        let value = json!({"%": 0.000001, "1": {"scale": 1e21}});
        assert_eq!(
            compact(&canonical(&value)),
            r#"{"1":{"scale":1e+21},"%":0.000001}"#
        );
    }

    #[test]
    fn authored_decimal_coefficients_remain_exact() {
        let ratio =
            coefficient_ratio(&json!({"numerator": 0.1, "denominator": 0.3}), "test").unwrap();
        assert_eq!(wire(&ratio), json!({"numerator": "1", "denominator": "3"}));
        assert!(pow(&Ratio::from_integer(10.into()), 100_001, "test").is_err());
    }
}
