import assert from "node:assert/strict";
import test from "node:test";
import { buildRegistry, generate } from "./generate.mjs";

const source = () => ({
  config: {
    version: "0.1.0",
    format_version: 1,
    dimensions: ["time"],
    basis: { time: "s" },
  },
  prefixes: {
    m: { name: "milli", exponent: -3 },
    µ: { name: "micro", exponent: -6 },
  },
  definitions: {
    time: {
      dimensions: { time: 1 },
      reference_unit: "s",
      systems: {
        metric: {
          s: {
            name: { singular: "second", plural: "seconds" },
            to_anchor: 1,
            prefixes: true,
          },
        },
      },
    },
  },
});
const build = ({ config, prefixes, definitions }) =>
  buildRegistry(config, prefixes, definitions);

test("prefixes expand once into canonical units, including restricted lists", () => {
  const input = source();
  assert.deepEqual(Object.keys(build(input).units), ["ms", "s", "µs"]);
  input.definitions.time.systems.metric.s.prefixes = ["µ"];
  assert.deepEqual(Object.keys(build(input).units), ["s", "µs"]);
});

const familySource = () => {
  const input = source();
  input.config.dimensions.push("length");
  input.config.basis.length = "m";
  input.definitions.length = {
    dimensions: { length: 1 },
    reference_unit: "m",
    systems: {
      metric: {
        m: {
          name: { singular: "meter", plural: "meters" },
          to_anchor: 1,
          prefixes: true,
        },
      },
    },
  };
  // This measure sorts before length, so its prefixed components appear later.
  input.definitions.aVelocity = {
    dimensions: { length: 1, time: -1 },
    reference_unit: "m/s",
    systems: {
      metric: {
        "m/s": {
          name: { singular: "meter per second", plural: "meters per second" },
          components: { m: 1, s: -1 },
          prefixes: { component: "m", symbols: true },
        },
      },
    },
  };
  return input;
};
const familyUnit = (input) => input.definitions.aVelocity.systems.metric["m/s"];

test("compound prefix families expand registered components with exact factors and names", () => {
  const input = familySource();
  const registry = build(input);
  assert.deepEqual(registry.units["mm/s"].components, { mm: 1, s: -1 });
  assert.deepEqual(registry.units["mm/s"].scale_ratio, {
    numerator: "1",
    denominator: "1000",
  });
  assert.deepEqual(registry.units["µm/s"].name, {
    singular: "micrometer per second",
    plural: "micrometers per second",
  });
  familyUnit(input).prefixes.symbols = ["µ"];
  const restricted = build(input);
  assert.equal(restricted.units["mm/s"], undefined);
  assert.ok(restricted.units["µm/s"]);
  assert.ok(restricted.units["m/s"]);
});

test("prefix family expansion matches equivalent explicit unit declarations", () => {
  const input = familySource();
  const expanded = build(input);
  delete familyUnit(input).prefixes;
  const units = input.definitions.aVelocity.systems.metric;
  for (const [prefix, { name }] of Object.entries(input.prefixes))
    units[`${prefix}m/s`] = {
      name: {
        singular: `${name}meter per second`,
        plural: `${name}meters per second`,
      },
      components: { [`${prefix}m`]: 1, s: -1 },
    };
  assert.deepEqual(build(input), expanded);
});

const quotientSource = () => {
  const input = familySource();
  delete input.definitions.aVelocity.systems;
  input.definitions.aVelocity.quotients = [
    {
      numerator: { measure: "length" },
      denominator: { measure: "time", units: ["s"] },
    },
  ];
  return input;
};
const quotient = (input) => input.definitions.aVelocity.quotients[0];

test("measure quotients match equivalent explicit and prefix-family definitions", () => {
  assert.deepEqual(build(quotientSource()), build(familySource()));
});

