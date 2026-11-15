# i5-units

Rust unit conversion and dimensional quantities using the same generated JSON
registry as the Python `i5-units` and Node `@i5controls/i5-units` packages.
The registry is embedded in the crate; no runtime files or Node/Python tools are
required. Rust 1.80 or newer is required.

```rust
use i5_units::{convert, qty, Result};

fn main() -> Result<()> {
    assert_eq!(convert(1.0, "s", "µs")?, 1_000_000.0);
    let velocity = qty(10.0, "m")?.divide(&qty(2.0, "ms")?)?;
    assert_eq!(velocity.to("km/h")?.value()?, 18_000.0);
    assert_eq!(qty(1.0, "m")?.add(&qty(50.0, "cm")?)?.value()?, 1.5);
    Ok(())
}
```

Install from the repository with
`cargo add i5-units --git <repository-url> --rev <commit>`.
Cargo discovers this workspace member automatically. The Rust import name is
`i5_units`. Git consumers do not run the generator.

`conversion_plan`, `describe`, `has_unit`, `parse_unit`, `parse_measure`,
`can_convert`, `list_units`, `possibilities`, and `measures` provide conversion
planning, validation, and discovery. Discovery results are sorted by spelling.
`analyze_unit` / `analyze_dimensions` return immutable metadata accepted by
`add_units`, `subtract_units`, `multiply_units`, `divide_units`, and `power_unit`.
`validate_numeric` and `convert_and_validate` accept `NumericConstraints`.
Fallible APIs return `Result<T, UnitError>` with the shared string error codes.

Quantities keep exact, bounded rational magnitudes and round on `value()` or
`to_value()`. Use named methods (`add`, `subtract`, `multiply`, `divide`, `pow`)
for arithmetic. `to_value()` returns a serde-serializable `{ value, units }`.
Ambiguous dimensions require an explicit `.to("J")` or `.to("N*m")` before
reading a value. Absolute temperatures follow the same arithmetic restrictions
as the Python and TypeScript libraries.

Run `cargo test --workspace --locked` from the repository root.
