use crate::{families::declare_prefixes, values::*};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone)]
pub struct Entry {
    pub measure: String,
    pub system: String,
    pub name: Value,
    pub source: Value,
    pub prefix: Option<String>,
    pub base_unit: Option<String>,
}
#[derive(Clone)]
pub struct Family {
    pub symbol: String,
    pub component: String,
    pub enabled: Vec<String>,
}
pub struct Catalog {
    pub config: Value,
    pub prefixes: Value,
    pub definitions: Value,
    pub entries: BTreeMap<String, Entry>,
    pub measures: Map<String, Value>,
    pub families: Vec<Family>,
}
impl Catalog {
    pub fn put(&mut self, symbol: &str, entry: Entry) -> Result<()> {
        string(&Value::from(symbol), &format!("{} unit", entry.measure))?;
        if self.entries.contains_key(symbol) {
            return fail(
                &format!("{}.{symbol}", entry.measure),
                "duplicate unit spelling (including generated prefixes)",
            );
        }
        let systems = self.measures[&entry.measure]["systems"]
            .as_array_mut()
            .unwrap();
        if !systems.iter().any(|v| v == &entry.system) {
            systems.push(Value::from(entry.system.clone()));
        }
        self.entries.insert(symbol.into(), entry);
        Ok(())
    }
}
pub fn collect(config: Value, prefixes: Value, definitions: Value) -> Result<Catalog> {
    object(
        &config,
        "registry",
        &["version", "format_version", "dimensions", "basis"],
    )?;
    string(&config["version"], "registry.version")?;
    if config["format_version"] != 1 {
        return fail("registry.format_version", "must be 1");
    }
    let dimensions = config["dimensions"]
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or("registry.dimensions: must be a nonempty array")?;
    let mut names = HashSet::new();
    for dimension in dimensions {
        let dimension = string(dimension, "registry.dimensions")?;
        if !names.insert(dimension.to_owned()) {
            return fail(dimension, "duplicate dimension");
        }
    }
    let dimension_names: Vec<&str> = names.iter().map(String::as_str).collect();
    for (dimension, unit) in object(&config["basis"], "registry.basis", &dimension_names)? {
        string(unit, &format!("registry.basis.{dimension}"))?;
    }
    for (symbol, prefix) in any_object(&prefixes, "prefixes")? {
        string(&Value::from(symbol.clone()), "prefix symbol")?;
        object(prefix, &format!("prefixes.{symbol}"), &["name", "exponent"])?;
        string(&prefix["name"], &format!("prefixes.{symbol}.name"))?;
        let exponent = safe_integer(&prefix["exponent"])
            .filter(|v| *v != 0)
            .ok_or_else(|| format!("prefixes.{symbol}.exponent: must be a nonzero integer"))?;
        let factor = 10f64.powf(exponent as f64);
        if !factor.is_finite() {
            return fail(symbol, "must be a finite number");
        }
        if factor <= 0.0 {
            return fail(symbol, "prefix factor must be positive");
        }
    }
    any_object(&definitions, "definitions")?;
    let mut catalog = Catalog {
        config,
        prefixes,
        definitions,
        entries: BTreeMap::new(),
        measures: Map::new(),
        families: vec![],
    };
    let mut defaults = HashMap::new();
    let mut ordered: Vec<_> = catalog
        .definitions
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    ordered.sort();
    for measure in ordered {
        let definition = catalog.definitions[&measure].clone();
        string(&Value::from(measure.clone()), "measure name")?;
        object(
            &definition,
            &measure,
            &[
                "dimensions",
                "reference_unit",
                "systems",
                "anchors",
                "kind",
                "default_result",
                "quotients",
            ],
        )?;
        let kind = definition
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("linear");
        if !["linear", "absolute", "difference"].contains(&kind)
            || definition.get("kind").is_some_and(|v| !v.is_string())
        {
            return fail(&measure, "invalid measure kind");
        }
        let dimensions = object(
            &definition["dimensions"],
            &format!("{measure}.dimensions"),
            &dimension_names,
        )?;
        for (dimension, exponent) in dimensions {
            if safe_integer(exponent).filter(|v| *v != 0).is_none() {
                return fail(
                    &format!("{measure}.dimensions.{dimension}"),
                    "must be a nonzero safe integer",
                );
            }
            if catalog.config["basis"].get(dimension).is_none() {
                return fail(
                    &format!("{measure}.dimensions.{dimension}"),
                    "requires a declared coherent basis unit",
                );
            }
        }
        if definition
            .get("default_result")
            .is_some_and(|v| !v.is_boolean())
        {
            return fail(&measure, "default_result must be boolean");
        }
        if definition["default_result"] == true {
            if kind == "absolute" {
                return fail(
                    &measure,
                    "absolute measures cannot be default arithmetic results",
                );
            }
            let key = dimension_key(&definition["dimensions"]);
            if let Some(previous) = defaults.insert(key, measure.clone()) {
                return fail(
                    &measure,
                    &format!("duplicate default result with {previous}"),
                );
            }
        }
        string(
            &definition["reference_unit"],
            &format!("{measure}.reference_unit"),
        )?;
        let empty = json!({});
        let systems = any_object(
            definition.get("systems").unwrap_or(&empty),
            &format!("{measure}.systems"),
        )?;
        if let Some(quotients) = definition.get("quotients") {
            if !quotients.as_array().is_some_and(|v| !v.is_empty()) {
                return fail(&measure, "quotients must be a nonempty list");
            }
            if kind == "absolute" {
                return fail(&measure, "quotients cannot define absolute measures");
            }
        }
        if systems.is_empty()
            && (definition.get("systems").is_some() || definition.get("quotients").is_none())
        {
            return fail(&measure, "requires systems or quotient families");
        }
        catalog.measures.insert(measure.clone(), json!({
            "dimensions": canonical(&definition["dimensions"]), "reference_unit": definition["reference_unit"], "kind": kind,
            "default_result": definition.get("default_result").unwrap_or(&Value::Bool(false)), "systems": systems.keys().collect::<Vec<_>>()
        }));
        for (system, units) in systems {
            string(&Value::from(system.clone()), &format!("{measure} system"))?;
            for (symbol, unit) in any_object(units, &format!("{measure}.{system}"))? {
                validate_unit(symbol, unit, &measure, system, kind)?;
                catalog.put(
                    symbol,
                    Entry {
                        measure: measure.clone(),
                        system: system.clone(),
                        name: unit["name"].clone(),
                        source: unit.clone(),
                        prefix: None,
                        base_unit: None,
                    },
                )?;
                declare_prefixes(&mut catalog, symbol, unit)?;
            }
        }
    }
    if catalog.measures.is_empty() {
        return fail("definitions", "requires a measure");
    }
    Ok(catalog)
}
fn validate_unit(
    symbol: &str,
    unit: &Value,
    measure: &str,
    system: &str,
    kind: &str,
) -> Result<()> {
    string(&Value::from(symbol), &format!("{measure}.{system} unit"))?;
    object(
        unit,
        &format!("{measure}.{symbol}"),
        &[
            "name",
            "to_anchor",
            "anchor_shift",
            "prefixes",
            "components",
        ],
    )?;
    object(
        &unit["name"],
        &format!("{symbol}.name"),
        &["singular", "plural"],
    )?;
    for form in ["singular", "plural"] {
        string(&unit["name"][form], &format!("{symbol}.name.{form}"))?;
    }
    if unit.get("components").is_some() == unit.get("to_anchor").is_some() {
        return fail(symbol, "needs exactly one of components or to_anchor");
    }
    if let Some(components) = unit.get("components") {
        let components = any_object(components, &format!("{symbol}.components"))?;
        if components.is_empty() {
            return fail(symbol, "components must not be empty");
        }
        for (component, exponent) in components {
            string(
                &Value::from(component.clone()),
                &format!("{symbol}.components"),
            )?;
            if safe_integer(exponent).filter(|v| *v != 0).is_none() {
                return fail(symbol, "component exponents must be nonzero safe integers");
            }
        }
        if unit.get("anchor_shift").is_some() || kind == "absolute" {
            return fail(
                symbol,
                "components cannot define an absolute or shifted unit",
            );
        }
    } else {
        if coefficient(&unit["to_anchor"], symbol)? <= 0.0 {
            return fail(symbol, "to_anchor must be positive");
        }
        if coefficient(unit.get("anchor_shift").unwrap_or(&json!(0)), symbol)? != 0.0
            && kind != "absolute"
        {
            return fail(symbol, "only absolute measures may have an anchor_shift");
        }
    }
    Ok(())
}
