use crate::{source::Catalog, values::*};
use num_traits::{One, Zero};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};

#[derive(Clone)]
struct Factor {
    scale: Ratio,
    offset: Ratio,
}
type Bridges = HashMap<String, HashMap<String, Factor>>;

fn bridges(catalog: &Catalog) -> Result<Bridges> {
    let mut bridges = HashMap::new();
    for (measure, definition) in catalog.definitions.as_object().unwrap() {
        let reference = catalog
            .entries
            .get(definition["reference_unit"].as_str().unwrap())
            .filter(|v| v.measure == *measure)
            .ok_or_else(|| format!("{measure}: reference_unit must name a unit in this measure"))?;
        let systems: Vec<_> = catalog.measures[measure]["systems"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap())
            .collect();
        let empty = json!({});
        let anchors = object(
            definition.get("anchors").unwrap_or(&empty),
            &format!("{measure}.anchors"),
            &systems,
        )?;
        let mut local = HashMap::from([(
            reference.system.clone(),
            Factor {
                scale: one(),
                offset: zero(),
            },
        )]);
        for (source, destinations) in anchors {
            for (target, anchor) in object(
                destinations,
                &format!("{measure}.anchors.{source}"),
                &systems,
            )? {
                if source == target {
                    return fail(measure, "self anchors are not allowed");
                }
                if target != &reference.system {
                    return fail(
                        measure,
                        "define each anchor directly to the reference system",
                    );
                }
                object(anchor, measure, &["ratio", "transform"])?;
                if anchor.get("ratio").is_some() == anchor.get("transform").is_some() {
                    return fail(measure, "anchor needs exactly one of ratio or transform");
                }
                let (scale, offset) = if let Some(ratio) = anchor.get("ratio") {
                    (coefficient_ratio(ratio, measure)?, zero())
                } else {
                    let transform = &anchor["transform"];
                    object(transform, measure, &["scale", "offset"])?;
                    let scale = coefficient_ratio(&transform["scale"], measure)?;
                    let offset = coefficient_ratio(&transform["offset"], measure)?;
                    if !offset.is_zero() && definition["kind"] != "absolute" {
                        return fail(measure, "only absolute measures may have offset transforms");
                    }
                    (scale, offset)
                };
                if scale <= zero() {
                    return fail(measure, "anchor scale must be positive");
                }
                local.insert(source.clone(), Factor { scale, offset });
            }
        }
        bridges.insert(measure.clone(), local);
    }
    Ok(bridges)
}
struct Resolver<'a> {
    catalog: &'a Catalog,
    bridges: Bridges,
    resolved: BTreeMap<String, Factor>,
    units: BTreeMap<String, Value>,
    stack: Vec<String>,
}
impl Resolver<'_> {
    fn resolve(&mut self, symbol: &str) -> Result<Factor> {
        if let Some(value) = self.resolved.get(symbol) {
            return Ok(value.clone());
        }
        let entry = self
            .catalog
            .entries
            .get(symbol)
            .ok_or_else(|| format!("{symbol}: unknown component unit"))?
            .clone();
        if self.stack.iter().any(|s| s == symbol) {
            return fail(
                symbol,
                &format!(
                    "component dependency cycle: {} -> {symbol}",
                    self.stack.join(" -> ")
                ),
            );
        }
        self.stack.push(symbol.into());
        let measure = &self.catalog.measures[&entry.measure];
        let mut offset = zero();
        let scale;
        if let Some(prefix) = &entry.prefix {
            let base = self.resolve(entry.base_unit.as_deref().unwrap())?;
            if !base.offset.is_zero() {
                return fail(symbol, "offset units cannot enable prefixes");
            }
            let exponent = safe_integer(&self.catalog.prefixes[prefix]["exponent"]).unwrap();
            scale = checked(
                base.scale * pow(&Ratio::from_integer(10.into()), exponent, symbol)?,
                symbol,
            )?;
        } else if let Some(components) = entry.source.get("components") {
            let mut dimensions: BTreeMap<String, i64> = BTreeMap::new();
            let mut factor = one();
            for (component, exponent) in components.as_object().unwrap() {
                let exponent = safe_integer(exponent).unwrap();
                let result = self.resolve(component)?;
                let component_measure =
                    &self.catalog.measures[&self.catalog.entries[component].measure];
                if component_measure["kind"] == "absolute" || !result.offset.is_zero() {
                    return fail(symbol, "components must be linear or difference units");
                }
                factor = checked(factor * pow(&result.scale, exponent, symbol)?, symbol)?;
                for (dimension, power) in component_measure["dimensions"].as_object().unwrap() {
                    let next = safe_integer(power)
                        .unwrap()
                        .checked_mul(exponent)
                        .and_then(|v| {
                            dimensions
                                .get(dimension)
                                .copied()
                                .unwrap_or(0)
                                .checked_add(v)
                        })
                        .filter(|v| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(v))
                        .ok_or_else(|| {
                            format!("{symbol}: component dimensions exceed safe integer range")
                        })?;
                    if next == 0 {
                        dimensions.remove(dimension);
                    } else {
                        dimensions.insert(dimension.clone(), next);
                    }
                }
            }
            if dimension_key(&json!(dimensions)) != dimension_key(&measure["dimensions"]) {
                return fail(symbol, "component dimensions do not match its measure");
            }
            scale = factor;
        } else {
            let bridge = self.bridges[&entry.measure]
                .get(&entry.system)
                .ok_or_else(|| {
                    format!(
                        "{}.{}: missing anchor to reference system",
                        entry.measure, entry.system
                    )
                })?;
            scale = checked(
                coefficient_ratio(&entry.source["to_anchor"], symbol)? * &bridge.scale,
                symbol,
            )?;
            offset = checked(
                -coefficient_ratio(
                    entry.source.get("anchor_shift").unwrap_or(&json!(0)),
                    symbol,
                )? * &bridge.scale
                    + &bridge.offset,
                symbol,
            )?;
        }
        let numeric_scale = numeric(&scale, &format!("{symbol}.scale"))?;
        if numeric_scale.as_f64().unwrap() <= 0.0 {
            return fail(symbol, "normalized scale must be positive");
        }
        let mut unit = json!({"measure": entry.measure, "system": entry.system, "name": entry.name,
            "scale": numeric_scale, "offset": numeric(&offset, &format!("{symbol}.offset"))?, "scale_ratio": wire(&scale), "offset_ratio": wire(&offset)});
        if let Some(prefix) = entry.prefix {
            unit["prefix"] = json!(prefix);
            unit["base_unit"] = json!(entry.base_unit);
        }
        if let Some(components) = entry.source.get("components") {
            unit["components"] = components.clone();
        }
        self.units.insert(symbol.into(), unit);
        let factor = Factor { scale, offset };
        self.resolved.insert(symbol.into(), factor.clone());
        self.stack.pop();
        Ok(factor)
    }
    fn validate(&mut self) -> Result<()> {
        for (name, measure) in &self.catalog.measures {
            let reference_symbol = measure["reference_unit"].as_str().unwrap();
            let reference = self.resolve(reference_symbol)?;
            if !reference.scale.is_one() || !reference.offset.is_zero() {
                return fail(
                    name,
                    "reference_unit must have coherent scale 1 and no shift",
                );
            }
            let dimensions = measure["dimensions"].as_object().unwrap();
            if (dimensions.len() > 1 || dimensions.values().any(|v| *v != 1))
                && self.catalog.entries[reference_symbol]
                    .source
                    .get("components")
                    .is_none()
            {
                return fail(name, "derived reference_unit must declare components");
            }
            for system in measure["systems"].as_array().unwrap() {
                let system = system.as_str().unwrap();
                let local: Vec<_> = self
                    .catalog
                    .entries
                    .iter()
                    .filter(|(_, entry)| entry.measure == *name && entry.system == system)
                    .collect();
                let explicit = local.iter().any(|(_, entry)| {
                    !entry.source.is_null() && entry.source.get("components").is_none()
                });
                let mut has_anchor = false;
                for (symbol, entry) in local {
                    let source = if let Some(base) = &entry.base_unit {
                        &self.catalog.entries[base].source
                    } else {
                        &entry.source
                    };
                    if source.is_null() {
                        continue;
                    }
                    if source.get("components").is_some() {
                        let value = &self.resolved[symbol];
                        if let Some(bridge) = self.bridges[name].get(system) {
                            has_anchor |=
                                value.offset.is_zero() && (&value.scale / &bridge.scale).is_one();
                        }
                    } else {
                        let factor = entry.prefix.as_ref().map_or(1.0, |prefix| {
                            10f64.powf(self.catalog.prefixes[prefix]["exponent"].as_f64().unwrap())
                        });
                        has_anchor |= coefficient(&source["to_anchor"], symbol)? * factor == 1.0
                            && coefficient(
                                source.get("anchor_shift").unwrap_or(&json!(0)),
                                symbol,
                            )? == 0.0;
                    }
                }
                if explicit && !has_anchor {
                    return fail(
                        &format!("{name}.{system}"),
                        "requires an anchor unit with to_anchor 1 and no shift",
                    );
                }
            }
        }
        for (dimension, symbol) in self.catalog.config["basis"].as_object().unwrap() {
            let symbol = symbol.as_str().unwrap();
            let entry =
                self.catalog.entries.get(symbol).ok_or_else(|| {
                    format!("{dimension}: basis unit must match its base dimension")
                })?;
            if dimension_key(&self.catalog.measures[&entry.measure]["dimensions"])
                != dimension_key(&json!({dimension: 1}))
            {
                return fail(dimension, "basis unit must match its base dimension");
            }
            let factor = self.resolve(symbol)?;
            if !factor.scale.is_one() || !factor.offset.is_zero() {
                return fail(symbol, "basis unit must have coherent scale 1 and no shift");
            }
        }
        Ok(())
    }
}
pub fn resolve(catalog: &Catalog) -> Result<Value> {
    let mut resolver = Resolver {
        catalog,
        bridges: bridges(catalog)?,
        resolved: BTreeMap::new(),
        units: BTreeMap::new(),
        stack: vec![],
    };
    for symbol in catalog.entries.keys() {
        resolver.resolve(symbol)?;
    }
    resolver.validate()?;
    Ok(Value::Object(
        resolver.units.into_iter().collect::<Map<_, _>>(),
    ))
}
