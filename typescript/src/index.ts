import data from "../../registry.generated.json" with { type: "json" };
import * as r from "./rational.ts";
import type { Dimension, Measure, Unit } from "./types.generated.ts";
export type {
  Dimension,
  Measure,
  Unit,
  UnitOfMeasure,
  UnitsByMeasure,
} from "./types.generated.ts";

export type Dimensions = Readonly<Partial<Record<Dimension, number>>>;
export type UnitKind = "linear" | "absolute" | "difference";
export type UnitErrorCode =
  | "UNKNOWN_UNIT"
  | "UNKNOWN_MEASURE"
  | "INCOMPATIBLE_UNITS"
  | "INVALID_VALUE"
  | "INVALID_OPERATION"
  | "UNRESOLVED_UNIT"
  | "CONSTRAINT_VIOLATION";
export class UnitError extends Error {
  readonly code: UnitErrorCode;
  constructor(code: UnitErrorCode, message: string) {
    super(message);
    this.name = "UnitError";
    this.code = code;
  }
}
interface Ratio {
  numerator: string;
  denominator: string;
}
interface MeasureDefinition {
  dimensions: Dimensions;
  reference_unit: Unit;
  kind: UnitKind;
  default_result: boolean;
  systems: readonly string[];
}
interface UnitDefinition {
  measure: Measure;
  system: string;
  name: { singular: string; plural: string };
  scale: number;
  offset: number;
  scale_ratio: Ratio;
  offset_ratio: Ratio;
  prefix?: string;
  base_unit?: Unit;
  components?: Readonly<Partial<Record<Unit, number>>>;
}
export interface UnitDescription {
  abbr: Unit;
  measure: Measure;
  system: string;
  singular: string;
  plural: string;
  dimensions: Dimensions;
  reference_unit: Unit;
  kind: UnitKind;
  scale: number;
  offset: number;
  prefix?: string;
  base_unit?: Unit;
  components?: Readonly<Partial<Record<Unit, number>>>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const registry = freeze(data) as unknown as {
  version: string;
  fingerprint: string;
  format_version: number;
  measures: Record<Measure, MeasureDefinition>;
  units: Record<Unit, UnitDefinition>;
};
export const registryVersion = registry.version;
export const registryFingerprint = registry.fingerprint;
export const registryFormatVersion = registry.format_version;
export function hasUnit(unit: unknown): unit is Unit {
  return typeof unit === "string" && Object.hasOwn(registry.units, unit);
}
export function parseUnit(input: unknown): Unit {
  if (!hasUnit(input))
    throw new UnitError("UNKNOWN_UNIT", `Unknown unit ${String(input)}`);
  return input;
}
export function parseMeasure(input: unknown): Measure {
  if (typeof input !== "string" || !Object.hasOwn(registry.measures, input))
    throw new UnitError("UNKNOWN_MEASURE", `Unknown measure ${String(input)}`);
  return input as Measure;
}
function unitDefinition(unit: Unit): UnitDefinition {
  return registry.units[parseUnit(unit)];
}
export function describe(unit: Unit): UnitDescription {
  const definition = unitDefinition(unit);
  const measure = registry.measures[definition.measure];
  return {
    abbr: unit,
    measure: definition.measure,
    system: definition.system,
    singular: definition.name.singular,
    plural: definition.name.plural,
    dimensions: measure.dimensions,
    reference_unit: measure.reference_unit,
    kind: measure.kind,
    scale: definition.scale,
    offset: definition.offset,
    ...(definition.prefix
      ? { prefix: definition.prefix, base_unit: definition.base_unit }
      : {}),
    ...(definition.components ? { components: definition.components } : {}),
  };
}
export function measures(): Measure[] {
  return Object.keys(registry.measures) as Measure[];
}
export function list(measure?: Measure): UnitDescription[] {
  if (measure !== undefined) parseMeasure(measure);
  return (Object.keys(registry.units) as Unit[])
    .filter(
      (unit) =>
        measure === undefined || registry.units[unit].measure === measure,
    )
    .map(describe);
}
export function possibilities(measure?: Measure): Unit[] {
  return list(measure).map((unit) => unit.abbr);
}
function finite(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new UnitError(
      "INVALID_VALUE",
      "Quantity values and results must be finite numbers",
    );
  return value;
}
export { MAX_RATIONAL_BITS } from "./rational.ts";
function bounded<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof r.RationalLimitError)
      throw new UnitError("INVALID_VALUE", error.message);
    throw error;
  }
}
const factors = new Map<Unit, { scale: r.Rational; offset: r.Rational }>();
function exact(unit: Unit) {
  const definition = unitDefinition(unit);
  let result = factors.get(unit);
  if (!result) {
    result = {
      scale: bounded(() => r.fromWire(definition.scale_ratio)),
      offset: bounded(() => r.fromWire(definition.offset_ratio)),
    };
    factors.set(unit, result);
  }
  return result;
}
export function canConvert(source: unknown, target: unknown): boolean {
  return (
    hasUnit(source) &&
    hasUnit(target) &&
    registry.units[source].measure === registry.units[target].measure
  );
}
export interface ConversionPlan {
  readonly source: Unit;
  readonly target: Unit;
  readonly scale_ratio: Readonly<Ratio>;
  readonly offset_ratio: Readonly<Ratio>;
  convert(value: number): number;
}
/** Resolve a fixed pair once; preserve exact coefficients and round the result once. */
export function conversionPlan(source: Unit, target: Unit): ConversionPlan {
  const from = exact(source),
    to = exact(target);
  if (!canConvert(source, target))
    throw new UnitError(
      "INCOMPATIBLE_UNITS",
      `Cannot convert ${source} to ${target}`,
    );
  const scale = bounded(() => r.divide(from.scale, to.scale));
  const offset = bounded(() =>
    r.divide(r.subtract(from.offset, to.offset), to.scale),
  );
  return freeze({
    source,
    target,
    scale_ratio: { numerator: String(scale.n), denominator: String(scale.d) },
    offset_ratio: {
      numerator: String(offset.n),
      denominator: String(offset.d),
    },
    convert(value: number) {
      finite(value);
      if (source === target) return value;
      return bounded(() =>
        finite(
          r.toNumber(r.add(r.multiply(r.fromNumber(value), scale), offset)),
        ),
      );
    },
  });
}
export class Converter {
  private readonly amount: number;
  private readonly source?: Unit;
  constructor(value = 0, source?: Unit) {
    this.amount = finite(value);
    this.source = source;
    if (source !== undefined) parseUnit(source);
    Object.freeze(this);
  }
  from(source: Unit): Converter {
    parseUnit(source);
    return new Converter(this.amount, source);
  }
  to(target: Unit): number {
    if (this.source === undefined)
      throw new UnitError("INVALID_OPERATION", "Call from before to");
    return conversionPlan(this.source, target).convert(this.amount);
  }
  describe = describe;
  list = list;
  measures = measures;
  possibilities(measure?: Measure): Unit[] {
    return possibilities(
      measure ??
        (this.source ? unitDefinition(this.source).measure : undefined),
    );
  }
}
export function convert(value = 0): Converter {
  return new Converter(value);
}

