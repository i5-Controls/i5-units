//! Unit conversion and dimensional quantities backed by the shared i5 registry.
//!
//! ```
//! use i5_units::{convert, qty, Result};
//! # fn main() -> Result<()> {
//! assert_eq!(convert(1.0, "s", "µs")?, 1_000_000.0);
//! let velocity = qty(10.0, "m")?.divide(&qty(2.0, "ms")?)?;
//! assert_eq!(velocity.to("km/h")?.value()?, 18_000.0);
//! # Ok(())
//! # }
//! ```

mod constraints;
mod rational;

use std::{collections::BTreeMap, fmt, sync::LazyLock};

use serde::{Deserialize, Serialize};

pub use constraints::{convert_and_validate, validate_numeric, NumericConstraints};
use rational::{from_float, from_wire, to_float, Rational};
pub use rational::{Ratio, MAX_RATIONAL_BITS};

pub type Result<T> = std::result::Result<T, UnitError>;
pub type Dimensions = BTreeMap<String, i64>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnitError {
    pub code: &'static str,
    pub message: String,
}
impl fmt::Display for UnitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for UnitError {}
pub(crate) fn error(code: &'static str, message: impl Into<String>) -> UnitError {
    UnitError {
        code,
        message: message.into(),
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UnitKind {
    Linear,
    Absolute,
    Difference,
}

#[derive(Deserialize)]
struct Name {
    singular: String,
    plural: String,
}
#[derive(Deserialize)]
struct UnitDefinition {
    measure: String,
    system: String,
    name: Name,
    scale: f64,
    offset: f64,
    scale_ratio: Ratio,
    offset_ratio: Ratio,
    prefix: Option<String>,
    base_unit: Option<String>,
    components: Option<BTreeMap<String, i64>>,
}
#[derive(Deserialize)]
struct MeasureDefinition {
    dimensions: Dimensions,
    reference_unit: String,
    kind: UnitKind,
    default_result: bool,
}
#[derive(Deserialize)]
struct Registry {
    version: String,
    fingerprint: String,
    format_version: u32,
    dimensions: Vec<String>,
    measures: BTreeMap<String, MeasureDefinition>,
    units: BTreeMap<String, UnitDefinition>,
}
static REGISTRY: LazyLock<Registry> = LazyLock::new(|| {
    serde_json::from_str(include_str!("registry.generated.json"))
        .expect("the bundled, generated registry must be valid")
});

pub fn registry_version() -> &'static str {
    &REGISTRY.version
}
pub fn registry_fingerprint() -> &'static str {
    &REGISTRY.fingerprint
}
pub fn registry_format_version() -> u32 {
    REGISTRY.format_version
}
pub fn has_unit(unit: &str) -> bool {
    REGISTRY.units.contains_key(unit)
}
pub fn parse_unit(unit: &str) -> Result<&str> {
    definition(unit)?;
    Ok(unit)
}
pub fn parse_measure(measure: &str) -> Result<&str> {
    if REGISTRY.measures.contains_key(measure) {
        Ok(measure)
    } else {
        Err(error(
            "UNKNOWN_MEASURE",
            format!("Unknown measure {measure}"),
        ))
    }
}
fn definition(unit: &str) -> Result<&'static UnitDefinition> {
    REGISTRY
        .units
        .get(unit)
        .ok_or_else(|| error("UNKNOWN_UNIT", format!("Unknown unit {unit}")))
}

