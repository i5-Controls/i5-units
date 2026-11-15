import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const configPath = resolve(root, "typescript/tsconfig.build.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error)
  throw new Error(
    ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
  );
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  dirname(configPath),
);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const outputs = new Map();
const emitted = program.emit(undefined, (path, content) =>
  outputs.set(path, content),
);
const diagnostics = [
  ...parsed.errors,
  ...ts.getPreEmitDiagnostics(program),
  ...emitted.diagnostics,
];
if (diagnostics.length) {
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
}
for (const [path, content] of outputs) {
  if (check) {
    if ((await readFile(path, "utf8").catch(() => null)) !== content)
      throw new Error(
        `${path} is stale; run npm run build:node and commit dist/`,
      );
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}