export interface NumericConstraints {
  integer?: boolean;
  minimum?: number;
  maximum?: number;
  exclusive_minimum?: number;
  exclusive_maximum?: number;
  multiple_of?: number;
}
function near(a: r.Rational, b: r.Rational): boolean {
  const absolute = (value: r.Rational): r.Rational => ({
    n: value.n < 0n ? -value.n : value.n,
    d: value.d,
  });
  const largest =
    r.compare(absolute(a), absolute(b)) >= 0 ? absolute(a) : absolute(b);
  const relative = r.multiply(r.fromNumber(4 * Number.EPSILON), largest);
  const cap = r.fromNumber(1e-9);
  const tolerance = r.compare(relative, cap) <= 0 ? relative : cap;
  return r.compare(absolute(r.subtract(a, b)), tolerance) <= 0;
}
/** Preserve valid inputs; normalize only candidates satisfying every constraint. */
export function validateNumeric(
  value: number,
  constraints: NumericConstraints = {},
): number {
  finite(value);
  for (const [key, boundary] of Object.entries(constraints)) {
    if (
      ![
        "integer",
        "minimum",
        "maximum",
        "exclusive_minimum",
        "exclusive_maximum",
        "multiple_of",
      ].includes(key)
    )
      throw new UnitError("INVALID_OPERATION", `Unknown constraint ${key}`);
    if (key === "integer") {
      if (typeof boundary !== "boolean")
        throw new UnitError("INVALID_OPERATION", "integer must be boolean");
    } else finite(boundary as number);
  }
  if (constraints.multiple_of !== undefined && constraints.multiple_of <= 0)
    throw new UnitError("INVALID_OPERATION", "multiple_of must be positive");
  if (
    constraints.minimum !== undefined &&
    constraints.maximum !== undefined &&
    constraints.minimum > constraints.maximum
  )
    throw new UnitError("INVALID_OPERATION", "minimum must not exceed maximum");
  const boundaries: Record<string, r.Rational> = {};
  for (const [key, boundary] of Object.entries(constraints))
    if (key !== "integer") boundaries[key] = r.fromNumber(boundary as number);
  const multiple = boundaries.multiple_of;
  const satisfies = (candidate: r.Rational): boolean => {
    if (
      constraints.integer &&
      (candidate.d !== 1n ||
        candidate.n < -BigInt(Number.MAX_SAFE_INTEGER) ||
        candidate.n > BigInt(Number.MAX_SAFE_INTEGER))
    )
      return false;
    if (boundaries.minimum && r.compare(candidate, boundaries.minimum) < 0)
      return false;
    if (boundaries.maximum && r.compare(candidate, boundaries.maximum) > 0)
      return false;
    if (
      boundaries.exclusive_minimum &&
      r.compare(candidate, boundaries.exclusive_minimum) <= 0
    )
      return false;
    if (
      boundaries.exclusive_maximum &&
      r.compare(candidate, boundaries.exclusive_maximum) >= 0
    )
      return false;
    if (multiple) {
      const index = r.divide(candidate, multiple);
      if (!near(index, r.rational(r.nearestInteger(index)))) return false;
    }
    return true;
  };
  const original = r.fromNumber(value);
  if (satisfies(original)) return value;
  const candidates: r.Rational[] = [];
  if (constraints.integer) {
    const rounded = r.rational(r.nearestInteger(original));
    if (near(original, rounded)) candidates.push(rounded);
  }
  if (multiple) {
    const index = r.divide(original, multiple);
    const rounded = r.rational(r.nearestInteger(index));
    if (near(index, rounded)) candidates.push(r.multiply(rounded, multiple));
  }
  for (const key of ["minimum", "maximum"])
    if (boundaries[key] && near(original, boundaries[key]))
      candidates.push(boundaries[key]);
  for (const candidate of candidates) {
    const rounded = r.toNumber(candidate);
    if (Number.isFinite(rounded) && satisfies(r.fromNumber(rounded)))
      return rounded;
  }
  throw new UnitError(
    "CONSTRAINT_VIOLATION",
    "Converted value violates destination constraints",
  );
}
export function convertAndValidate(
  value: number,
  source: Unit,
  target: Unit,
  constraints: NumericConstraints = {},
): number {
  return validateNumeric(
    conversionPlan(source, target).convert(value),
    constraints,
  );
}

