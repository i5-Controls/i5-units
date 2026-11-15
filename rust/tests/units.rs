use i5_units::*;
use serde_json::Value;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures.generated.json")).unwrap()
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap()
}
fn evaluate(expression: &Value) -> Result<Quantity> {
    let result = if let Some(op) = expression["op"].as_str() {
        let left = evaluate(&expression["left"])?;
        if op == "pow" {
            let exponent = expression["exponent"].as_f64().unwrap();
            if exponent.fract() != 0.0 || exponent.abs() > 9_007_199_254_740_991.0 {
                return Err(UnitError {
                    code: "INVALID_OPERATION",
                    message: "Invalid exponent".into(),
                });
            }
            left.pow(exponent as i64)?
        } else {
            let right = evaluate(&expression["right"])?;
            match op {
                "add" => left.add(&right)?,
                "subtract" => left.subtract(&right)?,
                "multiply" => left.multiply(&right)?,
                "divide" => left.divide(&right)?,
                _ => panic!("Unknown operation"),
            }
        }
    } else {
        qty(
            expression["value"].as_f64().unwrap(),
            text(expression, "units"),
        )?
    };
    if let Some(unit) = expression["to"].as_str() {
        result.to(unit)
    } else {
        Ok(result)
    }
}
fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs()
            <= if expected == 0.0 {
                1e-12
            } else {
                expected.abs() * 1e-12
            },
        "{actual} != {expected}"
    );
}
#[test]
fn shared_conversions() {
    for case in fixtures()["conversions"].as_array().unwrap() {
        close(
            convert(
                case["value"].as_f64().unwrap(),
                text(case, "from"),
                text(case, "to"),
            )
            .unwrap(),
            case["expected"].as_f64().unwrap(),
        );
    }
}
#[test]
fn shared_quantities_and_failures() {
    for case in fixtures()["quantities"].as_array().unwrap() {
        let actual = evaluate(&case["expression"]).unwrap().to_value().unwrap();
        assert_eq!(
            actual.units,
            text(&case["expected"], "units"),
            "{}",
            case["name"]
        );
        close(actual.value, case["expected"]["value"].as_f64().unwrap());
    }
    for case in fixtures()["failures"].as_array().unwrap() {
        let actual = evaluate(&case["expression"]).and_then(|q| q.to_value());
        assert_eq!(
            actual.unwrap_err().code,
            text(case, "code"),
            "{}",
            case["name"]
        );
    }
}
#[test]
fn shared_constraints() {
    for case in fixtures()["constraints"].as_array().unwrap() {
        let constraints = serde_json::from_value::<NumericConstraints>(case["constraints"].clone());
        let actual = constraints
            .map_err(|e| UnitError {
                code: "INVALID_OPERATION",
                message: e.to_string(),
            })
            .and_then(|c| {
                convert_and_validate(
                    case["value"].as_f64().unwrap(),
                    text(case, "from"),
                    text(case, "to"),
                    &c,
                )
            });
        if let Some(code) = case["code"].as_str() {
            assert_eq!(actual.unwrap_err().code, code, "{}", case["name"]);
        } else {
            assert_eq!(
                actual.unwrap(),
                case["expected"].as_f64().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}
#[test]
fn shared_analyses() {
    for case in fixtures()["analyses"].as_array().unwrap() {
        let left = analyze_unit(text(case, "left")).unwrap();
        let result = if case["op"] == "power" {
            power_unit(&left, case["exponent"].as_i64().unwrap()).unwrap()
        } else {
            let right = analyze_unit(text(case, "right")).unwrap();
            match text(case, "op") {
                "add" => add_units(&left, &right),
                "subtract" => subtract_units(&left, &right),
                "multiply" => multiply_units(&left, &right),
                "divide" => divide_units(&left, &right),
                _ => panic!(),
            }
            .unwrap()
        };
        assert_eq!(
            serde_json::to_value(result.dimensions()).unwrap(),
            case["dimensions"]
        );
        assert_eq!(
            serde_json::to_value(result.measure()).unwrap(),
            case["measure"]
        );
        assert_eq!(serde_json::to_value(result.unit()).unwrap(), case["unit"]);
    }
}
#[test]
fn inventory_roundtrips_and_errors() {
    assert_eq!(registry_version(), env!("CARGO_PKG_VERSION"));
    assert!(registry_fingerprint().starts_with("sha256:"));
    assert_eq!(registry_format_version(), 1);
    for spelling in ["us", "μs", "mms", "Bar", "seconds", " ms", "ms "] {
        assert!(!has_unit(spelling));
    }
    assert!(has_unit("µs"));
    assert!(!can_convert("J", "N*m"));
    assert!(!can_convert("C", "ΔK"));
    assert_eq!(describe("µs").unwrap().base_unit.as_deref(), Some("s"));
    for unit in list_units(None).unwrap() {
        close(
            convert(
                convert(12.5, &unit.abbr, &unit.reference_unit).unwrap(),
                &unit.reference_unit,
                &unit.abbr,
            )
            .unwrap(),
            12.5,
        );
    }
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(qty(value, "s").unwrap_err().code, "INVALID_VALUE");
    }
    assert_eq!(
        convert(f64::MAX, "Qs", "qs").unwrap_err().code,
        "INVALID_VALUE"
    );
    assert_eq!(
        qty(f64::MAX, "m")
            .unwrap()
            .multiply(&qty(2.0, "m").unwrap())
            .unwrap_err()
            .code,
        "INVALID_VALUE"
    );
    assert_eq!(parse_unit("us").unwrap_err().code, "UNKNOWN_UNIT");
    assert_eq!(
        possibilities(Some("unknown")).unwrap_err().code,
        "UNKNOWN_MEASURE"
    );
}
#[test]
fn exact_arithmetic_and_work_budget() {
    let a = qty(1.0, "m").unwrap();
    let b = qty(1e-17, "m").unwrap();
    assert_eq!(
        a.add(&b).unwrap().subtract(&a).unwrap().value().unwrap(),
        1e-17
    );
    let unresolved = qty(2.0, "N")
        .unwrap()
        .multiply(&qty(3.0, "m").unwrap())
        .unwrap();
    assert_eq!(unresolved.value().unwrap_err().code, "UNRESOLVED_UNIT");
    assert_eq!(unresolved.to("J").unwrap().value().unwrap(), 6.0);
    assert_eq!(unresolved.to("N*m").unwrap().value().unwrap(), 6.0);
    assert_eq!(
        qty(2.0, "m").unwrap().pow(100_001).unwrap_err().code,
        "INVALID_VALUE"
    );
    assert_eq!(
        qty(0.0, "m").unwrap().pow(-1).unwrap_err().code,
        "INVALID_OPERATION"
    );
}
