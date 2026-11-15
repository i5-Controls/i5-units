import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import fixtures from "../../spec/fixtures.json" with { type: "json" };
import registry from "../../registry.generated.json" with { type: "json" };
import {
  UnitError,
  canConvert,
  convert,
  describe,
  hasUnit,
  list,
  measures,
  possibilities,
  parseUnit,
  parseMeasure,
  convertAndValidate,
  conversionPlan,
  divideUnits,
  multiplyUnits,
  powerUnit,
  addUnits,
  subtractUnits,
  registryFingerprint,
  analyzeUnit,
  qty,
  type Quantity,
  type Unit,
} from "../index.ts";

interface Expression {
  value?: number;
  units?: string;
  op?: "add" | "subtract" | "multiply" | "divide" | "pow";
  left?: Expression;
  right?: Expression;
  exponent?: number;
  to?: string;
}

function evaluate(expression: Expression): Quantity {
  let result: Quantity;
  if (expression.op) {
    const left = evaluate(expression.left!);
    result =
      expression.op === "pow"
        ? left.pow(expression.exponent!)
        : left[expression.op](evaluate(expression.right!));
  } else result = qty(expression.value!, parseUnit(expression.units));
  return expression.to ? result.to(parseUnit(expression.to)) : result;
}

function close(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) <=
      (expected === 0 ? 1e-12 : Math.abs(expected) * 1e-12),
    `${actual} != ${expected}`,
  );
}

for (const fixture of fixtures.conversions) {
  test(`conversion: ${fixture.value} ${fixture.from} -> ${fixture.to}`, () => {
    close(
      convert(fixture.value)
        .from(parseUnit(fixture.from))
        .to(parseUnit(fixture.to)),
      fixture.expected,
    );
  });
}
for (const fixture of fixtures.quantities) {
  test(`quantity: ${fixture.name}`, () => {
    const result = evaluate(fixture.expression as Expression).toJSON();
    assert.equal(result.units, fixture.expected.units);
    close(result.value, fixture.expected.value);
  });
}
for (const fixture of fixtures.failures) {
  test(`reject: ${fixture.name}`, () => {
    assert.throws(
      () => evaluate(fixture.expression as Expression).toJSON(),
      (error) => error instanceof UnitError && error.code === fixture.code,
    );
  });
}

for (const [index, fixture] of fixtures.constraints.entries()) {
  test(`conversion and destination constraints: ${index}`, () => {
    const run = () =>
      convertAndValidate(
        fixture.value,
        parseUnit(fixture.from),
        parseUnit(fixture.to),
        fixture.constraints,
      );
    if ("code" in fixture) assert.throws(run, { code: fixture.code });
    else assert.equal(run(), fixture.expected!);
  });
}

function analyze(fixture: (typeof fixtures.analyses)[number]) {
  const left = parseUnit(fixture.left);
  if (fixture.op === "power") return powerUnit(left, fixture.exponent!);
  const right = parseUnit(fixture.right);
  const operation = {
    divide: divideUnits,
    multiply: multiplyUnits,
    add: addUnits,
    subtract: subtractUnits,
  }[fixture.op as "divide" | "multiply" | "add" | "subtract"];
  return operation(left, right);
}
for (const fixture of fixtures.analyses) {
  test(`metadata-only analysis: ${fixture.op} ${fixture.left}`, () => {
    const result = analyze(fixture);
    assert.deepEqual(result.dimensions, fixture.dimensions);
    assert.equal(result.measure, fixture.measure);
    assert.equal(result.unit, fixture.unit);
  });
}