test("quotients select units on both sides and derive exact factors and names", () => {
  const input = quotientSource();
  quotient(input).numerator.units = ["m", "mm"];
  quotient(input).denominator.units = ["s", "ms"];
  const registry = build(input);
  assert.deepEqual(registry.units["mm/ms"].components, { mm: 1, ms: -1 });
  assert.deepEqual(registry.units["m/ms"].scale_ratio, {
    numerator: "1000",
    denominator: "1",
  });
  assert.deepEqual(registry.units["mm/ms"].name, {
    singular: "millimeter per millisecond",
    plural: "millimeters per millisecond",
  });
  assert.equal(registry.units["µm/s"], undefined);
  delete quotient(input).denominator.units;
  assert.ok(build(input).units["m/µs"]);
});

test("quotients automatically include new source units and inherit numerator systems", () => {
  const input = quotientSource();
  input.definitions.length.systems.imperial = {
    ft: { name: { singular: "foot", plural: "feet" }, to_anchor: 1 },
  };
  input.definitions.length.anchors = {
    imperial: { metric: { ratio: 0.3048 } },
  };
  const registry = build(input);
  assert.equal(registry.units["ft/s"].system, "imperial");
  assert.equal(registry.units["ft/s"].scale, 0.3048);
  assert.deepEqual(registry.units["ft/s"].name, {
    singular: "foot per second",
    plural: "feet per second",
  });
  assert.deepEqual(registry.measures.aVelocity.systems, ["metric", "imperial"]);
});

test("quotient spellings replace generated names without adding aliases", () => {
  const input = quotientSource();
  quotient(input).spellings = { "mm/s": "mmps" };
  const registry = build(input);
  assert.equal(registry.units["mm/s"], undefined);
  assert.deepEqual(registry.units.mmps, build(quotientSource()).units["mm/s"]);
});

test("quotient dependencies expand before consumers and parenthesize compound operands", () => {
  const input = quotientSource();
  input.definitions.aAcceleration = {
    dimensions: { length: 1, time: -2 },
    reference_unit: "(m/s)/s",
    quotients: [
      {
        numerator: { measure: "aVelocity", units: ["m/s"] },
        denominator: { measure: "time", units: ["s"] },
      },
    ],
  };
  const registry = build(input);
  assert.deepEqual(registry.units["(m/s)/s"].components, { "m/s": 1, s: -1 });
  assert.equal(registry.units["(m/s)/s"].scale, 1);
});