function checkedDimensions(dimensions: Dimensions): Dimensions {
  const result: Partial<Record<Dimension, number>> = {};
  for (const [key, exponent] of Object.entries(dimensions)) {
    if (
      !(data.dimensions as string[]).includes(key) ||
      !Number.isSafeInteger(exponent)
    )
      throw new UnitError(
        "INVALID_OPERATION",
        "Dimensions require known names and safe integer exponents",
      );
    if (exponent !== 0) result[key as Dimension] = exponent;
  }
  return Object.freeze(result);
}
function sameDimensions(a: Dimensions, b: Dimensions): boolean {
  return data.dimensions.every(
    (dimension) =>
      (a[dimension as Dimension] ?? 0) === (b[dimension as Dimension] ?? 0),
  );
}
function combineDimensions(
  a: Dimensions,
  b: Dimensions,
  sign: number,
): Dimensions {
  const result: Partial<Record<Dimension, number>> = {};
  for (const dimension of data.dimensions as Dimension[])
    result[dimension] = (a[dimension] ?? 0) + sign * (b[dimension] ?? 0);
  return checkedDimensions(result);
}
export interface UnitAnalysis {
  readonly dimensions: Dimensions;
  readonly measure: Measure | null;
  readonly unit: Unit | null;
  readonly kind: UnitKind | null;
  readonly candidates: readonly Measure[];
}
export function analyzeDimensions(dimensions: Dimensions): UnitAnalysis {
  const checked = checkedDimensions(dimensions);
  const candidates = measures().filter(
    (name) =>
      registry.measures[name].kind !== "absolute" &&
      sameDimensions(checked, registry.measures[name].dimensions),
  );
  const measure =
    candidates.find((name) => registry.measures[name].default_result) ?? null;
  return freeze({
    dimensions: checked,
    candidates,
    measure,
    unit: measure ? registry.measures[measure].reference_unit : null,
    kind: measure ? registry.measures[measure].kind : null,
  });
}
export function analyzeUnit(unit: Unit): UnitAnalysis {
  const description = describe(unit);
  return freeze({
    ...analyzeDimensions(description.dimensions),
    measure: description.measure,
    unit,
    kind: description.kind,
  });
}
type Operand = Unit | UnitAnalysis;
function analysis(operand: Operand): UnitAnalysis {
  return typeof operand === "string" ? analyzeUnit(operand) : operand;
}
function productAnalysis(
  left: Operand,
  right: Operand,
  divide: boolean,
): UnitAnalysis {
  const a = analysis(left),
    b = analysis(right);
  if (a.kind === "absolute" || b.kind === "absolute")
    throw new UnitError(
      "INVALID_OPERATION",
      "Use temperature differences for multiplication and division",
    );
  const result = analyzeDimensions(
    combineDimensions(a.dimensions, b.dimensions, divide ? -1 : 1),
  );
  const preserved =
    Object.keys(b.dimensions).length === 0
      ? a
      : !divide && Object.keys(a.dimensions).length === 0
        ? b
        : null;
  return preserved?.measure
    ? freeze({
        ...result,
        measure: preserved.measure,
        unit: registry.measures[preserved.measure].reference_unit,
        kind: preserved.kind,
      })
    : result;
}
export function multiplyUnits(left: Operand, right: Operand): UnitAnalysis {
  return productAnalysis(left, right, false);
}
export function divideUnits(left: Operand, right: Operand): UnitAnalysis {
  return productAnalysis(left, right, true);
}
export function powerUnit(unit: Operand, exponent: number): UnitAnalysis {
  const input = analysis(unit);
  if (!Number.isSafeInteger(exponent) || input.kind === "absolute")
    throw new UnitError(
      "INVALID_OPERATION",
      "Powers require an integer exponent and a non-absolute quantity",
    );
  const result = analyzeDimensions(
    combineDimensions({}, input.dimensions, exponent),
  );
  return exponent === 1 ? input : result;
}
function sumAnalysis(
  left: Operand,
  right: Operand,
  subtract: boolean,
): UnitAnalysis {
  const a = analysis(left),
    b = analysis(right);
  if (!sameDimensions(a.dimensions, b.dimensions))
    throw new UnitError(
      "INCOMPATIBLE_UNITS",
      "Addition and subtraction require matching dimensions",
    );
  if (
    a.kind === "absolute" &&
    b.kind === "absolute" &&
    a.measure === b.measure
  ) {
    if (!subtract)
      throw new UnitError(
        "INVALID_OPERATION",
        "Cannot add two absolute temperatures",
      );
    return analyzeDimensions(a.dimensions);
  }
  if (a.kind === "absolute" && b.kind === "difference") return a;
  if (a.kind === "difference" && b.kind === "absolute" && !subtract) return b;
  if (a.measure !== null && b.measure !== null && a.measure !== b.measure)
    throw new UnitError(
      "INCOMPATIBLE_UNITS",
      "Addition and subtraction require matching measures",
    );
  return a.measure ? a : b;
}
export function addUnits(left: Operand, right: Operand): UnitAnalysis {
  return sumAnalysis(left, right, false);
}
export function subtractUnits(left: Operand, right: Operand): UnitAnalysis {
  return sumAnalysis(left, right, true);
}

