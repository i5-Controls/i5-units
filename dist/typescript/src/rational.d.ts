/** Reduced exact fractions. Runtime inputs preserve their IEEE-754 value. */
export interface Rational {
    readonly n: bigint;
    readonly d: bigint;
}
export declare const MAX_RATIONAL_BITS = 100000;
export declare class RationalLimitError extends RangeError {
    constructor();
}
export declare function rational(n: bigint, d?: bigint): Rational;
export declare const ZERO: Rational;
export declare const ONE: Rational;
export declare function fromNumber(value: number): Rational;
export declare function fromWire(value: {
    numerator: string;
    denominator: string;
}): Rational;
export declare function add(a: Rational, b: Rational): Rational;
export declare function subtract(a: Rational, b: Rational): Rational;
export declare function multiply(a: Rational, b: Rational): Rational;
export declare function divide(a: Rational, b: Rational): Rational;
export declare function power(a: Rational, exponent: number): Rational;
/** Nearest exact integer, with ties to even (shared with Python Fraction). */
export declare function nearestInteger(value: Rational): bigint;
export declare function compare(a: Rational, b: Rational): number;
/** Round once to the nearest double, including subnormals and ties to even. */
export declare function toNumber(value: Rational): number;