for (const [name, mutate, pattern] of [
  [
    "empty families",
    (x) => (x.definitions.aVelocity.quotients = []),
    /nonempty list/,
  ],
  [
    "missing numerator",
    (x) => delete quotient(x).numerator,
    /must be an object/,
  ],
  [
    "missing denominator",
    (x) => delete quotient(x).denominator,
    /must be an object/,
  ],
  ["unknown field", (x) => (quotient(x).extra = true), /unknown property/],
  [
    "unknown selector field",
    (x) => (quotient(x).numerator.extra = true),
    /unknown property/,
  ],
  [
    "missing measure",
    (x) => delete quotient(x).numerator.measure,
    /nonempty string/,
  ],
  [
    "unknown measure",
    (x) => (quotient(x).numerator.measure = "unknown"),
    /unknown measure/,
  ],
  [
    "empty selection",
    (x) => (quotient(x).numerator.units = []),
    /nonempty list/,
  ],
  [
    "null selection",
    (x) => (quotient(x).numerator.units = null),
    /nonempty list/,
  ],
  [
    "string selection",
    (x) => (quotient(x).numerator.units = "m"),
    /nonempty list/,
  ],
  [
    "duplicate selection",
    (x) => (quotient(x).numerator.units = ["m", "m"]),
    /duplicate selected unit/,
  ],
  [
    "unknown selected unit",
    (x) => (quotient(x).numerator.units = ["km"]),
    /does not belong/,
  ],
  [
    "wrong measure selection",
    (x) => (quotient(x).numerator.units = ["s"]),
    /does not belong/,
  ],
  [
    "null spellings",
    (x) => (quotient(x).spellings = null),
    /must be an object/,
  ],
  [
    "invalid spelling",
    (x) => (quotient(x).spellings = { "mm/s": "" }),
    /nonempty string/,
  ],
  [
    "unused spelling",
    (x) => (quotient(x).spellings = { "cm/s": "cmps" }),
    /unused quotient spelling/,
  ],
  [
    "spelling collision",
    (x) => (quotient(x).spellings = { "mm/s": "m/s" }),
    /duplicate unit/,
  ],
  [
    "unit collision",
    (x) =>
      (x.definitions.aVelocity.systems = {
        metric: {
          "mm/s": {
            name: {
              singular: "millimeter per second",
              plural: "millimeters per second",
            },
            components: { mm: 1, s: -1 },
          },
        },
      }),
    /duplicate unit/,
  ],
  [
    "measure cycle",
    (x) => (quotient(x).numerator.measure = "aVelocity"),
    /dependency cycle/,
  ],
  [
    "wrong dimensions",
    (x) => (x.definitions.aVelocity.dimensions = { time: -1 }),
    /dimensions do not match/,
  ],
  [
    "absolute target",
    (x) => (x.definitions.aVelocity.kind = "absolute"),
    /cannot define absolute/,
  ],
  [
    "absolute operand",
    (x) => (x.definitions.length.kind = "absolute"),
    /linear or difference/,
  ],
  [
    "identical operands",
    (x) => (quotient(x).numerator = { measure: "time", units: ["s"] }),
    /identical quotient operands/,
  ],
]) {
  test(`reject measure quotient: ${name}`, () => {
    const input = quotientSource();
    mutate(input);
    assert.throws(() => build(input), pattern);
  });
}

for (const [name, mutate, pattern] of [
  [
    "missing selection",
    (x) => delete familyUnit(x).prefixes.symbols,
    /nonempty list/,
  ],
  [
    "empty selection",
    (x) => (familyUnit(x).prefixes.symbols = []),
    /nonempty list/,
  ],
  [
    "false selection",
    (x) => (familyUnit(x).prefixes.symbols = false),
    /nonempty list/,
  ],
  [
    "unknown prefix",
    (x) => (familyUnit(x).prefixes.symbols = ["bad"]),
    /unknown prefix/,
  ],
  [
    "duplicate prefix",
    (x) => (familyUnit(x).prefixes.symbols = ["m", "m"]),
    /duplicate unit/,
  ],
  [
    "unknown property",
    (x) => (familyUnit(x).prefixes.extra = true),
    /unknown property/,
  ],
  [
    "missing component",
    (x) => delete familyUnit(x).prefixes.component,
    /nonempty string/,
  ],
  [
    "unknown component",
    (x) => {
      familyUnit(x).components = { x: 1, s: -1 };
      familyUnit(x).prefixes.component = "x";
      x.definitions.aVelocity.systems.metric["x/s"] = familyUnit(x);
      delete x.definitions.aVelocity.systems.metric["m/s"];
    },
    /unprefixed simple unit/,
  ],
  [
    "denominator prefix",
    (x) => (familyUnit(x).prefixes.component = "s"),
    /first numerator/,
  ],
  ["powered component", (x) => (familyUnit(x).components.m = 2), /exponent 1/],
  [
    "anchor instead of components",
    (x) => {
      delete familyUnit(x).components;
      familyUnit(x).to_anchor = 1;
    },
    /first numerator/,
  ],
  [
    "prefix disabled on component",
    (x) => (x.definitions.length.systems.metric.m.prefixes = ["µ"]),
    /does not enable prefix m/,
  ],
  [
    "already prefixed component",
    (x) => {
      const units = x.definitions.aVelocity.systems.metric;
      units["mm/s"] = familyUnit(x);
      units["mm/s"].components = { mm: 1, s: -1 };
      units["mm/s"].prefixes.component = "mm";
      delete units["m/s"];
    },
    /unprefixed simple unit/,
  ],
  [
    "name does not identify component",
    (x) => (familyUnit(x).name.singular = "speed"),
    /singular name/,
  ],
  [
    "plural does not identify component",
    (x) => (familyUnit(x).name.plural = "speeds"),
    /plural name/,
  ],
  [
    "explicit unit collision",
    (x) => {
      x.definitions.aVelocity.systems.metric["mm/s"] = {
        name: {
          singular: "millimeter per second",
          plural: "millimeters per second",
        },
        components: { mm: 1, s: -1 },
      };
    },
    /duplicate unit/,
  ],
  [
    "expanded component collision",
    (x) => (familyUnit(x).components.mm = 1),
    /duplicate component/,
  ],
]) {
  test(`reject compound prefix family: ${name}`, () => {
    const input = familySource();
    mutate(input);
    assert.throws(() => build(input), pattern);
  });
}