/** Exact internal reference magnitudes preserve inputs and defer floating-point rounding. */
export class Quantity {
  private readonly baseValue: r.Rational;
  readonly dimensions: Dimensions;
  readonly measure: Measure | null;
  readonly units: Unit | null;
  constructor(value: number, unit: Unit) {
    const metadata = analyzeUnit(unit),
      factor = exact(unit);
    this.baseValue = bounded(() =>
      r.add(
        r.multiply(r.fromNumber(finite(value)), factor.scale),
        factor.offset,
      ),
    );
    this.dimensions = metadata.dimensions;
    this.measure = metadata.measure;
    this.units = unit;
    Object.freeze(this);
  }
  private static fromBase(value: r.Rational, metadata: UnitAnalysis): Quantity {
    const result = Object.create(Quantity.prototype) as Quantity;
    Object.defineProperties(result, {
      baseValue: { value },
      dimensions: { value: metadata.dimensions, enumerable: true },
      measure: { value: metadata.measure, enumerable: true },
      units: { value: metadata.unit, enumerable: true },
    });
    if (metadata.unit) result.value;
    Object.freeze(result);
    return result;
  }
  get value(): number {
    if (!this.units)
      throw new UnitError(
        "UNRESOLVED_UNIT",
        "Choose a registered result unit with to(unit)",
      );
    const factor = exact(this.units);
    return bounded(() =>
      finite(
        r.toNumber(
          r.divide(r.subtract(this.baseValue, factor.offset), factor.scale),
        ),
      ),
    );
  }
  private metadata(): UnitAnalysis {
    return this.units
      ? analyzeUnit(this.units)
      : analyzeDimensions(this.dimensions);
  }
  to(target: Unit): Quantity {
    const metadata = analyzeUnit(target);
    if (
      !sameDimensions(this.dimensions, metadata.dimensions) ||
      (this.measure !== null && this.measure !== metadata.measure)
    )
      throw new UnitError(
        "INCOMPATIBLE_UNITS",
        `Cannot express this quantity in ${target}`,
      );
    return Quantity.fromBase(this.baseValue, metadata);
  }
  add(other: Quantity): Quantity {
    return bounded(() =>
      Quantity.fromBase(
        r.add(this.baseValue, other.baseValue),
        addUnits(this.metadata(), other.metadata()),
      ),
    );
  }
  subtract(other: Quantity): Quantity {
    return bounded(() =>
      Quantity.fromBase(
        r.subtract(this.baseValue, other.baseValue),
        subtractUnits(this.metadata(), other.metadata()),
      ),
    );
  }
  multiply(other: Quantity): Quantity {
    return bounded(() =>
      Quantity.fromBase(
        r.multiply(this.baseValue, other.baseValue),
        multiplyUnits(this.metadata(), other.metadata()),
      ),
    );
  }
  divide(other: Quantity): Quantity {
    if (other.baseValue.n === 0n)
      throw new UnitError("INVALID_OPERATION", "Cannot divide by zero");
    return bounded(() =>
      Quantity.fromBase(
        r.divide(this.baseValue, other.baseValue),
        divideUnits(this.metadata(), other.metadata()),
      ),
    );
  }
  pow(exponent: number): Quantity {
    const metadata = powerUnit(this.metadata(), exponent);
    try {
      return Quantity.fromBase(r.power(this.baseValue, exponent), metadata);
    } catch (error) {
      if (error instanceof RangeError)
        throw new UnitError("INVALID_VALUE", error.message);
      throw error;
    }
  }
  toJSON(): { value: number; units: Unit } {
    return { value: this.value, units: this.units! };
  }
}
export function qty(value: number, unit: Unit): Quantity {
  return new Quantity(value, unit);
}
