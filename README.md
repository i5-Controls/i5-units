# i5-units

A JSON unit registry shared by TypeScript, Python, and Rust, with a
[convert-units-style](https://github.com/convert-units/convert-units) conversion
API and dimensional quantity arithmetic. The Node and Python libraries have no
runtime dependencies. Rust uses serde and bounded arbitrary-precision rationals.

## Install from Git

All three packages live in this repository. Replace `COMMIT` with a full commit
SHA (or use a release tag) that contains the generated artifacts.

```sh
# Node.js 22.12+ / TypeScript, using either package manager
pnpm add '@i5controls/i5-units@git+https://github.com/i5-Controls/i5-units.git#COMMIT'
npm install '@i5controls/i5-units@git+https://github.com/i5-Controls/i5-units.git#COMMIT'

# Python 3.12+; uv selects the Python package subdirectory
uv add 'i5-units @ git+https://github.com/i5-Controls/i5-units.git@COMMIT#subdirectory=python'

# Rust 1.80+; Cargo discovers the rust/ workspace member
cargo add i5-units --git https://github.com/i5-Controls/i5-units.git --rev COMMIT
```

The equivalent Cargo dependency is:

```toml
[dependencies]
i5-units = { git = "https://github.com/i5-Controls/i5-units.git", rev = "COMMIT" }
```

The Node package exports compiled ESM JavaScript and TypeScript declarations
from committed `dist/`. Modern Node can also load it with `require()`.
Git installs need no compiler or generation step. The development command is
named `build:node` because npm treats a script named `build` as a reason to
install a Git dependency's development dependencies. Python bundles its registry;
Rust embeds its copy at compile time. Each package works independently.

## Rust

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

Rust exposes discovery, conversion plans, dimensional analysis, quantity
arithmetic, numeric constraints, registry version/fingerprint metadata, and the
shared error codes. Fallible operations return `Result<T, UnitError>`.
See [rust/README.md](rust/README.md) for the Rust API conventions.

Each unit has exactly one spelling. Its key is its identifier everywhere:
`s`, `ms`, `µs`, `m`, `m/s`, `Pa`, `bar`, `C`, `F`, `K`, and so on. Matching is
case-sensitive. There are no aliases, alternate IDs, automatic case conversion,
Unicode normalization, or free-form unit-expression parsing. In particular,
micro uses `µ` (U+00B5), so `us` and Greek `μs` are unknown units.

Pressure units include `mmHg`, `Torr`, `inHg`, and `atm`. Mercury units use
conventional mercury-column pressure; `inHg` is 25.4 `mmHg`. A standard atmosphere
is 101325 Pa, and a torr is exactly 1/760 of a standard atmosphere. `mmHg` and
`Torr` are distinct units with slightly different scales. The `inHg` coefficient
is expressed relative to the imperial `psi` anchor so its Pascal scale is
3386.388640341. See the [NIST pressure conversion tables](https://www.nist.gov/pml/special-publication-811/nist-guide-si-appendix-b-conversion-factors/nist-guide-si-appendix-b9).

This package is standalone. Compiler validation, application duration handling,
server command conversion, and telemetry normalization have not adopted this
registry. Instrument unit labels retain their existing behavior.

## TypeScript

```ts
import {
  convert,
  qty,
  hasUnit,
  describe,
  canConvert,
  parseUnit,
  divideUnits,
  conversionPlan,
  type Unit,
} from "@i5controls/i5-units";

convert(1).from("s").to("ms"); // 1000
convert(1).from("ms").to("µs"); // 1000
convert(1).from("s").to("µs"); // 1000000

const velocity = qty(10, "m").divide(qty(2, "ms"));
velocity.toJSON(); // { value: 5000, units: "m/s" }
velocity.to("km/h").toJSON(); // { value: 18000, units: "km/h" }

qty(1, "m").add(qty(50, "cm")).toJSON(); // { value: 1.5, units: "m" }
hasUnit("Bar"); // false
canConvert("ms", "µs"); // true
describe("µs"); // includes measure, system, dimensions, prefix, base_unit

const unit: Unit = "µs"; // generated union of all registered spellings
const incoming = parseUnit("ms"); // validate an external string
conversionPlan(incoming, "µs").convert(1); // 1000
divideUnits("m", "s"); // dimensions, velocity measure, and canonical m/s
```

`convert().list(measure?)`, `convert().possibilities(measure?)`,
`convert().describe(unit)` and `convert().measures()` support discovery. The
functions are also exported directly as `list`, `possibilities`, `describe`, and
`measures`. `convert().from("ms").possibilities()` lists time units.

## Python

The distribution is `i5-units`; imports use `i5_units`. Python 3.12 or newer is
required. The generated registry is bundled in wheels and source distributions.

```python
from i5_units import convert, qty, has_unit, can_convert, describe

convert(1).from_("s").to("µs")  # 1000000.0

velocity = qty(10, "m") / qty(2, "ms")
velocity.to_dict()  # {"value": 5000.0, "units": "m/s"}
velocity.to("km/h").to_dict()  # {"value": 18000.0, "units": "km/h"}

(qty(1, "m") + qty(50, "cm")).value  # 1.5
qty(2, "cm").pow(2).to("cm2").value  # 4.0
```

Python supports `+`, `-`, `*`, `/`, and `**`, as well as the named methods shared
with TypeScript: `add`, `subtract`, `multiply`, `divide`, and `pow`.
Use `from_` because `from` is a Python keyword. Discovery is available on
`convert()` and through `list_units`, `possibilities`, `describe`, and `measures`.
Version metadata is `registryVersion` in TypeScript and `registry_version` in
Python. The corresponding fingerprint and definition-format version exports are
`registryFingerprint` / `registry_fingerprint` and
`registryFormatVersion` / `registry_format_version`. Fingerprints cover the
canonical generated registry, including exact factors and default-result rules.
The Rust generator checks that the registry, Node, Python, Rust, and generator
release versions agree.

Typed APIs accept canonical `Unit` values. Use `parseUnit(unknown)` /
`parse_unit(object)` for external strings, and `parseMeasure` / `parse_measure`
for external measure names. TypeScript also exports `UnitOfMeasure<M>` and
`UnitsByMeasure`; Python bundles the generated `Unit` Literal type.

## Authoritative JSON

| Source                        | Purpose                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `registry.json`               | Registry/format versions, dimensions, and coherent basis units |
| `prefixes.json`               | Prefix symbols, names, and decimal exponents                   |
| `definitions/<measure>.json`  | Dimensions, reference unit, explicit units, and unit families  |
| `spec/definition.schema.json` | JSON Schema for a measure definition                           |
| `spec/fixtures.json`          | Shared conversion, arithmetic, and error cases                 |

The definition filename supplies the measure name. For example, `time.json`
contains:

```json
{
  "dimensions": { "time": 1 },
  "reference_unit": "s",
  "default_result": true,
  "systems": {
    "metric": {
      "s": {
        "name": { "singular": "second", "plural": "seconds" },
        "to_anchor": 1,
        "prefixes": true
      },
      "min": {
        "name": { "singular": "minute", "plural": "minutes" },
        "to_anchor": 60
      }
    }
  }
}
```

`prefixes: true` enables every entry in `prefixes.json`; an array such as
`["m", "µ", "n"]` enables only those prefixes. Omission or `false` disables
prefixes. Expansion happens once during generation, so generated units are real
registry members and TypeScript union members. It does not recursively stack
prefixes: `mms` is invalid. Collisions between explicit or generated unit keys
are errors, including collisions across systems and measures. Boolean and array
prefix declarations apply to simple unit symbols. Offset units cannot enable
prefixes.

For a compound unit, select the component to prefix:

```json
{
  "L/min": {
    "name": {
      "singular": "liter per minute",
      "plural": "liters per minute"
    },
    "components": { "L": 1, "min": -1 },
    "prefixes": { "component": "L", "symbols": true }
  }
}
```

This one declaration produces `nL/min`, `µL/min`, `mL/min`, `kL/min`, and every
other enabled SI prefix, in addition to `L/min`. Set `symbols` to an explicit
list such as `["n", "µ", "m"]` to limit the family. The component must already
enable every requested prefix. Expansion produces ordinary component-based
units: `mL/min` has `components: { "mL": 1, "min": -1 }`, with its name and exact
factor derived automatically. Generated JSON and TypeScript/Python unit types
still enumerate every supported spelling.

The selected component must be an unprefixed simple unit, must appear first in
the compound spelling with exponent 1, and must begin the singular/plural names.
For example, use `g/s` with component `g` to generate `kg/s`; selecting `kg`
would stack prefixes. Denominator and powered-component prefix families are
not supported. Define `cm2`, `mm3`, and `km/h` explicitly through their registered
components; a single linear prefix factor on `m2` would give incorrect results.

The prefix table follows the [BIPM SI prefixes](https://www.bipm.org/en/measurement-units/si-prefixes),
including micro through quecto and kilo through quetta. Enabling a prefix is an
explicit registry policy, independent of a system's name.

`to_anchor` and `anchor_shift` use convert-units' arithmetic:

```text
system_anchor = input * to_anchor - anchor_shift
```

Systems using explicit anchor factors must include an anchor unit with
`to_anchor = 1` and zero shift. Component-only systems do not require anchors.
For multiple systems, define each other system's anchor directly to the
reference unit's system. Reverse conversions are computed automatically. An
anchor has either a `ratio` or a JSON `transform`:

```json
{
  "anchors": {
    "imperial": {
      "metric": {
        "transform": { "scale": 0.5, "offset": 10 }
      }
    }
  }
}
```

Transforms compute `anchor * scale + offset`. Numeric coefficients can also be
`{ "numerator": 5, "denominator": 9 }`. JavaScript functions and string
expressions are not part of the format. Offset transforms are restricted to
absolute measures. The generator normalizes every unit to a finite positive
`scale` and finite `offset` relative to the measure's reference unit.

Every explicit unit declares exactly one of `to_anchor` or `components`. For example:

```json
{
  "km/h": {
    "name": {
      "singular": "kilometer per hour",
      "plural": "kilometers per hour"
    },
    "components": { "km": 1, "h": -1 }
  },
  "cm2": {
    "name": { "singular": "square centimeter", "plural": "square centimeters" },
    "components": { "cm": 2 }
  }
}
```

Component keys refer to registered canonical units, including generated prefixes.
The generator resolves the dependency graph, derives exact scales and dimensions,
and rejects cycles, unknown components, mismatched dimensions, and absolute
or offset components. A derived measure's reference unit must declare components.

`registry.json` declares coherent `basis` units such as `m`, `kg`, `s`, `A`, `K`,
and `rad`. Every used base dimension requires a basis unit. Basis and reference
units must have normalized scale 1 and zero offset. This prevents an accidental
centimeter-based length reference from silently corrupting `m/s` arithmetic.
Mass's `g.to_anchor = 0.001` generates the coherent `kg` through its `k` prefix.
The generated registry stores normalized numeric factors for inspection and
exact numerator/denominator strings for calculation.

### Quotient families

Derived measures can declare relationships between source measures instead of
listing each combination. For example, `massFlowRate.json` contains:

```json
{
  "dimensions": { "mass": 1, "time": -1 },
  "reference_unit": "kg/s",
  "default_result": true,
  "quotients": [
    {
      "numerator": { "measure": "mass" },
      "denominator": { "measure": "time" }
    }
  ]
}
```

This generates every registered mass unit divided by every registered time unit:
`g/s`, `mg/ms`, `µg/µs`, `kg/d`, `lb/h`, and so on. Prefixes come from the source registries;
names, exact factors, and components come from both source units. The result
inherits the numerator's system, so pound rates remain imperial. Adding a mass
unit automatically adds its flow rates without editing this file.

Each selector names a `measure` and may provide a nonempty `units` list to limit
its selection. Omitting `units` includes the measure's full expanded inventory.
Quotient families may depend on other quotient measures; the generator resolves
those dependencies and rejects cycles. Compound operands are parenthesized in
generated spellings, such as `(m/s)/s`. Identical operands that cancel should use
the existing ratio units instead.

A measure may contain `systems` for explicit units, `quotients`, or both.
Duplicate spellings are errors, including overlaps between explicit units and
families. A quotient may specify canonical spellings for selected pairs:

```json
"spellings": { "SL/min": "slpm", "scc/min": "sccm" }
```

Only the chosen spelling is registered; this does not add runtime aliases.
Unused spelling overrides are rejected. Dimensions and reference units remain
explicit declarations and are checked against the generated components.

## Flow units

`volumeFlowRate` is the quotient of registered volume units and all registered
time units, with coherent reference unit `m3/s`. `massFlowRate` does the same for mass
units, with coherent reference unit `kg/s`. Both include all prefixes enabled by
their source measures and all their imperial units. Time includes `ps`, `ns`,
`µs`, `ms`, `s`, `min`, `h`, `d`, and every other enabled SI prefix on seconds.
Examples include `nL/ns`, `m3/d`, `gal/h`, `µg/µs`, `kg/d`, and `lb/h`.

Flow factors derive from registered volume or mass units and time units.
The volume registry also includes `in3`, `ft3`, and `gal`. Here `gal` always
means the US liquid gallon, exactly 231 cubic inches, as defined in
[NIST Handbook 44, Appendix C](https://www.nist.gov/system/files/documents/2025/12/30/appc-26-HB44-20251222.pdf).
It does not represent an Imperial gallon.

```ts
convert(60).from("g/min").to("g/s"); // 1
convert(1).from("gal/min").to("L/min"); // 3.785411784
qty(120, "g").divide(qty(2, "min")).to("g/s").toJSON();
// { value: 1, units: "g/s" }
qty(60, "mL/min").multiply(qty(2, "min")).to("mL").toJSON();
// { value: 120, units: "mL" }
```

Mass flow and volumetric flow have different dimensions and cannot convert
directly without a fluid density. Device enum names such as `ML_PER_MIN` and
`G_PER_SEC` are not registry spellings.

## Gas flow and totalizers

Common gas readings have two separate measures:

| Measure               | Common units                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `standardGasFlowRate` | `sccm`, `sccs`, `slpm`, `SL/s`, `SL/h`, `Sm3/s`, `Sm3/min`, `Sm3/h`, `Sm3/d`, `scfm`, `scfh`, `scfd` |
| `normalGasFlowRate`   | `nccm`, `nccs`, `nlpm`, `NL/s`, `NL/h`, `Nm3/s`, `Nm3/min`, `Nm3/h`, `Nm3/d`, `ncfm`, `ncfh`, `ncfd` |

Totalizer measures are `standardGasVolume` (`Sm3`, `SL`, `scc`, `Sft3`) and
`normalGasVolume` (`Nm3`, `NL`, `ncc`, `Nft3`). Uppercase `NL` denotes a normal
liter; lowercase `nL` remains a nanoliter in the actual-volume registry.
Each gas-flow measure divides its volume units by every registered time unit, with
spelling overrides preserving common readings such as `sccm` and `slpm`.

Conversions within a family rescale volume and time, assuming the readings
share the same reference conditions. The registry does not assign a universal
temperature or pressure to these labels or store or validate reference-condition
metadata. Confirm that source and destination readings share reference conditions
before comparing them. For example,
[Alicat's default standard conditions](https://www.alicat.com/documentation/tutorials/)
are 25 C and 1 atm and can be changed, whereas
[Bronkhorst documents](https://www.bronkhorst.com/service-support/faq/)
normal conditions at 0 C and standard conditions at 20 C, both at 1 atm.

```ts
convert(1000).from("sccm").to("slpm"); // 1
convert(1).from("scfm").to("slpm"); // 28.316846592
convert(1000).from("nccm").to("nlpm"); // 1
qty(1000, "sccm").multiply(qty(2, "min")).to("SL").toJSON();
// { value: 2, units: "SL" }
```

The semantic dimensions `standardGasVolume` and `normalGasVolume` have coherent
basis units `Sm3` and `Nm3`. Arithmetic preserves these dimensions, so integrating
gas flow over time yields a totalizer in the same reference family. Gas flow
cannot convert directly between standard, normal, actual-volume, or mass units;
those conversions require reference conditions and, for mass, gas properties.

## Dimensional arithmetic

Quantities are immutable. Internally, magnitudes use coherent reference units;
multiplication adds dimension exponents, division subtracts them, and integer
powers multiply them. Thus `m / ms` accounts for the millisecond scale before
selecting `m/s`. Addition and subtraction convert operands into coherent units
and require compatible measures and dimensions.

A measure with `default_result: true` supplies the reference unit for arithmetic
with its dimensions. Generation rejects duplicate defaults and absolute defaults.
Adding another measure without a default flag leaves existing inference unchanged. Otherwise, the result retains dimensions with `units = null`
and `measure = null`; call `.to(unit)` to select a registered result unit before
reading `.value` or serializing. For example:

```ts
const result = qty(2, "N").multiply(qty(3, "m"));
result.to("J").toJSON(); // { value: 6, units: "J" }
result.to("N*m").toJSON(); // { value: 6, units: "N*m" }
```

Energy and torque share dimensions, so arithmetic requires an explicit choice.
Once a quantity has a known measure, conversion and addition preserve it:
converting `J` directly to `N*m` is rejected. Angle is an explicit semantic
dimension here, keeping angular velocity (`rad/s`, `rpm`) separate from
frequency (`Hz`). Dimensionless ratios use the registered unit `1` and can
convert to `%` or `ppm`.

Absolute temperatures have `kind: "absolute"`; differences have
`kind: "difference"`. `30 C - 20 C` yields `10 ΔK`. Adding a difference to an
absolute temperature is supported. Adding two absolute temperatures, or using
absolute temperatures in multiplication, division, or powers, is rejected.
Differences use `ΔK`, `ΔC`, `ΔF`, and `ΔR`.

Public magnitudes are finite IEEE-754 numbers. Registry decimal and fractional
coefficients and intermediate quantity values use exact rational arithmetic;
only a selected result representation is rounded to a float. Thus `1 ms` to
`µs` returns exactly `1000`, `212 F` to `C` returns exactly `100`, a small Celsius
quantity retains its original value, and conversions avoid intermediate floating
underflow or overflow. Nonfinite public results are rejected.

All exact arithmetic shares `MAX_RATIONAL_BITS = 100000`, exported by both
libraries. Constructors, wire decoding, reduced operands, and reduced results
are bounded to that size per numerator/denominator. Products cross-cancel
before size checks and allocation; addition uses denominator gcds and bounded
temporaries of at most 200,001 bits so valid cancellation near the limit still
works. Powers check their estimated size before exponentiation. The same core
also bounds registry component resolution. Exhaustion raises `INVALID_VALUE`
in either public library, including for unresolved quantities. Python wire
encoding/decoding obeys this budget without changing the process-wide integer
digit limit.

Compiler-facing operations require no numeric dummy values: `analyzeUnit`,
`analyzeDimensions`, `addUnits`, `subtractUnits`, `multiplyUnits`, `divideUnits`,
and `powerUnit`. Python provides their snake_case equivalents. Results expose
`dimensions`, `measure`, `unit`, `kind`, and candidate measures. Ambiguous
signatures retain a null unit; the compiler can request an explicit result unit.

`conversionPlan(source, target)` / `conversion_plan` precompute exact affine
coefficients for a fixed pair and expose `.convert(value)`. Use
`convertAndValidate(value, source, target, constraints)` /
`convert_and_validate` to apply destination constraints after conversion.
Constraints include safe-integer, inclusive/exclusive bounds, and `multiple_of`.
At inclusive, integer, and multiple boundaries the validation policy permits at
most four relative machine epsilons, capped at `1e-9` in destination units
(or in the multiple index). There is no absolute tolerance floor near zero.
Comparisons and multiple indices use the exact binary values of the public
floating-point inputs; the quotient is never rounded to a float. Valid inputs
are returned unchanged. Otherwise, near-integer, near-multiple and inclusive
boundary candidates are considered, rounded once, and accepted only if they
satisfy **every** constraint. Normalization cannot move an interior value onto
an excluded endpoint. This policy is idempotent and has no tolerance floor that
could silently turn a tiny nonzero value into zero.

The absolute cap also applies to exact multiple indices. For example, `1e10`
with `multiple_of: 0.1` is rejected: the binary value of `0.1` makes the exact
quotient differ from an integer by more than `1e-9`, even though floating-point
division would round the quotient to an integer. This is not decimal-arithmetic
validation. Exclusive bounds remain strict; materially fractional or
out-of-range values are rejected. `validateNumeric` / `validate_numeric` apply
the same policy to values already expressed in destination units.

Errors are `UnitError` values with a stable `code` in all three languages:
`UNKNOWN_UNIT`, `UNKNOWN_MEASURE`, `INCOMPATIBLE_UNITS`, `INVALID_VALUE`,
`INVALID_OPERATION`, `UNRESOLVED_UNIT`, or `CONSTRAINT_VIOLATION`.

## Development and integration

Enter the development shell with `nix develop` (flakes enabled). It provides
Rust, Cargo, rustfmt, clippy, Node, pnpm, Python 3.12, uv, and Git. Developing the
generator requires Rust 1.85 or newer. From the repository root:

```sh
npm ci                         # or pnpm install --frozen-lockfile
cargo run --locked -p i5-units-generator
cargo run --locked -p i5-units-generator -- --check
npm run build:node
npm test                       # generator and TypeScript/Python parity tests
cargo test --workspace --locked
uv run --locked --project python pytest python/tests
uv run --locked --project python ruff check python
uv run --locked --project python ty check --project python python/src
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
nix flake check
```

`tools/registry-generator/` owns validation, family expansion, exact-factor
resolution, fingerprints, and artifact rendering. It runs without Node or
Python. `npm run schema:generate` / `schema:check` remain thin compatibility
wrappers. `--root PATH` lets the binary operate on another checkout; `--stdin`
accepts a JSON `{ config, prefixes, definitions }` and prints its built registry.

Generated files are `registry.generated.json`, the identical registry resources
under `python/src/i5_units/` and `rust/src/`, the TypeScript/Python unit types,
and `rust/tests/fixtures.generated.json`. After changing sources, run the Rust
generator and `npm run build:node`, then commit those artifacts and `dist/`.
`schema:check` and `build:check` detect stale output. All three runtimes execute
the shared fixtures and roundtrip the registry inventory.

The flake supports Apple Silicon macOS and Linux on x86_64 and aarch64. `nix build` builds the
generator; `nix build .#rust`, `.#python`, and `.#node` build the library packages.
The Node output includes an npm tarball under `share/`; the Rust output includes
an rlib and crate sources. `nix flake check` builds these packages and runs the
registry validation tests. As with any Git flake, add new files to Git before
using `nix develop`; use `nix develop path:.` for an untracked working tree.

## Future application integration

Compiler and server adoption is deferred. Before enabling it, define how
declared units select conversion destinations, how dynamic or multiple-choice
unit declarations behave, and how compiled programs handle registry changes.
Application duration syntax and saved values also need a separate migration
plan before adopting the registry's canonical spellings.

Audit remaining driver declarations and output together before enabling global
instrument compiler enforcement. Device tokens such as `DEFAULT`, `UNKNOWN`,
and `PERCENT_FULL_SCALE` require driver-specific review.
Changing gas reference conditions or gauge/absolute pressure references requires
context and is not modeled as a fixed conversion here.