for (const [name, mutate, pattern] of [
  [
    "unit collision",
    (x) => {
      x.definitions.time.systems.metric.ms = {
        name: { singular: "millisecond", plural: "milliseconds" },
        to_anchor: 0.001,
      };
    },
    /duplicate unit/,
  ],
  [
    "cross-measure collision",
    (x) => {
      x.definitions.other = structuredClone(x.definitions.time);
    },
    /duplicate unit/,
  ],
  [
    "unknown prefix",
    (x) => {
      x.definitions.time.systems.metric.s.prefixes = ["unknown"];
    },
    /unknown prefix/,
  ],
  [
    "duplicate enabled prefix",
    (x) => {
      x.definitions.time.systems.metric.s.prefixes = ["m", "m"];
    },
    /duplicate unit/,
  ],
  [
    "unknown dimension",
    (x) => {
      x.definitions.time.dimensions = { length: 1 };
    },
    /unknown property/,
  ],
  [
    "noninteger exponent",
    (x) => {
      x.definitions.time.dimensions.time = 0.5;
    },
    /safe integer/,
  ],
  [
    "zero scale",
    (x) => {
      x.definitions.time.systems.metric.s.to_anchor = 0;
    },
    /positive/,
  ],
  [
    "infinite scale",
    (x) => {
      x.definitions.time.systems.metric.s.to_anchor = Infinity;
    },
    /finite/,
  ],
  [
    "zero denominator",
    (x) => {
      x.definitions.time.systems.metric.s.to_anchor = {
        numerator: 1,
        denominator: 0,
      };
    },
    /denominator/,
  ],
  [
    "unknown reference",
    (x) => {
      x.definitions.time.reference_unit = "missing";
    },
    /reference_unit/,
  ],
  [
    "scaled reference",
    (x) => {
      x.definitions.time.systems.metric.s.to_anchor = 2;
    },
    /reference_unit/,
  ],
  [
    "offset prefixes",
    (x) => {
      x.definitions.time.kind = "absolute";
      x.definitions.time.systems.metric.s.anchor_shift = 1;
    },
    /offset units/,
  ],
  [
    "linear offset",
    (x) => {
      x.definitions.time.systems.metric.s.anchor_shift = 1;
    },
    /only absolute/,
  ],
  [
    "unknown property",
    (x) => {
      x.definitions.time.aliases = ["seconds"];
    },
    /unknown property/,
  ],
  [
    "prefix overflow",
    (x) => {
      x.prefixes.m.exponent = 9999;
    },
    /finite/,
  ],
  [
    "prefix underflow",
    (x) => {
      x.prefixes.m.exponent = -9999;
    },
    /positive/,
  ],
  [
    "empty definitions",
    (x) => {
      x.definitions = {};
    },
    /requires a measure/,
  ],
  [
    "compound prefixes",
    (x) => {
      x.definitions.time.systems.metric["m/s"] = {
        name: { singular: "meter per second", plural: "meters per second" },
        to_anchor: 1,
        prefixes: true,
      };
    },
    /compound and powered units/,
  ],
  [
    "system without an anchor unit",
    (x) => {
      x.definitions.time.systems.other = {
        tick: { name: { singular: "tick", plural: "ticks" }, to_anchor: 2 },
      };
      x.definitions.time.anchors = { other: { metric: { ratio: 1 } } };
    },
    /requires an anchor unit/,
  ],
]) {
  test(`reject invalid registry: ${name}`, () => {
    const input = source();
    mutate(input);
    assert.throws(() => build(input), pattern);
  });
}

