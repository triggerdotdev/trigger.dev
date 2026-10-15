import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const COMPONENTS = ["RollingOut", "PrivateBeta"];

const TAG_PATTERN = new RegExp(`<(${COMPONENTS.join("|")})\\b`, "g");
const FEATURE_FLAG_MODULE = "apps/webapp/app/v3/featureFlags.ts";
const ENV_MODULE = "apps/webapp/app/env.server.ts";

export function extractFeatureStatusTags(source, file) {
  const tags = [];
  let inFence = false;

  source.split("\n").forEach((text, index) => {
    if (text.trimStart().startsWith("```")) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    for (const match of text.matchAll(TAG_PATTERN)) {
      tags.push(parseTag(text.slice(match.index), match[1], file, index + 1));
    }
  });

  return tags;
}

function parseTag(text, component, file, line) {
  const close = text.indexOf(">");
  if (close === -1) {
    return { file, line, component, error: "opening tag must be single-line" };
  }

  const end = text[close - 1] === "/" ? close - 1 : close;
  const body = text.slice(component.length + 1, end);
  if (body.includes("{")) {
    return { file, line, component, error: "attributes must be plain string literals" };
  }

  const flag = body.match(/\bflag="([^"]*)"/)?.[1];
  return { file, line, component, flag };
}

export function extractFeatureFlagKeys(source) {
  const start = source.indexOf("export const FEATURE_FLAG = {");
  if (start === -1) return new Set();

  const rest = source.slice(start);
  const end = rest.search(/^\}( as const)?;/m);
  if (end === -1) return new Set();

  const block = rest.slice(0, end);
  const keys = [...block.matchAll(/^\s*(\w+):\s*"(\w+)",?\s*$/gm)]
    .filter(([, key, value]) => key === value)
    .map(([, key]) => key);
  return new Set(keys);
}

export function extractEnvKeys(source) {
  return new Set([...source.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s/gm)].map(([, key]) => key));
}

export function findProblems(tags, flagKeys, envKeys) {
  const problems = [];

  for (const tag of tags) {
    const at = `${tag.file}:${tag.line}`;
    const usage = `<${tag.component} flag="..." />`;

    if (tag.error) {
      problems.push({
        at,
        message: `<${tag.component}> ${tag.error}`,
        fix: `write it as ${usage}`,
      });
      continue;
    }

    if (!tag.flag) {
      problems.push({
        at,
        message: `<${tag.component}> is missing flag`,
        fix: `add flag="<key in ${FEATURE_FLAG_MODULE}>" or flag="env:<NAME in ${ENV_MODULE}>"`,
      });
      continue;
    }

    if (tag.flag.startsWith("env:")) {
      const name = tag.flag.slice("env:".length);
      if (!envKeys.has(name)) {
        problems.push({
          at,
          message: `env var "${name}" isn't declared in ${ENV_MODULE}`,
          fix: "fix the name, or remove the callout if the env gate was removed",
        });
      }
      continue;
    }

    if (!flagKeys.has(tag.flag)) {
      problems.push({
        at,
        message: `flag "${tag.flag}" isn't in ${FEATURE_FLAG_MODULE}`,
        fix: "fix the key, or remove the callout if the flag was removed (the feature is generally available)",
      });
    }
  }

  return problems;
}

function main() {
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  const docsDir = join(root, "docs");

  const flagKeys = extractFeatureFlagKeys(readFileSync(join(root, FEATURE_FLAG_MODULE), "utf8"));
  const envKeys = extractEnvKeys(readFileSync(join(root, ENV_MODULE), "utf8"));
  if (flagKeys.size === 0 || envKeys.size === 0) {
    console.error(
      `Found ${flagKeys.size} feature flags and ${envKeys.size} env vars. The file format probably changed; update scripts/check-docs-feature-status.mjs.`
    );
    process.exit(1);
  }

  const files = readdirSync(docsDir, { recursive: true }).filter((file) => file.endsWith(".mdx"));
  const tags = files.flatMap((file) =>
    extractFeatureStatusTags(
      readFileSync(join(docsDir, file), "utf8"),
      relative(root, join(docsDir, file))
    )
  );

  const problems = findProblems(tags, flagKeys, envKeys);
  if (problems.length === 0) {
    console.log(`Checked ${tags.length} feature status callouts in ${files.length} docs pages.`);
    return;
  }

  for (const { at, message, fix } of problems) {
    console.error(`${at}  ${message}\n  fix: ${fix}`);
  }
  console.error(`\n${problems.length} feature status callout problem(s) found.`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