#[derive(Clone, Debug, Serialize)]
pub struct UnitDescription {
    pub abbr: String,
    pub measure: String,
    pub system: String,
    pub singular: String,
    pub plural: String,
    pub dimensions: Dimensions,
    pub reference_unit: String,
    pub kind: UnitKind,
    pub scale: f64,
    pub offset: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub components: Option<BTreeMap<String, i64>>,
}
pub fn describe(unit: &str) -> Result<UnitDescription> {
    let item = definition(unit)?;
    let measure = &REGISTRY.measures[&item.measure];
    Ok(UnitDescription {
        abbr: unit.into(),
        measure: item.measure.clone(),
        system: item.system.clone(),
        singular: item.name.singular.clone(),
        plural: item.name.plural.clone(),
        dimensions: measure.dimensions.clone(),
        reference_unit: measure.reference_unit.clone(),
        kind: measure.kind,
        scale: item.scale,
        offset: item.offset,
        prefix: item.prefix.clone(),
        base_unit: item.base_unit.clone(),
        components: item.components.clone(),
    })
}
/// Discover measure names in sorted order.
pub fn measures() -> Vec<&'static str> {
    REGISTRY.measures.keys().map(String::as_str).collect()
}
/// Discover canonical spellings in sorted order, optionally limited to a measure.
pub fn possibilities(measure: Option<&str>) -> Result<Vec<&'static str>> {
    if let Some(measure) = measure {
        parse_measure(measure)?;
    }
    Ok(REGISTRY
        .units
        .iter()
        .filter(|(_, item)| measure.map_or(true, |m| m == item.measure))
        .map(|(unit, _)| unit.as_str())
        .collect())
}
pub fn list_units(measure: Option<&str>) -> Result<Vec<UnitDescription>> {
    possibilities(measure)?.into_iter().map(describe).collect()
}
pub fn can_convert(source: &str, target: &str) -> bool {
    match (REGISTRY.units.get(source), REGISTRY.units.get(target)) {
        (Some(a), Some(b)) => a.measure == b.measure,
        _ => false,
    }
}
fn exact(unit: &str) -> Result<(Rational, Rational)> {
    let item = definition(unit)?;
    Ok((
        from_wire(&item.scale_ratio)?,
        from_wire(&item.offset_ratio)?,
    ))
}

