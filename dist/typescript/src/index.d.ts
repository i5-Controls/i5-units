import type { Dimension, Measure, Unit } from "./types.generated.ts";
export type { Dimension, Measure, Unit, UnitOfMeasure, UnitsByMeasure, } from "./types.generated.ts";
export type Dimensions = Readonly<Partial<Record<Dimension, number>>>;
export type UnitKind = "linear" | "absolute" | "difference";
export type UnitErrorCode = "UNKNOWN_UNIT" | "UNKNOWN_MEASURE" | "INCOMPATIBLE_UNITS" | "INVALID_VALUE" | "INVALID_OPERATION" | "UNRESOLVED_UNIT" | "CONSTRAINT_VIOLATION";
export declare class UnitError extends Error {
    readonly code: UnitErrorCode;
    constructor(code: UnitErrorCode, message: string);
}
interface Ratio {
    numerator: string;
    denominator: string;
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
export declare const registryVersion: string;
export declare const registryFingerprint: string;
export declare const registryFormatVersion: number;
export declare function hasUnit(unit: unknown): unit is Unit;
export declare function parseUnit(input: unknown): Unit;
export declare function parseMeasure(input: unknown): Measure;
export declare function describe(unit: Unit): UnitDescription;
export declare function measures(): Measure[];
export declare function list(measure?: Measure): UnitDescription[];
export declare function possibilities(measure?: Measure): Unit[];
export { MAX_RATIONAL_BITS } from "./rational.ts";
export declare function canConvert(source: unknown, target: unknown): boolean;
export interface ConversionPlan {
    readonly source: Unit;
    readonly target: Unit;
    readonly scale_ratio: Readonly<Ratio>;
    readonly offset_ratio: Readonly<Ratio>;
    convert(value: number): number;
}
/** Resolve a fixed pair once; preserve exact coefficients and round the result once. */
export declare function conversionPlan(source: Unit, target: Unit): ConversionPlan;
export declare class Converter {
    private readonly amount;
    private readonly source?;
    constructor(value?: number, source?: Unit);
    from(source: Unit): Converter;
    to(target: Unit): number;
    describe: typeof describe;
    list: typeof list;
    measures: typeof measures;
    possibilities(measure?: Measure): Unit[];
}
export declare function convert(value?: number): Converter;
export interface NumericConstraints {
    integer?: boolean;
    minimum?: number;
    maximum?: number;
    exclusive_minimum?: number;
    exclusive_maximum?: number;
    multiple_of?: number;
}
/** Preserve valid inputs; normalize only candidates satisfying every constraint. */
export declare function validateNumeric(value: number, constraints?: NumericConstraints): number;
export declare function convertAndValidate(value: number, source: Unit, target: Unit, constraints?: NumericConstraints): number;
export interface UnitAnalysis {
    readonly dimensions: Dimensions;
    readonly measure: Measure | null;
    readonly unit: Unit | null;
    readonly kind: UnitKind | null;
    readonly candidates: readonly Measure[];
}
export declare function analyzeDimensions(dimensions: Dimensions): UnitAnalysis;
export declare function analyzeUnit(unit: Unit): UnitAnalysis;
type Operand = Unit | UnitAnalysis;
export declare function multiplyUnits(left: Operand, right: Operand): UnitAnalysis;
export declare function divideUnits(left: Operand, right: Operand): UnitAnalysis;
export declare function powerUnit(unit: Operand, exponent: number): UnitAnalysis;
export declare function addUnits(left: Operand, right: Operand): UnitAnalysis;
export declare function subtractUnits(left: Operand, right: Operand): UnitAnalysis;
/** Exact internal reference magnitudes preserve inputs and defer floating-point rounding. */
export declare class Quantity {
    private readonly baseValue;
    readonly dimensions: Dimensions;
    readonly measure: Measure | null;
    readonly units: Unit | null;
    constructor(value: number, unit: Unit);
    private static fromBase;
    get value(): number;
    private metadata;
    to(target: Unit): Quantity;
    add(other: Quantity): Quantity;
    subtract(other: Quantity): Quantity;
    multiply(other: Quantity): Quantity;
    divide(other: Quantity): Quantity;
    pow(exponent: number): Quantity;
    toJSON(): {
        value: number;
        units: Unit;
    };
}
export declare function qty(value: number, unit: Unit): Quantity;