test("JSON affine transforms normalize anchors consistently", () => {
  const input = source();
  input.definitions.time.kind = "absolute";
  input.definitions.time.systems.other = {
    baseTick: {
      name: { singular: "base tick", plural: "base ticks" },
      to_anchor: 1,
    },
    tick: {
      name: { singular: "tick", plural: "ticks" },
      to_anchor: 2,
      anchor_shift: 3,
    },
  };
  input.definitions.time.anchors = {
    other: {
      metric: {
        transform: { scale: { numerator: 1, denominator: 2 }, offset: 4 },
      },
    },
  };
  const tick = build(input).units.tick;
  assert.equal(tick.scale, 1);
  assert.equal(tick.offset, 2.5);
  input.definitions.time.anchors.other.metric.ratio = 1;
  assert.throws(() => build(input), /exactly one/);
});

test("cross-system definitions require a direct anchor to the reference system", () => {
  const input = source();
  input.definitions.time.systems.other = {
    tick: { name: { singular: "tick", plural: "ticks" }, to_anchor: 1 },
  };
  assert.throws(() => build(input), /missing anchor/);
});

test("all checked-in registry and type artifacts are current", async () => {
  await generate(true);
});

const fullSource = async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const read = async (file) =>
    JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  const definitions = {};
  for (const file of await readdir(new URL("../definitions/", import.meta.url)))
    definitions[file.slice(0, -5)] = await read(`definitions/${file}`);
  return {
    config: await read("registry.json"),
    prefixes: await read("prefixes.json"),
    definitions,
  };
};

test("components derive exact factors and dimensions across prefixes and systems", async () => {
  const registry = build(await fullSource());
  assert.deepEqual(registry.units["km/h"].scale_ratio, {
    numerator: "5",
    denominator: "18",
  });
  assert.deepEqual(registry.units["cm2"].scale_ratio, {
    numerator: "1",
    denominator: "10000",
  });
  assert.deepEqual(registry.units["mm3"].scale_ratio, {
    numerator: "1",
    denominator: "1000000000",
  });
  assert.equal(registry.units["Wh"].scale, 3600);
});

for (const [name, mutate, pattern] of [
  [
    "unknown component",
    (x) => {
      x.definitions.velocity.systems.metric["m/s"].components = { unknown: 1 };
    },
    /unknown component/,
  ],
  [
    "dependency cycle",
    (x) => {
      x.definitions.velocity.systems.metric["m/s"].components = { "m/s": 1 };
    },
    /cycle/,
  ],
  [
    "wrong dimensions",
    (x) => {
      x.definitions.velocity.systems.metric["m/s"].components = { kg: 1 };
    },
    /dimensions do not match/,
  ],
  [
    "offset component",
    (x) => {
      x.definitions.velocity.systems.metric["m/s"].components = { C: 1 };
    },
    /linear or difference/,
  ],
  [
    "ambiguous source definition",
    (x) => {
      x.definitions.velocity.systems.metric["m/s"].to_anchor = 1;
    },
    /exactly one/,
  ],
  [
    "incoherent base reference",
    (x) => {
      x.definitions.length.reference_unit = "cm";
      x.definitions.length.systems.metric.m.to_anchor = 100;
    },
    /coherent scale/,
  ],
  [
    "missing declared basis",
    (x) => {
      delete x.config.basis.length;
    },
    /coherent basis/,
  ],
  [
    "derived reference without components",
    (x) => {
      const u = x.definitions.velocity.systems.metric["m/s"];
      delete u.components;
      u.to_anchor = 1;
    },
    /must declare components/,
  ],
]) {
  test(`reject component registry: ${name}`, async () => {
    const input = await fullSource();
    mutate(input);
    assert.throws(() => build(input), pattern);
  });
}