#[derive(Clone, Debug)]
pub struct ConversionPlan {
    source: String,
    target: String,
    scale: Rational,
    offset: Rational,
}
impl ConversionPlan {
    pub fn source(&self) -> &str {
        &self.source
    }
    pub fn target(&self) -> &str {
        &self.target
    }
    pub fn scale_ratio(&self) -> Ratio {
        rational::to_wire(&self.scale)
    }
    pub fn offset_ratio(&self) -> Ratio {
        rational::to_wire(&self.offset)
    }
    pub fn convert(&self, value: f64) -> Result<f64> {
        let input = from_float(value)?;
        if self.source == self.target {
            return Ok(value);
        }
        to_float(&rational::add(
            &rational::multiply(&input, &self.scale)?,
            &self.offset,
        )?)
    }
}
pub fn conversion_plan(source: &str, target: &str) -> Result<ConversionPlan> {
    let (a_scale, a_offset) = exact(source)?;
    let (b_scale, b_offset) = exact(target)?;
    if !can_convert(source, target) {
        return Err(error(
            "INCOMPATIBLE_UNITS",
            format!("Cannot convert {source} to {target}"),
        ));
    }
    Ok(ConversionPlan {
        source: source.into(),
        target: target.into(),
        scale: rational::divide(&a_scale, &b_scale)?,
        offset: rational::divide(&rational::subtract(&a_offset, &b_offset)?, &b_scale)?,
    })
}
pub fn convert(value: f64, source: &str, target: &str) -> Result<f64> {
    conversion_plan(source, target)?.convert(value)
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct UnitAnalysis {
    dimensions: Dimensions,
    measure: Option<String>,
    unit: Option<String>,
    kind: Option<UnitKind>,
    candidates: Vec<String>,
}
impl UnitAnalysis {
    pub fn dimensions(&self) -> &Dimensions {
        &self.dimensions
    }
    pub fn measure(&self) -> Option<&str> {
        self.measure.as_deref()
    }
    pub fn unit(&self) -> Option<&str> {
        self.unit.as_deref()
    }
    pub fn kind(&self) -> Option<UnitKind> {
        self.kind
    }
    pub fn candidates(&self) -> &[String] {
        &self.candidates
    }
}
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
pub fn analyze_dimensions(dimensions: &Dimensions) -> Result<UnitAnalysis> {
    if dimensions.iter().any(|(key, exp)| {
        !REGISTRY.dimensions.contains(key) || !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(exp)
    }) {
        return Err(error(
            "INVALID_OPERATION",
            "Dimensions require known names and safe integer exponents",
        ));
    }
    let dimensions: Dimensions = dimensions
        .iter()
        .filter(|(_, exp)| **exp != 0)
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    let candidates: Vec<String> = REGISTRY
        .measures
        .iter()
        .filter(|(_, m)| m.kind != UnitKind::Absolute && m.dimensions == dimensions)
        .map(|(name, _)| name.clone())
        .collect();
    let measure = candidates
        .iter()
        .find(|name| REGISTRY.measures[*name].default_result)
        .cloned();
    Ok(UnitAnalysis {
        dimensions,
        unit: measure
            .as_ref()
            .map(|name| REGISTRY.measures[name].reference_unit.clone()),
        kind: measure.as_ref().map(|name| REGISTRY.measures[name].kind),
        measure,
        candidates,
    })
}
pub fn analyze_unit(unit: &str) -> Result<UnitAnalysis> {
    let description = describe(unit)?;
    let mut result = analyze_dimensions(&description.dimensions)?;
    result.measure = Some(description.measure);
    result.unit = Some(unit.into());
    result.kind = Some(description.kind);
    Ok(result)
}
fn combine(a: &Dimensions, b: &Dimensions, sign: i64) -> Result<Dimensions> {
    REGISTRY
        .dimensions
        .iter()
        .map(|key| {
            b.get(key)
                .copied()
                .unwrap_or(0)
                .checked_mul(sign)
                .and_then(|v| a.get(key).copied().unwrap_or(0).checked_add(v))
                .filter(|exp| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(exp))
                .map(|exp| (key.clone(), exp))
                .ok_or_else(|| error("INVALID_OPERATION", "Dimension exponent overflow"))
        })
        .collect()
}
fn product_analysis(a: &UnitAnalysis, b: &UnitAnalysis, divide: bool) -> Result<UnitAnalysis> {
    if a.kind == Some(UnitKind::Absolute) || b.kind == Some(UnitKind::Absolute) {
        return Err(error(
            "INVALID_OPERATION",
            "Use temperature differences for multiplication and division",
        ));
    }
    let mut result = analyze_dimensions(&combine(
        &a.dimensions,
        &b.dimensions,
        if divide { -1 } else { 1 },
    )?)?;
    let preserved = if b.dimensions.is_empty() {
        Some(a)
    } else if !divide && a.dimensions.is_empty() {
        Some(b)
    } else {
        None
    };
    if let Some(input) = preserved.filter(|input| input.measure.is_some()) {
        result.measure = input.measure.clone();
        result.kind = input.kind;
        result.unit = input
            .measure
            .as_ref()
            .map(|m| REGISTRY.measures[m].reference_unit.clone());
    }
    Ok(result)
}
pub fn multiply_units(left: &UnitAnalysis, right: &UnitAnalysis) -> Result<UnitAnalysis> {
    product_analysis(left, right, false)
}
pub fn divide_units(left: &UnitAnalysis, right: &UnitAnalysis) -> Result<UnitAnalysis> {
    product_analysis(left, right, true)
}
pub fn power_unit(input: &UnitAnalysis, exponent: i64) -> Result<UnitAnalysis> {
    if input.kind == Some(UnitKind::Absolute)
        || !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&exponent)
    {
        return Err(error(
            "INVALID_OPERATION",
            "Powers require an integer exponent and a non-absolute quantity",
        ));
    }
    let result = analyze_dimensions(&combine(&Dimensions::new(), &input.dimensions, exponent)?)?;
    Ok(if exponent == 1 { input.clone() } else { result })
}
fn sum_analysis(a: &UnitAnalysis, b: &UnitAnalysis, subtract: bool) -> Result<UnitAnalysis> {
    if a.dimensions != b.dimensions {
        return Err(error(
            "INCOMPATIBLE_UNITS",
            "Addition and subtraction require matching dimensions",
        ));
    }
    if a.kind == Some(UnitKind::Absolute)
        && b.kind == Some(UnitKind::Absolute)
        && a.measure == b.measure
    {
        if !subtract {
            return Err(error(
                "INVALID_OPERATION",
                "Cannot add two absolute temperatures",
            ));
        }
        return analyze_dimensions(&a.dimensions);
    }
    if a.kind == Some(UnitKind::Absolute) && b.kind == Some(UnitKind::Difference) {
        return Ok(a.clone());
    }
    if a.kind == Some(UnitKind::Difference) && b.kind == Some(UnitKind::Absolute) && !subtract {
        return Ok(b.clone());
    }
    if a.measure.is_some() && b.measure.is_some() && a.measure != b.measure {
        return Err(error(
            "INCOMPATIBLE_UNITS",
            "Addition and subtraction require matching measures",
        ));
    }
    Ok(if a.measure.is_some() {
        a.clone()
    } else {
        b.clone()
    })
}
pub fn add_units(left: &UnitAnalysis, right: &UnitAnalysis) -> Result<UnitAnalysis> {
    sum_analysis(left, right, false)
}
pub fn subtract_units(left: &UnitAnalysis, right: &UnitAnalysis) -> Result<UnitAnalysis> {
    sum_analysis(left, right, true)
}

