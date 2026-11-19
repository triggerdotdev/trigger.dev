// Typechecks the SDK once per AI SDK major listed in test/ai-sdk-majors.json,
// besides the default one the plain `tsc --noEmit` already covers. Each major
// needs a `tsconfig.ai-v<major>.json` whose `paths` map `ai` to a declaration
// file of that major. A mapping to a missing file would let TypeScript fall
// back to the installed default `ai` and pass without checking anything, so
// the mapping is verified before tsc runs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const majors = JSON.parse(readFileSync(join(root, "test/ai-sdk-majors.json"), "utf8"));

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

/** The version of the package a file belongs to. */
function packageVersionOf(file) {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8")).version;
  }
  return undefined;
}

for (const { major } of majors.tested) {
  if (major === majors.default) continue;
  const config = `tsconfig.ai-v${major}.json`;
  const configPath = join(root, config);
  if (!existsSync(configPath)) fail(`AI SDK ${major} is tested but ${config} is missing.`);

  // tsconfig allows line comments; the mapping itself never contains `//`.
  const text = readFileSync(configPath, "utf8").replace(/^\s*\/\/.*$/gm, "");
  const target = JSON.parse(text).compilerOptions?.paths?.ai?.[0];
  if (!target) fail(`${config} does not map \`ai\` in compilerOptions.paths.`);
  const declarations = resolve(root, target);
  if (!existsSync(declarations)) fail(`${config} maps \`ai\` to ${target}, which does not exist.`);
  const version = packageVersionOf(declarations);
  if (!version?.startsWith(`${major}.`)) {
    fail(`${config} maps \`ai\` to ${target}, which is AI SDK ${version}, not ${major}.`);
  }

  console.log(`Typechecking against AI SDK ${version} (${config})`);
  const result = spawnSync("tsc", ["--noEmit", "-p", config], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