test("registry growth preserves designated inference and fingerprints are deterministic", async () => {
  const input = await fullSource();
  const original = build(input);
  const reversed = {
    ...input,
    definitions: Object.fromEntries(
      Object.entries(input.definitions).reverse(),
    ),
  };
  assert.equal(build(reversed).fingerprint, original.fingerprint);
  input.definitions.alternativeVelocity = {
    dimensions: { length: 1, time: -1 },
    reference_unit: "alternativeMps",
    systems: {
      metric: {
        alternativeMps: {
          name: {
            singular: "alternative meter per second",
            plural: "alternative meters per second",
          },
          components: { "m/s": 1 },
        },
      },
    },
  };
  const expanded = build(input);
  assert.equal(expanded.measures.velocity.default_result, true);
  assert.equal(expanded.measures.alternativeVelocity.default_result, false);
  assert.notEqual(expanded.fingerprint, original.fingerprint);
  input.definitions.alternativeVelocity.default_result = true;
  assert.throws(() => build(input), /duplicate default result/);
});

/** Keep values near one while exact fractions double in size at each stage. */
function componentWorkSource(stages, cancelFinal = false) {
  const input = source();
  const units = {
    1: { name: { singular: "one", plural: "ones" }, to_anchor: 1 },
    ratioSeed: {
      name: { singular: "ratio seed", plural: "ratio seeds" },
      to_anchor: 1.0000000000000002,
    },
  };
  let previous = "ratioSeed";
  for (let index = 0; index < stages; index++) {
    const alias = `ratioAlias${index}`;
    const stage = `ratioStage${index}`;
    units[alias] = {
      name: {
        singular: `ratio alias ${index}`,
        plural: `ratio aliases ${index}`,
      },
      components: { [previous]: 1 },
    };
    units[stage] = {
      name: {
        singular: `ratio stage ${index}`,
        plural: `ratio stages ${index}`,
      },
      components: { [previous]: 1, [alias]: 1 },
    };
    previous = stage;
  }
  if (cancelFinal) {
    units.ratioFinalAlias = {
      name: { singular: "final ratio alias", plural: "final ratio aliases" },
      components: { [previous]: 1 },
    };
    units.ratioCancelled = {
      name: { singular: "cancelled ratio", plural: "cancelled ratios" },
      components: { [previous]: 1, ratioFinalAlias: -1 },
    };
  }
  input.definitions.ratio = {
    dimensions: {},
    reference_unit: "1",
    systems: { metric: units },
  };
  return input;
}

test("component composition enforces the shared bit budget even when every exponent is one", () => {
  // The seed has 53-bit factors. Eleven products exceed 100,000 bits even
  // though each unit's numeric scale remains finite and close to one.
  assert.throws(
    () => build(componentWorkSource(11)),
    /rational.*limit|work limit/i,
  );
});

test("component composition cross-cancels large reciprocal scales before its work preflight", () => {
  // Ten products produce roughly 53,000-bit factors. The final numerator and
  // denominator would exceed the budget if multiplied before cross-cancelling.
  const registry = build(componentWorkSource(10, true));
  assert.deepEqual(registry.units.ratioCancelled.scale_ratio, {
    numerator: "1",
    denominator: "1",
  });
  assert.equal(registry.units.ratioCancelled.scale, 1);
});
