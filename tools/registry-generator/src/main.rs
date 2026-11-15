mod artifacts;
mod families;
mod resolution;
mod source;
mod values;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};
use values::{canonical, fail, Result};

fn build(config: Value, prefixes: Value, definitions: Value) -> Result<Value> {
    let mut catalog = source::collect(config, prefixes, definitions)?;
    families::expand(&mut catalog)?;
    let mut registry = json!({"version": catalog.config["version"], "format_version": catalog.config["format_version"],
        "basis": catalog.config["basis"], "dimensions": catalog.config["dimensions"], "prefixes": catalog.prefixes,
        "measures": catalog.measures, "units": resolution::resolve(&catalog)?});
    registry["fingerprint"] = json!(format!(
        "sha256:{:x}",
        Sha256::digest(values::compact(&canonical(&registry)))
    ));
    Ok(values::js_order(&registry))
}
fn read(path: impl AsRef<Path>) -> Result<Value> {
    serde_json::from_str(
        &fs::read_to_string(path.as_ref())
            .map_err(|e| format!("{}: {e}", path.as_ref().display()))?,
    )
    .map_err(|e| e.to_string())
}
fn manifest_version(path: &Path) -> Result<String> {
    let manifest = fs::read_to_string(path).map_err(|e| e.to_string())?;
    manifest
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once('=')?;
            if key.trim() == "version" {
                Some(value.trim().trim_matches('"').to_owned())
            } else {
                None
            }
        })
        .ok_or_else(|| format!("{}: missing version", path.display()))
}
fn generate(root: &Path, check: bool) -> Result<()> {
    let mut paths = fs::read_dir(root.join("definitions"))
        .map_err(|e| e.to_string())?
        .map(|e| e.map(|entry| entry.path()))
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    paths.sort();
    let mut definitions = serde_json::Map::new();
    for path in paths {
        if path.extension().is_some_and(|ext| ext == "json") {
            definitions.insert(
                path.file_stem()
                    .unwrap()
                    .to_str()
                    .ok_or("Non-UTF8 definition filename")?
                    .into(),
                read(&path)?,
            );
        }
    }
    let registry = build(
        read(root.join("registry.json"))?,
        read(root.join("prefixes.json"))?,
        Value::Object(definitions),
    )?;
    let version = registry["version"].as_str().unwrap();
    if read(root.join("package.json"))?["version"] != version {
        return fail("registry.version", "must match package.json");
    }
    for path in [
        "python/pyproject.toml",
        "rust/Cargo.toml",
        "tools/registry-generator/Cargo.toml",
    ] {
        if manifest_version(&root.join(path))? != version {
            return fail("registry.version", &format!("must match {path}"));
        }
    }
    for (path, content) in artifacts::render(&registry, &read(root.join("spec/fixtures.json"))?)? {
        let target = root.join(&path);
        if check {
            if fs::read_to_string(&target).ok().as_deref() != Some(&content) {
                return fail(&path, "is stale; run npm run schema:generate");
            }
        } else {
            fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::write(target, content).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn run() -> Result<()> {
    let mut root = std::env::current_dir().map_err(|e| e.to_string())?;
    let mut check = false;
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--root" => root = PathBuf::from(args.next().ok_or("--root requires a path")?),
            "--check" => check = true,
            "--stdin" => {
                let mut input = String::new();
                io::stdin()
                    .read_to_string(&mut input)
                    .map_err(|e| e.to_string())?;
                let input: Value = serde_json::from_str(&input).map_err(|e| e.to_string())?;
                let registry = build(
                    input["config"].clone(),
                    input["prefixes"].clone(),
                    input["definitions"].clone(),
                )?;
                println!("{}", values::compact(&registry));
                return Ok(());
            }
            _ => return Err("Usage: i5-units-generator [--check] [--root PATH] [--stdin]".into()),
        }
    }
    generate(&root, check)
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
