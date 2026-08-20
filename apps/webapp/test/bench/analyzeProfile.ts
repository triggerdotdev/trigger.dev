#!/usr/bin/env tsx
/**
 * Ranks where a `.cpuprofile` spent its cycles.
 *
 *   pnpm --filter webapp exec tsx test/bench/analyzeProfile.ts <profile> [--top 40] [--json out.json]
 *
 * `--root` overrides the repo root used to make source paths relative and to
 * find the build's source maps; it defaults to the repo containing this file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeProfile, formatAnalysis, type CpuProfile } from "./lib/profileAnalysis";

function parseArgs(argv: string[]): {
  profilePath?: string;
  top: number;
  json?: string;
  root: string;
} {
  const here = typeof __dirname === "string" ? __dirname : import.meta.dirname;

  const defaults = {
    top: 30,
    root: resolve(here, "..", "..", "..", ".."),
  };

  let profilePath: string | undefined;
  let top = defaults.top;
  let json: string | undefined;
  let root = defaults.root;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--top") top = Number(argv[++i]);
    else if (arg === "--json") json = argv[++i];
    else if (arg === "--root") root = resolve(argv[++i]!);
    else if (!arg.startsWith("--")) profilePath = arg;
  }

  return { profilePath, top, json, root };
}

const { profilePath, top, json, root } = parseArgs(process.argv.slice(2));

if (!profilePath) {
  console.error("usage: analyzeProfile.ts <path-to-.cpuprofile> [--top N] [--json out.json]");
  process.exit(1);
}

const profile = JSON.parse(readFileSync(profilePath, "utf8")) as CpuProfile;
const analysis = analyzeProfile(profile, root);

console.log(`\n=== ${profilePath} ===`);
console.log(formatAnalysis(analysis, top));

if (json) {
  writeFileSync(json, JSON.stringify(analysis, null, 2));
  console.log(`\nwrote ${json}`);
}
