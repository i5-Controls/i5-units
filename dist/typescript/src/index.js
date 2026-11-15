import data from "../../registry.generated.json" with { type: "json" };
import * as r from "./rational.js";
export class UnitError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "UnitError";
        this.code = code;
    }
}
function freeze(value) {
    if (value && typeof value === "object") {
        for (const child of Object.values(value))
            freeze(child);
        Object.freeze(value);
    }
    return value;
}
const registry = freeze(data);
export const registryVersion = registry.version;
export const registryFingerprint = registry.fingerprint;
export const registryFormatVersion = registry.format_version;
export function hasUnit(unit) {
    return typeof unit === "string" && Object.hasOwn(registry.units, unit);
}
export function parseUnit(input) {
    if (!hasUnit(input))
        throw new UnitError("UNKNOWN_UNIT", `Unknown unit ${String(input)}`);
    return input;
}
export function parseMeasure(input) {
    if (typeof input !== "string" || !Object.hasOwn(registry.measures, input))
        throw new UnitError("UNKNOWN_MEASURE", `Unknown measure ${String(input)}`);
    return input;
}
function unitDefinition(unit) {
    return registry.units[parseUnit(unit)];
}
export function describe(unit) {
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
export function measures() {
    return Object.keys(registry.measures);
}
export function list(measure) {
    if (measure !== undefined)
        parseMeasure(measure);
    return Object.keys(registry.units)
        .filter((unit) => measure === undefined || registry.units[unit].measure === measure)
        .map(describe);
}
export function possibilities(measure) {
    return list(measure).map((unit) => unit.abbr);
}
function finite(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new UnitError("INVALID_VALUE", "Quantity values and results must be finite numbers");
    return value;
}
export { MAX_RATIONAL_BITS } from "./rational.js";
function bounded(operation) {
    try {
        return operation();
    }
    catch (error) {
        if (error instanceof r.RationalLimitError)
            throw new UnitError("INVALID_VALUE", error.message);
        throw error;
    }
}
const factors = new Map();
function exact(unit) {
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
export function canConvert(source, target) {
    return (hasUnit(source) &&
        hasUnit(target) &&
        registry.units[source].measure === registry.units[target].measure);
}
/** Resolve a fixed pair once; preserve exact coefficients and round the result once. */
export function conversionPlan(source, target) {
    const from = exact(source), to = exact(target);
    if (!canConvert(source, target))
        throw new UnitError("INCOMPATIBLE_UNITS", `Cannot convert ${source} to ${target}`);
    const scale = bounded(() => r.divide(from.scale, to.scale));
    const offset = bounded(() => r.divide(r.subtract(from.offset, to.offset), to.scale));
    return freeze({
        source,
        target,
        scale_ratio: { numerator: String(scale.n), denominator: String(scale.d) },
        offset_ratio: {
            numerator: String(offset.n),
            denominator: String(offset.d),
        },
        convert(value) {
            finite(value);
            if (source === target)
                return value;
            return bounded(() => finite(r.toNumber(r.add(r.multiply(r.fromNumber(value), scale), offset))));
        },
    });
}
export class Converter {
    amount;
    source;
    constructor(value = 0, source) {
        this.amount = finite(value);
        this.source = source;
        if (source !== undefined)
            parseUnit(source);
        Object.freeze(this);
    }
    from(source) {
        parseUnit(source);
        return new Converter(this.amount, source);
    }
    to(target) {
        if (this.source === undefined)
            throw new UnitError("INVALID_OPERATION", "Call from before to");
        return conversionPlan(this.source, target).convert(this.amount);
    }
    describe = describe;
    list = list;
    measures = measures;
    possibilities(measure) {
        return possibilities(measure ??
            (this.source ? unitDefinition(this.source).measure : undefined));
    }
}
export function convert(value = 0) {
    return new Converter(value);
}
function near(a, b) {
    const absolute = (value) => ({
        n: value.n < 0n ? -value.n : value.n,
        d: value.d,
    });
    const largest = r.compare(absolute(a), absolute(b)) >= 0 ? absolute(a) : absolute(b);
    const relative = r.multiply(r.fromNumber(4 * Number.EPSILON), largest);
    const cap = r.fromNumber(1e-9);
    const tolerance = r.compare(relative, cap) <= 0 ? relative : cap;
    return r.compare(absolute(r.subtract(a, b)), tolerance) <= 0;
}
/** Preserve valid inputs; normalize only candidates satisfying every constraint. */
export function validateNumeric(value, constraints = {}) {
    finite(value);
    for (const [key, boundary] of Object.entries(constraints)) {
        if (![
            "integer",
            "minimum",
            "maximum",
            "exclusive_minimum",
            "exclusive_maximum",
            "multiple_of",
        ].includes(key))
            throw new UnitError("INVALID_OPERATION", `Unknown constraint ${key}`);
        if (key === "integer") {
            if (typeof boundary !== "boolean")
                throw new UnitError("INVALID_OPERATION", "integer must be boolean");
        }
        else
            finite(boundary);
    }
    if (constraints.multiple_of !== undefined && constraints.multiple_of <= 0)
        throw new UnitError("INVALID_OPERATION", "multiple_of must be positive");
    if (constraints.minimum !== undefined &&
        constraints.maximum !== undefined &&
        constraints.minimum > constraints.maximum)
        throw new UnitError("INVALID_OPERATION", "minimum must not exceed maximum");
    const boundaries = {};
    for (const [key, boundary] of Object.entries(constraints))
        if (key !== "integer")
            boundaries[key] = r.fromNumber(boundary);
    const multiple = boundaries.multiple_of;
    const satisfies = (candidate) => {
        if (constraints.integer &&
            (candidate.d !== 1n ||
                candidate.n < -BigInt(Number.MAX_SAFE_INTEGER) ||
                candidate.n > BigInt(Number.MAX_SAFE_INTEGER)))
            return false;
        if (boundaries.minimum && r.compare(candidate, boundaries.minimum) < 0)
            return false;
        if (boundaries.maximum && r.compare(candidate, boundaries.maximum) > 0)
            return false;
        if (boundaries.exclusive_minimum &&
            r.compare(candidate, boundaries.exclusive_minimum) <= 0)
            return false;
        if (boundaries.exclusive_maximum &&
            r.compare(candidate, boundaries.exclusive_maximum) >= 0)
            return false;
        if (multiple) {
            const index = r.divide(candidate, multiple);
            if (!near(index, r.rational(r.nearestInteger(index))))
                return false;
        }
        return true;
    };
    const original = r.fromNumber(value);
    if (satisfies(original))
        return value;
    const candidates = [];
    if (constraints.integer) {
        const rounded = r.rational(r.nearestInteger(original));
        if (near(original, rounded))
            candidates.push(rounded);
    }
    if (multiple) {
        const index = r.divide(original, multiple);
        const rounded = r.rational(r.nearestInteger(index));
        if (near(index, rounded))
            candidates.push(r.multiply(rounded, multiple));
    }
    for (const key of ["minimum", "maximum"])
        if (boundaries[key] && near(original, boundaries[key]))
            candidates.push(boundaries[key]);
    for (const candidate of candidates) {
        const rounded = r.toNumber(candidate);
        if (Number.isFinite(rounded) && satisfies(r.fromNumber(rounded)))
            return rounded;
    }
    throw new UnitError("CONSTRAINT_VIOLATION", "Converted value violates destination constraints");
}
export function convertAndValidate(value, source, target, constraints = {}) {
    return validateNumeric(conversionPlan(source, target).convert(value), constraints);
}
function checkedDimensions(dimensions) {
    const result = {};
    for (const [key, exponent] of Object.entries(dimensions)) {
        if (!data.dimensions.includes(key) ||
            !Number.isSafeInteger(exponent))
            throw new UnitError("INVALID_OPERATION", "Dimensions require known names and safe integer exponents");
        if (exponent !== 0)
            result[key] = exponent;
    }
    return Object.freeze(result);
}
function sameDimensions(a, b) {
    return data.dimensions.every((dimension) => (a[dimension] ?? 0) === (b[dimension] ?? 0));
}
function combineDimensions(a, b, sign) {
    const result = {};
    for (const dimension of data.dimensions)
        result[dimension] = (a[dimension] ?? 0) + sign * (b[dimension] ?? 0);
    return checkedDimensions(result);
}
export function analyzeDimensions(dimensions) {
    const checked = checkedDimensions(dimensions);
    const candidates = measures().filter((name) => registry.measures[name].kind !== "absolute" &&
        sameDimensions(checked, registry.measures[name].dimensions));
    const measure = candidates.find((name) => registry.measures[name].default_result) ?? null;
    return freeze({
        dimensions: checked,
        candidates,
        measure,
        unit: measure ? registry.measures[measure].reference_unit : null,
        kind: measure ? registry.measures[measure].kind : null,
    });
}
export function analyzeUnit(unit) {
    const description = describe(unit);
    return freeze({
        ...analyzeDimensions(description.dimensions),
        measure: description.measure,
        unit,
        kind: description.kind,
    });
}
function analysis(operand) {
    return typeof operand === "string" ? analyzeUnit(operand) : operand;
}
function productAnalysis(left, right, divide) {
    const a = analysis(left), b = analysis(right);
    if (a.kind === "absolute" || b.kind === "absolute")
        throw new UnitError("INVALID_OPERATION", "Use temperature differences for multiplication and division");
    const result = analyzeDimensions(combineDimensions(a.dimensions, b.dimensions, divide ? -1 : 1));
    const preserved = Object.keys(b.dimensions).length === 0
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
export function multiplyUnits(left, right) {
    return productAnalysis(left, right, false);
}
export function divideUnits(left, right) {
    return productAnalysis(left, right, true);
}
export function powerUnit(unit, exponent) {
    const input = analysis(unit);
    if (!Number.isSafeInteger(exponent) || input.kind === "absolute")
        throw new UnitError("INVALID_OPERATION", "Powers require an integer exponent and a non-absolute quantity");
    const result = analyzeDimensions(combineDimensions({}, input.dimensions, exponent));
    return exponent === 1 ? input : result;
}
function sumAnalysis(left, right, subtract) {
    const a = analysis(left), b = analysis(right);
    if (!sameDimensions(a.dimensions, b.dimensions))
        throw new UnitError("INCOMPATIBLE_UNITS", "Addition and subtraction require matching dimensions");
    if (a.kind === "absolute" &&
        b.kind === "absolute" &&
        a.measure === b.measure) {
        if (!subtract)
            throw new UnitError("INVALID_OPERATION", "Cannot add two absolute temperatures");
        return analyzeDimensions(a.dimensions);
    }
    if (a.kind === "absolute" && b.kind === "difference")
        return a;
    if (a.kind === "difference" && b.kind === "absolute" && !subtract)
        return b;
    if (a.measure !== null && b.measure !== null && a.measure !== b.measure)
        throw new UnitError("INCOMPATIBLE_UNITS", "Addition and subtraction require matching measures");
    return a.measure ? a : b;
}
export function addUnits(left, right) {
    return sumAnalysis(left, right, false);
}
export function subtractUnits(left, right) {
    return sumAnalysis(left, right, true);
}
/** Exact internal reference magnitudes preserve inputs and defer floating-point rounding. */
export class Quantity {
    baseValue;
    dimensions;
    measure;
    units;
    constructor(value, unit) {
        const metadata = analyzeUnit(unit), factor = exact(unit);
        this.baseValue = bounded(() => r.add(r.multiply(r.fromNumber(finite(value)), factor.scale), factor.offset));
        this.dimensions = metadata.dimensions;
        this.measure = metadata.measure;
        this.units = unit;
        Object.freeze(this);
    }
    static fromBase(value, metadata) {
        const result = Object.create(Quantity.prototype);
        Object.defineProperties(result, {
            baseValue: { value },
            dimensions: { value: metadata.dimensions, enumerable: true },
            measure: { value: metadata.measure, enumerable: true },
            units: { value: metadata.unit, enumerable: true },
        });
        if (metadata.unit)
            result.value;
        Object.freeze(result);
        return result;
    }
    get value() {
        if (!this.units)
            throw new UnitError("UNRESOLVED_UNIT", "Choose a registered result unit with to(unit)");
        const factor = exact(this.units);
        return bounded(() => finite(r.toNumber(r.divide(r.subtract(this.baseValue, factor.offset), factor.scale))));
    }
    metadata() {
        return this.units
            ? analyzeUnit(this.units)
            : analyzeDimensions(this.dimensions);
    }
    to(target) {
        const metadata = analyzeUnit(target);
        if (!sameDimensions(this.dimensions, metadata.dimensions) ||
            (this.measure !== null && this.measure !== metadata.measure))
            throw new UnitError("INCOMPATIBLE_UNITS", `Cannot express this quantity in ${target}`);
        return Quantity.fromBase(this.baseValue, metadata);
    }
    add(other) {
        return bounded(() => Quantity.fromBase(r.add(this.baseValue, other.baseValue), addUnits(this.metadata(), other.metadata())));
    }
    subtract(other) {
        return bounded(() => Quantity.fromBase(r.subtract(this.baseValue, other.baseValue), subtractUnits(this.metadata(), other.metadata())));
    }
    multiply(other) {
        return bounded(() => Quantity.fromBase(r.multiply(this.baseValue, other.baseValue), multiplyUnits(this.metadata(), other.metadata())));
    }
    divide(other) {
        if (other.baseValue.n === 0n)
            throw new UnitError("INVALID_OPERATION", "Cannot divide by zero");
        return bounded(() => Quantity.fromBase(r.divide(this.baseValue, other.baseValue), divideUnits(this.metadata(), other.metadata())));
    }
    pow(exponent) {
        const metadata = powerUnit(this.metadata(), exponent);
        try {
            return Quantity.fromBase(r.power(this.baseValue, exponent), metadata);
        }
        catch (error) {
            if (error instanceof RangeError)
                throw new UnitError("INVALID_VALUE", error.message);
            throw error;
        }
    }
    toJSON() {
        return { value: this.value, units: this.units };
    }
}
export function qty(value, unit) {
    return new Quantity(value, unit);
}