#[derive(Clone, Debug)]
pub struct Quantity {
    base_value: Rational,
    metadata: UnitAnalysis,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct QuantityValue {
    pub value: f64,
    pub units: String,
}
impl Quantity {
    pub fn new(value: f64, unit: &str) -> Result<Self> {
        let metadata = analyze_unit(unit)?;
        let (scale, offset) = exact(unit)?;
        Ok(Self {
            base_value: rational::add(&rational::multiply(&from_float(value)?, &scale)?, &offset)?,
            metadata,
        })
    }
    fn from_base(base_value: Rational, metadata: UnitAnalysis) -> Result<Self> {
        let result = Self {
            base_value,
            metadata,
        };
        if result.units().is_some() {
            result.value()?;
        }
        Ok(result)
    }
    pub fn analysis(&self) -> &UnitAnalysis {
        &self.metadata
    }
    pub fn dimensions(&self) -> &Dimensions {
        self.metadata.dimensions()
    }
    pub fn measure(&self) -> Option<&str> {
        self.metadata.measure()
    }
    pub fn units(&self) -> Option<&str> {
        self.metadata.unit()
    }
    pub fn value(&self) -> Result<f64> {
        let unit = self.units().ok_or_else(|| {
            error(
                "UNRESOLVED_UNIT",
                "Choose a registered result unit with to(unit)",
            )
        })?;
        let (scale, offset) = exact(unit)?;
        to_float(&rational::divide(
            &rational::subtract(&self.base_value, &offset)?,
            &scale,
        )?)
    }
    pub fn to(&self, target: &str) -> Result<Self> {
        let metadata = analyze_unit(target)?;
        if self.metadata.dimensions != metadata.dimensions
            || (self.measure().is_some() && self.measure() != metadata.measure())
        {
            return Err(error(
                "INCOMPATIBLE_UNITS",
                format!("Cannot express this quantity in {target}"),
            ));
        }
        Self::from_base(self.base_value.clone(), metadata)
    }
    pub fn add(&self, other: &Self) -> Result<Self> {
        Self::from_base(
            rational::add(&self.base_value, &other.base_value)?,
            add_units(&self.metadata, &other.metadata)?,
        )
    }
    pub fn subtract(&self, other: &Self) -> Result<Self> {
        Self::from_base(
            rational::subtract(&self.base_value, &other.base_value)?,
            subtract_units(&self.metadata, &other.metadata)?,
        )
    }
    pub fn multiply(&self, other: &Self) -> Result<Self> {
        Self::from_base(
            rational::multiply(&self.base_value, &other.base_value)?,
            multiply_units(&self.metadata, &other.metadata)?,
        )
    }
    pub fn divide(&self, other: &Self) -> Result<Self> {
        Self::from_base(
            rational::divide(&self.base_value, &other.base_value)?,
            divide_units(&self.metadata, &other.metadata)?,
        )
    }
    pub fn pow(&self, exponent: i64) -> Result<Self> {
        let metadata = power_unit(&self.metadata, exponent)?;
        let exponent = i32::try_from(exponent)
            .map_err(|_| error("INVALID_VALUE", "Rational work limit exceeded"))?;
        Self::from_base(rational::power(&self.base_value, exponent)?, metadata)
    }
    pub fn to_value(&self) -> Result<QuantityValue> {
        Ok(QuantityValue {
            value: self.value()?,
            units: self.units().expect("value requires a unit").into(),
        })
    }
}
pub fn qty(value: f64, unit: &str) -> Result<Quantity> {
    Quantity::new(value, unit)
}
