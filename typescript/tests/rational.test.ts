import assert from "node:assert/strict";
import test from "node:test";
import { UnitError, qty } from "../index.ts";
import {
  MAX_RATIONAL_BITS,
  ONE,
  ZERO,
  add,
  divide,
  fromNumber,
  fromWire,
  multiply,
  power,
  rational,
  subtract,
  toNumber,
} from "../src/rational.ts";

test("exact fractions preserve finite double inputs across exponents", () => {
  const view = new DataView(new ArrayBuffer(8));
  let state = 0x123456789abcdefn;
  for (let index = 0; index < 512; index++) {
    state = BigInt.asUintN(
      64,
      state * 6364136223846793005n + 1442695040888963407n,
    );
    view.setBigUint64(0, state);
    const value = view.getFloat64(0);
    if (Number.isFinite(value))
      assert.equal(toNumber(fromNumber(value)), value);
  }
  for (const value of [
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    Number.EPSILON,
  ])
    assert.equal(toNumber(fromNumber(value)), value);
});

test("fraction conversion rounds ties to even, including subnormals", () => {
  assert.equal(toNumber(rational((1n << 53n) + 1n, 1n << 53n)), 1);
  assert.equal(
    toNumber(rational((1n << 53n) + 3n, 1n << 53n)),
    1 + 2 * Number.EPSILON,
  );
  assert.equal(toNumber(rational(1n, 1n << 1075n)), 0);
  assert.equal(toNumber(rational(3n, 1n << 1075n)), 2 * Number.MIN_VALUE);
});

const limitError = (error: unknown): boolean =>
  error instanceof RangeError &&
  /rational.*limit|work limit/i.test(error.message);

test("the shared rational budget accepts either sign at the exact bit boundary", () => {
  assert.equal(MAX_RATIONAL_BITS, 100000);
  const boundary = 1n << BigInt(MAX_RATIONAL_BITS - 1);
  assert.deepEqual(rational(boundary), { n: boundary, d: 1n });
  assert.deepEqual(rational(-boundary), { n: -boundary, d: 1n });
  assert.deepEqual(rational(boundary, -1n), { n: -boundary, d: 1n });
  assert.deepEqual(rational(-boundary, -1n), { n: boundary, d: 1n });
  assert.deepEqual(rational(1n, boundary), { n: 1n, d: boundary });
  assert.deepEqual(rational(boundary, boundary), ONE);
});

test("construction and wire decoding reject oversized reduced numerators or denominators", () => {
  const oversized = 1n << BigInt(MAX_RATIONAL_BITS);
  for (const numerator of [oversized, -oversized]) {
    assert.throws(() => rational(numerator), limitError);
    assert.throws(
      () => fromWire({ numerator: String(numerator), denominator: "1" }),
      limitError,
    );
  }
  assert.throws(() => rational(1n, oversized), limitError);
  assert.throws(
    () => fromWire({ numerator: "1", denominator: String(oversized) }),
    limitError,
  );
});

test("multiplication and division enforce the budget without relying on pow", () => {
  const half = 1n << BigInt(MAX_RATIONAL_BITS / 2);
  const integer = rational(half);
  const reciprocal = rational(1n, half);
  assert.throws(() => multiply(integer, integer), limitError);
  assert.throws(() => multiply(reciprocal, reciprocal), limitError);
  assert.throws(() => divide(integer, reciprocal), limitError);
  assert.throws(() => divide(reciprocal, integer), limitError);
});

test("near-limit products cross-cancel before multiplying or allocating oversized intermediates", () => {
  const boundary = 1n << BigInt(MAX_RATIONAL_BITS - 1);
  const fraction = rational(boundary - 1n, boundary);
  const inverse = rational(boundary, boundary - 1n);
  assert.deepEqual(multiply(fraction, inverse), ONE);
  assert.deepEqual(divide(fraction, fraction), ONE);
  assert.deepEqual(
    multiply(rational(-fraction.n, fraction.d), inverse),
    rational(-1n),
  );
  assert.deepEqual(
    divide(rational(-inverse.n, inverse.d), inverse),
    rational(-1n),
  );
  assert.deepEqual(multiply(inverse, ONE), inverse);
  assert.deepEqual(divide(inverse, ONE), inverse);
  assert.deepEqual(multiply(inverse, ZERO), ZERO);
});

test("gcd-aware addition permits shared near-limit denominators and opposite-sign cancellation", () => {
  const boundary = 1n << BigInt(MAX_RATIONAL_BITS - 1);
  const almostOne = rational(boundary - 1n, boundary);
  const remainder = rational(1n, boundary);
  assert.deepEqual(add(almostOne, remainder), ONE);
  assert.deepEqual(subtract(almostOne, rational(-1n, boundary)), ONE);
  assert.deepEqual(add(rational(boundary), rational(-boundary)), ZERO);
  assert.deepEqual(add(rational(boundary), rational(1n - boundary)), ONE);
  assert.deepEqual(subtract(rational(-boundary), rational(-boundary)), ZERO);
  assert.deepEqual(add(rational(boundary - 1n), ONE), rational(boundary));
});

test("addition and subtraction reject results whose reduced numerator exceeds the budget", () => {
  const boundary = 1n << BigInt(MAX_RATIONAL_BITS - 1);
  assert.throws(() => add(rational(boundary), rational(boundary)), limitError);
  assert.throws(
    () => subtract(rational(-boundary), rational(boundary)),
    limitError,
  );
});

test("powers preserve boundary identities and negative signs within the shared budget", () => {
  const boundary = 1n << BigInt(MAX_RATIONAL_BITS - 1);
  assert.deepEqual(power(rational(-boundary), 1), rational(-boundary));
  assert.deepEqual(power(rational(-boundary), 0), ONE);
  assert.deepEqual(power(rational(-boundary), -1), rational(-1n, boundary));
  assert.throws(() => power(rational(boundary), 2), limitError);
});

test("composed quantity multiplication reports resource exhaustion as INVALID_VALUE", () => {
  let value = qty(1 + Number.EPSILON, "1");
  for (let index = 0; index < 10; index++) value = value.multiply(value);
  assert.equal(Number.isFinite(value.value), true);
  assert.deepEqual(value.divide(value).toJSON(), { value: 1, units: "1" });
  assert.throws(
    () => value.multiply(value),
    (error) => error instanceof UnitError && error.code === "INVALID_VALUE",
  );
});