test("typed unit APIs reject misspellings at compile time", () => {
  const invalidCalls = () => {
    // @ts-expect-error A canonical unit is required at the typed boundary.
    qty(1, "us");
    // @ts-expect-error A canonical unit is required at the typed boundary.
    convert(1).from("seconds");
  };
  assert.equal(typeof invalidCalls, "function");
  assert.throws(() => parseUnit("us"), { code: "UNKNOWN_UNIT" });
  assert.match(registryFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(analyzeUnit("C").kind, "absolute");
  assert.throws(() => multiplyUnits("C", "m"), { code: "INVALID_OPERATION" });
  assert.throws(() => addUnits("m", "s"), { code: "INCOMPATIBLE_UNITS" });
  assert.deepEqual(conversionPlan("ms", "µs").scale_ratio, {
    numerator: "1000",
    denominator: "1",
  });
  assert.deepEqual(conversionPlan("F", "C").offset_ratio, {
    numerator: "-160",
    denominator: "9",
  });
});

test("compound prefix families expose typed units and exact conversion plans", () => {
  assert.equal(convert(1000).from("nL/min").to("µL/min"), 1);
  assert.equal(convert(1).from("Mg/h").to("kg/h"), 1000);
  assert.equal(convert(86400).from("g/d").to("g/s"), 1);
  assert.equal(convert(1).from("ft3/s").to("L/s"), 28.316846592);
  assert.equal(convert(1).from("mg/ms").to("g/s"), 1);
  assert.equal(convert(1).from("nL/ns").to("L/s"), 1);
  assert.equal(describe("nL/min").singular, "nanoliter per minute");
  assert.deepEqual(conversionPlan("nL/min", "m3/s").scale_ratio, {
    numerator: "1",
    denominator: "60000000000000",
  });
  for (const spelling of ["uL/min", "mmL/min", "µkg/s"])
    assert.equal(hasUnit(spelling), false);
});

test("exact canonical units include every enabled prefix, without aliases", () => {
  const microsecond: Unit = "µs";
  // @ts-expect-error ASCII micro is not a canonical spelling.
  const invalid: Unit = "us";
  assert.equal(hasUnit(microsecond), true);
  assert.equal(hasUnit(invalid), false);
  for (const spelling of [
    "__proto__",
    "constructor",
    "Bar",
    " ms",
    "ms ",
    "seconds",
  ])
    assert.equal(hasUnit(spelling), false);
  assert.equal(describe("µs").prefix, "µ");
  assert.equal(describe("µs").base_unit, "s");
  assert.equal(describe("µs").singular, "microsecond");
  assert.equal(describe("ms").measure, "time");
});

test("fluent discovery and measure compatibility", () => {
  assert.deepEqual(convert().list("length"), list("length"));
  assert.deepEqual(convert().measures(), measures());
  assert.deepEqual(convert().from("ms").possibilities(), possibilities("time"));
  assert.equal(canConvert("ms", "µs"), true);
  assert.equal(canConvert("J", "N*m"), false);
  assert.equal(canConvert("C", "ΔC"), false);
  assert.equal(canConvert("unknown", "m"), false);
  assert.throws(() => list(parseMeasure("unknown")), {
    code: "UNKNOWN_MEASURE",
  });
  assert.throws(() => convert(1).to("s"), { code: "INVALID_OPERATION" });
  assert.throws(() => convert(1).from("m").to("s"), {
    code: "INCOMPATIBLE_UNITS",
  });
  assert.throws(() => convert(1).from("C").to("ΔK"), {
    code: "INCOMPATIBLE_UNITS",
  });
});

test("quantities, dimensions and converter requests are immutable", () => {
  const original = qty(1, "m");
  const changed = original.to("cm");
  close(original.value, 1);
  close(changed.value, 100);
  assert.throws(() => {
    (original.dimensions as Record<string, number>).length = 9;
  });
  const request = convert(1).from("s");
  request.from("m");
  close(request.to("ms"), 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(changed)), {
    value: 100,
    units: "cm",
  });
});

test("unresolved results retain dimensions and require an explicit registered target", () => {
  const result = qty(2, "N").multiply(qty(3, "m"));
  assert.equal(result.measure, null);
  assert.equal(result.units, null);
  assert.deepEqual(result.dimensions, { length: 2, mass: 1, time: -2 });
  close(result.to("J").value, 6);
  close(result.to("N*m").value, 6);
  assert.throws(() => JSON.stringify(result), { code: "UNRESOLVED_UNIT" });
});

test("all registered units roundtrip through their measure reference unit", () => {
  for (const measure of measures()) {
    const units = possibilities(measure);
    for (const unit of units) {
      const target = registry.measures[measure].reference_unit;
      close(
        convert(convert(12.5).from(unit).to(parseUnit(target)))
          .from(parseUnit(target))
          .to(unit),
        12.5,
      );
    }
  }
});

test("nonfinite inputs, overflow, and unsafe dimension powers are rejected", () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => convert(value), { code: "INVALID_VALUE" });
    assert.throws(() => qty(value, "s"), { code: "INVALID_VALUE" });
  }
  assert.throws(() => convert(Number.MAX_VALUE).from("Qs").to("qs"), {
    code: "INVALID_VALUE",
  });
  assert.throws(() => qty(Number.MAX_VALUE, "m").multiply(qty(2, "m")), {
    code: "INVALID_VALUE",
  });
  assert.throws(() => qty(1, "m").pow(Number.MAX_SAFE_INTEGER + 1), {
    code: "INVALID_OPERATION",
  });
});

test("Python and TypeScript agree on inventory, errors, and all shared results", () => {
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const python = spawnSync(
    "uv",
    [
      "run",
      "--locked",
      "--project",
      `${packageRoot}python`,
      "python",
      `${packageRoot}python/tests/emit_results.py`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(python.status, 0, python.stderr);
  const results = JSON.parse(python.stdout);
  assert.deepEqual(results.units, possibilities());
  assert.deepEqual(results.descriptions, list());
  for (const [index, fixture] of fixtures.conversions.entries())
    close(
      results.conversions[index],
      convert(fixture.value)
        .from(parseUnit(fixture.from))
        .to(parseUnit(fixture.to)),
    );
  for (const [index, fixture] of fixtures.quantities.entries()) {
    const result = evaluate(fixture.expression as Expression).toJSON();
    assert.equal(results.quantities[index].units, result.units);
    close(results.quantities[index].value, result.value);
  }
  assert.deepEqual(
    results.failures,
    fixtures.failures.map((fixture) => fixture.code),
  );
  assert.equal(results.fingerprint, registryFingerprint);
  for (const [index, fixture] of fixtures.analyses.entries()) {
    const actual = analyze(fixture);
    assert.deepEqual(results.analyses[index], {
      ...actual,
      candidates: [...actual.candidates],
    });
  }
  for (const [index, fixture] of fixtures.constraints.entries()) {
    if ("code" in fixture)
      assert.equal(results.constraints[index].code, fixture.code);
    else assert.equal(results.constraints[index].value, fixture.expected!);
  }
});
