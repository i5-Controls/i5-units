// Compatibility entry point. All generation and validation live in Rust.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function invoke(args, input) {
  const executable = process.env.I5_UNITS_GENERATOR ?? "cargo";
  const command = process.env.I5_UNITS_GENERATOR
    ? []
    : [
        "run",
        "--quiet",
        "--locked",
        "--manifest-path",
        resolve(root, "Cargo.toml"),
        "--package",
        "i5-units-generator",
        "--",
      ];
  const result = spawnSync(executable, [...command, "--root", root, ...args], {
    cwd: root,
    input,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || "Registry generation failed");
  return result.stdout;
}
export function buildRegistry(config, prefixes, definitions) {
  const input = JSON.stringify(
    { config, prefixes, definitions },
    (_key, value) => {
      if (typeof value === "number" && !Number.isFinite(value))
        throw new Error("JSON input must contain only finite numbers");
      return value;
    },
  );
  return JSON.parse(invoke(["--stdin"], input));
}
export async function generate(check = false) {
  invoke(check ? ["--check"] : []);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.slice(2).some((argument) => argument !== "--check"))
    throw new Error("Usage: node scripts/generate.mjs [--check]");
  await generate(process.argv.includes("--check"));
}
