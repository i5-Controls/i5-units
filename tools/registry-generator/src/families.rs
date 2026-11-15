use crate::{
    source::{Catalog, Entry, Family},
    values::*,
};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

fn prefix_symbols(catalog: &Catalog, selection: &Value, path: &str) -> Result<Vec<String>> {
    let selected = if selection == true {
        catalog
            .prefixes
            .as_object()
            .unwrap()
            .keys()
            .map(|s| Value::from(s.clone()))
            .collect()
    } else {
        selection
            .as_array()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| format!("{path}: prefixes must be true or a nonempty list"))?
            .clone()
    };
    selected
        .iter()
        .map(|prefix| {
            let symbol = prefix
                .as_str()
                .filter(|s| catalog.prefixes.get(*s).is_some())
                .ok_or_else(|| format!("{path}: unknown prefix {prefix}"))?;
            Ok(symbol.to_owned())
        })
        .collect()
}
fn simple(symbol: &str) -> bool {
    !symbol.is_empty() && symbol.chars().all(char::is_alphabetic)
}
pub fn declare_prefixes(catalog: &mut Catalog, symbol: &str, unit: &Value) -> Result<()> {
    let Some(selection) = unit.get("prefixes").filter(|v| **v != false) else {
        return Ok(());
    };
    if coefficient(unit.get("anchor_shift").unwrap_or(&json!(0)), symbol)? != 0.0 {
        return fail(symbol, "offset units cannot enable prefixes");
    }
    if selection.is_object() {
        object(
            selection,
            &format!("{symbol}.prefixes"),
            &["component", "symbols"],
        )?;
        let component = string(
            &selection["component"],
            &format!("{symbol}.prefixes.component"),
        )?;
        let suffix = symbol.strip_prefix(component).unwrap_or("");
        if unit["components"][component] != 1
            || !(suffix.starts_with('/') || suffix.starts_with('*'))
        {
            return fail(
                symbol,
                "prefix family must select the first numerator component with exponent 1",
            );
        }
        let enabled = prefix_symbols(
            catalog,
            &selection["symbols"],
            &format!("{symbol}.prefixes.symbols"),
        )?;
        catalog.families.push(Family {
            symbol: symbol.into(),
            component: component.into(),
            enabled,
        });
        return Ok(());
    }
    if !simple(symbol) {
        return fail(
            symbol,
            "define compound and powered units explicitly instead of prefixing their spelling",
        );
    }
    let base = catalog.entries[symbol].clone();
    for prefix in prefix_symbols(catalog, selection, symbol)? {
        let name = catalog.prefixes[&prefix]["name"].as_str().unwrap();
        let entry = Entry {
            name: json!({"singular": format!("{name}{}", unit["name"]["singular"].as_str().unwrap()), "plural": format!("{name}{}", unit["name"]["plural"].as_str().unwrap())}),
            source: Value::Null,
            prefix: Some(prefix.clone()),
            base_unit: Some(symbol.into()),
            ..base.clone()
        };
        catalog.put(&format!("{prefix}{symbol}"), entry)?;
    }
    Ok(())
}
pub fn expand(catalog: &mut Catalog) -> Result<()> {
    for family in catalog.families.clone() {
        let Family {
            symbol,
            component,
            enabled,
        } = family;
        let base = catalog
            .entries
            .get(&component)
            .filter(|entry| entry.prefix.is_none() && simple(&component))
            .ok_or_else(|| {
                format!("{symbol}: prefix family component must be an unprefixed simple unit")
            })?
            .clone();
        let entry = catalog.entries[&symbol].clone();
        for form in ["singular", "plural"] {
            if !entry.name[form]
                .as_str()
                .unwrap()
                .starts_with(&format!("{} ", base.name[form].as_str().unwrap()))
            {
                return fail(
                    &symbol,
                    &format!("prefix family {form} name must start with the component name"),
                );
            }
        }
        for prefix in enabled {
            let prefixed = format!("{prefix}{component}");
            if !catalog.entries.get(&prefixed).is_some_and(|v| {
                v.base_unit.as_deref() == Some(&component) && v.prefix.as_deref() == Some(&prefix)
            }) {
                return fail(
                    &symbol,
                    &format!("component {component} does not enable prefix {prefix}"),
                );
            }
            if entry.source["components"].get(&prefixed).is_some() {
                return fail(
                    &symbol,
                    &format!("prefix family creates duplicate component {prefixed}"),
                );
            }
            let components: Map<_, _> = entry.source["components"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, exponent)| {
                    (
                        if key == &component {
                            prefixed.clone()
                        } else {
                            key.clone()
                        },
                        exponent.clone(),
                    )
                })
                .collect();
            let name = catalog.prefixes[&prefix]["name"].as_str().unwrap();
            let generated = Entry {
                name: json!({"singular": format!("{name}{}", entry.name["singular"].as_str().unwrap()), "plural": format!("{name}{}", entry.name["plural"].as_str().unwrap())}),
                source: json!({"components": components}),
                prefix: None,
                base_unit: None,
                ..entry.clone()
            };
            catalog.put(&format!("{prefix}{symbol}"), generated)?;
        }
    }
    let mut expanded = HashSet::new();
    let mut expanding = HashSet::new();
    let names: Vec<_> = catalog.measures.keys().cloned().collect();
    for name in names {
        expand_quotients(catalog, &name, &mut expanded, &mut expanding)?;
    }
    Ok(())
}
fn select(
    catalog: &mut Catalog,
    selector: &Value,
    path: &str,
    expanded: &mut HashSet<String>,
    expanding: &mut HashSet<String>,
) -> Result<Vec<String>> {
    object(selector, path, &["measure", "units"])?;
    let measure = string(&selector["measure"], &format!("{path}.measure"))?;
    if !catalog.measures.contains_key(measure) {
        return fail(path, &format!("unknown measure {measure}"));
    }
    expand_quotients(catalog, measure, expanded, expanding)?;
    let selected = match selector.get("units") {
        None => catalog
            .entries
            .iter()
            .filter(|(_, entry)| entry.measure == measure)
            .map(|(key, _)| Value::from(key.clone()))
            .collect(),
        Some(value) => value
            .as_array()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| format!("{path}: units must select a nonempty list"))?
            .clone(),
    };
    if selected.is_empty() {
        return fail(path, "units must select a nonempty list");
    }
    let mut seen = HashSet::new();
    selected
        .into_iter()
        .map(|symbol| {
            let symbol = string(&symbol, path)?;
            if !seen.insert(symbol.to_owned()) {
                return fail(path, &format!("duplicate selected unit {symbol}"));
            }
            if !catalog
                .entries
                .get(symbol)
                .is_some_and(|v| v.measure == measure)
            {
                return fail(
                    path,
                    &format!("unit {symbol} does not belong to measure {measure}"),
                );
            }
            Ok(symbol.to_owned())
        })
        .collect()
}
fn expand_quotients(
    catalog: &mut Catalog,
    measure: &str,
    expanded: &mut HashSet<String>,
    expanding: &mut HashSet<String>,
) -> Result<()> {
    if expanded.contains(measure) {
        return Ok(());
    }
    if !expanding.insert(measure.into()) {
        return fail(measure, "quotient measure dependency cycle");
    }
    let quotients = catalog.definitions[measure]
        .get("quotients")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for (index, quotient) in quotients.iter().enumerate() {
        let path = format!("{measure}.quotients[{index}]");
        object(quotient, &path, &["numerator", "denominator", "spellings"])?;
        let numerator = select(
            catalog,
            &quotient["numerator"],
            &format!("{path}.numerator"),
            expanded,
            expanding,
        )?;
        let denominator = select(
            catalog,
            &quotient["denominator"],
            &format!("{path}.denominator"),
            expanded,
            expanding,
        )?;
        let selected_systems: HashSet<_> = numerator
            .iter()
            .map(|s| catalog.entries[s].system.clone())
            .collect();
        let systems = catalog.measures[quotient["numerator"]["measure"].as_str().unwrap()]
            ["systems"]
            .as_array()
            .unwrap()
            .clone();
        let target = catalog.measures[measure]["systems"].as_array_mut().unwrap();
        for system in systems {
            if selected_systems.contains(system.as_str().unwrap()) && !target.contains(&system) {
                target.push(system);
            }
        }
        let empty = json!({});
        let spellings = any_object(
            quotient.get("spellings").unwrap_or(&empty),
            &format!("{path}.spellings"),
        )?;
        for (from, to) in spellings {
            string(&Value::from(from.clone()), &format!("{path}.spellings"))?;
            string(to, &format!("{path}.spellings.{from}"))?;
        }
        let mut used = HashSet::new();
        let operand = |symbol: &str| {
            if symbol.contains(['/', '*']) {
                format!("({symbol})")
            } else {
                symbol.to_owned()
            }
        };
        for top in &numerator {
            for bottom in &denominator {
                if top == bottom {
                    return fail(&path, "identical quotient operands cancel; use ratio units");
                }
                let key = format!("{}/{}", operand(top), operand(bottom));
                let symbol = spellings.get(&key).and_then(Value::as_str).unwrap_or(&key);
                used.insert(key.clone());
                let (a, b) = (&catalog.entries[top], &catalog.entries[bottom]);
                let entry = Entry {
                    measure: measure.into(),
                    system: a.system.clone(),
                    name: json!({"singular": format!("{} per {}", a.name["singular"].as_str().unwrap(), b.name["singular"].as_str().unwrap()), "plural": format!("{} per {}", a.name["plural"].as_str().unwrap(), b.name["singular"].as_str().unwrap())}),
                    source: json!({"components": {top: 1, bottom: -1}}),
                    prefix: None,
                    base_unit: None,
                };
                catalog.put(symbol, entry)?;
            }
        }
        for key in spellings.keys() {
            if !used.contains(key) {
                return fail(&path, &format!("unused quotient spelling {key}"));
            }
        }
    }
    expanding.remove(measure);
    expanded.insert(measure.into());
    Ok(())
}
