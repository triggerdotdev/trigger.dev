#!/usr/bin/env node
// `pnpm --filter docs-site check:figures`: the dashboard figures (lib/dashboard-figures.ts).
//   1. Every <DashboardFigure> tag in docs/ names a figure and only that figure's marks. Fails.
//   2. Staleness: each figure stamps the webapp files it mirrors (git blob ids, in
//      lib/dashboard-figures.stamps.json). A changed, missing or unstamped file is reported as a
//      warning (a GitHub annotation in CI), never a failure: the figure may still be right.
// `--stamp [name ...]`: record the current files for these figures (all when none are named), after
// checking the drawing against the dashboard. Needs no install: plain Node.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  figureTags,
  dashboardFigures,
  figureStyleSources,
  getDashboardFigure,
  parseHighlight,
} from "../lib/dashboard-figures.ts";

const app = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(app, "../..");
const docs = path.join(repo, "docs");
const stampsFile = path.join(app, "lib/dashboard-figures.stamps.json");
const STYLE = "dashboard-figures.css";
const ci = !!process.env.GITHUB_ACTIONS;

/** Git's blob id for a file: the same id `git hash-object` prints, without needing git. */
function blobId(file) {
  const body = readFileSync(path.join(repo, file));
  return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}

const sourcesOf = (name) => (name === STYLE ? figureStyleSources : dashboardFigures[name].sources);
const stamped = [...Object.keys(dashboardFigures), STYLE];
const stamps = existsSync(stampsFile) ? JSON.parse(readFileSync(stampsFile, "utf8")) : {};

const stampIndex = process.argv.indexOf("--stamp");
if (stampIndex !== -1) {
  const names = process.argv.slice(stampIndex + 1);
  for (const name of names) {
    if (!stamped.includes(name))
      throw new Error(`no figure "${name}" (figures: ${stamped.join(", ")})`);
  }
  for (const name of names.length ? names : stamped) {
    stamps[name] = Object.fromEntries(sourcesOf(name).map((f) => [f, blobId(f)]));
    console.log(`stamped ${name} (${sourcesOf(name).length} files)`);
  }
  const ordered = Object.fromEntries(stamped.filter((n) => stamps[n]).map((n) => [n, stamps[n]]));
  writeFileSync(stampsFile, `${JSON.stringify(ordered, null, 2)}\n`);
  process.exit(0);
}

// 1. Tags in the docs.
const errors = [];
const pagesUsing = new Map();
for (const rel of readdirSync(docs, { recursive: true })) {
  if (!rel.endsWith(".mdx")) continue;
  const text = readFileSync(path.join(docs, rel), "utf8");
  for (const { index, attrs } of figureTags(text)) {
    const { name = "", highlight } = attrs;
    const where = `docs/${rel}:${text.slice(0, index).split("\n").length}`;
    if (!getDashboardFigure(name)) {
      errors.push(`${where}: no figure named "${name}"`);
      continue;
    }
    try {
      parseHighlight(name, highlight);
    } catch (e) {
      errors.push(`${where}: ${e.message}`);
    }
    pagesUsing.set(name, [...(pagesUsing.get(name) ?? []), `docs/${rel}`]);
  }
}
for (const e of errors) console.error(ci ? `::error::${e}` : `error: ${e}`);

// 2. Staleness.
const stale = [];
for (const name of stamped) {
  const changes = sourcesOf(name).flatMap((f) => {
    if (!existsSync(path.join(repo, f))) return [`${f} (missing: moved or deleted)`];
    if (!stamps[name]?.[f]) return [`${f} (not stamped)`];
    return stamps[name][f] === blobId(f) ? [] : [f];
  });
  if (changes.length) stale.push({ name, changes });
}
for (const { name, changes } of stale) {
  const pages =
    name === STYLE ? "every figure" : (pagesUsing.get(name) ?? ["no page yet"]).join(", ");
  const text = `dashboard figure "${name}" may be stale (used on ${pages}). Changed since its stamp: ${changes.join(", ")}`;
  console.log(ci ? `::warning title=Dashboard figure may be stale::${text}` : `warning: ${text}`);
}
if (stale.length) {
  console.log(
    "Compare each figure with the dashboard, update it if it differs, then re-stamp:\n" +
      "  pnpm --filter docs-site check:figures --stamp <name>\n" +
      "How: .claude/skills/docs-dashboard-figures/SKILL.md (Refresh a stale figure)."
  );
}
console.log(
  `check:figures: ${errors.length} tag error(s), ${stale.length} to review (of ${stamped.length - 1} figure(s) and the token layer)`
);
process.exit(errors.length ? 1 : 0);
