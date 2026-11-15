/** Reduced exact fractions. Runtime inputs preserve their IEEE-754 value. */
export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

export const MAX_RATIONAL_BITS = 100000;
const MAX_WORK_BITS = 2 * MAX_RATIONAL_BITS + 1;
const MAX_MAGNITUDE = (1n << BigInt(MAX_RATIONAL_BITS)) - 1n;
export class RationalLimitError extends RangeError {
  constructor() {
    super(
      `Rational work limit exceeded (${MAX_RATIONAL_BITS} bits per reduced part)`,
    );
  }
}
function bits(value: bigint): number {
  return value === 0n ? 0 : (value < 0n ? -value : value).toString(2).length;
}
function checkParts(n: bigint, d: bigint): void {
  if (bits(n) > MAX_RATIONAL_BITS || bits(d) > MAX_RATIONAL_BITS)
    throw new RationalLimitError();
}
function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
function product(a: bigint, b: bigint, limit = MAX_RATIONAL_BITS): bigint {
  if (a === 0n || b === 0n) return 0n;
  const size = bits(a) + bits(b);
  if (size - 1 > limit) throw new RationalLimitError();
  if (size > limit) {
    const maximum =
      limit === MAX_RATIONAL_BITS ? MAX_MAGNITUDE : (1n << BigInt(limit)) - 1n;
    if ((a < 0n ? -a : a) > maximum / (b < 0n ? -b : b))
      throw new RationalLimitError();
  }
  return a * b;
}
export function rational(n: bigint, d = 1n): Rational {
  checkParts(n, d);
  if (d === 0n) throw new RangeError("Cannot divide by zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const common = gcd(n, d);
  return Object.freeze({ n: n / common, d: d / common });
}
function checked(value: Rational): Rational {
  checkParts(value.n, value.d);
  if (value.d <= 0n)
    throw new RangeError("Rational denominator must be positive");
  return value;
}

export const ZERO = rational(0n);
export const ONE = rational(1n);
const buffer = new ArrayBuffer(8);
const view = new DataView(buffer);

export function fromNumber(value: number): Rational {
  if (!Number.isFinite(value)) throw new RangeError("Expected a finite number");
  if (value === 0) return ZERO;
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n !== 0n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const significand = exponent === 0 ? fraction : fraction + (1n << 52n);
  const power = exponent === 0 ? -1074 : exponent - 1023 - 52;
  const n = negative ? -significand : significand;
  return power >= 0
    ? rational(n << BigInt(power))
    : rational(n, 1n << BigInt(-power));
}

export function fromWire(value: {
  numerator: string;
  denominator: string;
}): Rational {
  const maxDigits = Math.ceil(MAX_RATIONAL_BITS * Math.LOG10E * Math.LN2) + 1;
  for (const part of [value.numerator, value.denominator]) {
    if (!/^-?[0-9]+$/.test(part))
      throw new RangeError("Invalid rational integer");
    if (part.length > maxDigits + (part.startsWith("-") ? 1 : 0))
      throw new RationalLimitError();
  }
  return rational(BigInt(value.numerator), BigInt(value.denominator));
}

function sum(a: Rational, b: Rational, sign: bigint): Rational {
  checked(a);
  checked(b);
  const common = gcd(a.d, b.d);
  const left = product(a.n, b.d / common, MAX_WORK_BITS - 1);
  const right = product(b.n, a.d / common, MAX_WORK_BITS - 1);
  const numerator = left + sign * right;
  if (bits(numerator) > MAX_WORK_BITS) throw new RationalLimitError();
  if (numerator === 0n) return ZERO;
  const cancellation = gcd(numerator, common);
  const reduced = numerator / cancellation;
  checkParts(reduced, 1n);
  const denominator = product(a.d / common, b.d / cancellation);
  return rational(reduced, denominator);
}
export function add(a: Rational, b: Rational): Rational {
  return sum(a, b, 1n);
}
export function subtract(a: Rational, b: Rational): Rational {
  return sum(a, b, -1n);
}
export function multiply(a: Rational, b: Rational): Rational {
  checked(a);
  checked(b);
  if (a.n === 0n || b.n === 0n) return ZERO;
  const left = gcd(a.n, b.d),
    right = gcd(b.n, a.d);
  return rational(
    product(a.n / left, b.n / right),
    product(a.d / right, b.d / left),
  );
}
export function divide(a: Rational, b: Rational): Rational {
  checked(a);
  checked(b);
  if (b.n === 0n) throw new RangeError("Cannot divide by zero");
  const sign = b.n < 0n ? -1n : 1n;
  return multiply(a, { n: sign * b.d, d: sign * b.n });
}
export function power(a: Rational, exponent: number): Rational {
  checked(a);
  if (!Number.isSafeInteger(exponent))
    throw new RangeError("Power requires a safe integer exponent");
  const count = Math.abs(exponent);
  if (Math.max(bits(a.n), bits(a.d)) * count > MAX_RATIONAL_BITS)
    throw new RationalLimitError();
  return exponent >= 0
    ? rational(a.n ** BigInt(count), a.d ** BigInt(count))
    : rational(a.d ** BigInt(count), a.n ** BigInt(count));
}
/** Nearest exact integer, with ties to even (shared with Python Fraction). */
export function nearestInteger(value: Rational): bigint {
  checked(value);
  const negative = value.n < 0n;
  const n = negative ? -value.n : value.n;
  let quotient = n / value.d;
  const remainder = n % value.d;
  if (
    2n * remainder > value.d ||
    (2n * remainder === value.d && quotient % 2n !== 0n)
  )
    quotient++;
  return negative ? -quotient : quotient;
}
export function compare(a: Rational, b: Rational): number {
  checked(a);
  checked(b);
  // Inputs are bounded, so comparison products have at most twice that budget.
  const left = product(a.n, b.d, MAX_WORK_BITS - 1);
  const right = product(b.n, a.d, MAX_WORK_BITS - 1);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Round once to the nearest double, including subnormals and ties to even. */
export function toNumber(value: Rational): number {
  checked(value);
  if (value.n === 0n) return 0;
  const sign = value.n < 0n ? -1 : 1;
  const n = value.n < 0n ? -value.n : value.n;
  const d = value.d;
  let exponent = n.toString(2).length - d.toString(2).length;
  if (exponent >= 0 ? n < d << BigInt(exponent) : n << BigInt(-exponent) < d)
    exponent--;
  if (exponent > 1023) return sign * Infinity;
  if (exponent < -1075) return sign * 0;
  const quantum = Math.max(exponent - 52, -1074);
  const numerator = quantum < 0 ? n << BigInt(-quantum) : n;
  const denominator = quantum > 0 ? d << BigInt(quantum) : d;
  let q = numerator / denominator;
  const remainder = numerator % denominator;
  if (
    2n * remainder > denominator ||
    (2n * remainder === denominator && q % 2n !== 0n)
  )
    q++;
  return sign * Number(q) * 2 ** quantum;
}
