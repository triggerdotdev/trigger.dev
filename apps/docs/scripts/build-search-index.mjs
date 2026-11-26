#!/usr/bin/env node
// Builds the search index from the MDX in trigger.dev/docs into .generated/search-index.js, and
// .generated/snippets.js (snippet sources and each page's snippet imports) for lib/source.ts, so
// nothing reads trigger.dev/docs at request time. Runs before `next build` and `next dev`.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FIELDS, termFrequencies } from "../lib/search-core.ts";
import { inlineSnippets, snippetImports } from "../lib/snippets.ts";
import { tokenCss } from "../lib/shiki-themes.ts";
import { choiceCss } from "../lib/choices.ts";
import { generateSdkTypes } from "../lib/sdk-type-gen.ts";
import {
  bodyLines,
  contentDirOf,
  mdxFiles,
  readSnippets,
  stripFrontmatter,
} from "../lib/content-files.ts";

// A production build without these still builds and passes every check, then quietly ships
// without Ask AI, its limits, analytics or personalization. Previews and local builds may skip them.
const PRODUCTION_ENV = [
  "ANTHROPIC_API_KEY",
  "REDIS_URL",
  "DOCS_WORKER_SECRET",
  "NEXT_PUBLIC_POSTHOG_KEY",
  "NEXT_PUBLIC_DOCS_PERSONALIZATION",
];
if (process.env.VERCEL_ENV === "production") {
  const missing = PRODUCTION_ENV.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`Production build stopped: ${missing.join(", ")} not set.`);
    process.exit(1);
  }
}

const appDir = path.resolve(import.meta.dirname, "..");
const contentDir = contentDirOf(appDir);
const outFile = path.join(appDir, ".generated/search-index.js");

// Frontmatter in these docs is flat `key: value` lines.
function frontmatter(src) {
  const m = /^---\n([\s\S]*?)\n---/.exec(src);
  const data = {};
  for (const line of m?.[1].split("\n") ?? []) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"');
    data[kv[1]] = v === "true" ? true : v === "false" ? false : v;
  }
  return data;
}

// docs.json: which section (dropdown) each page is in, and which pages the sidebar shows.
const docsJson = JSON.parse(readFileSync(path.join(contentDir, "docs.json"), "utf8"));
const sectionOf = new Map();
const navSlugs = new Set();
function walk(list, section, hidden) {
  for (const e of list) {
    if (typeof e === "string") {
      sectionOf.set(e, section);
      if (!hidden) navSlugs.add(e);
    } else walk(e.pages, section, hidden || e.hidden);
  }
}
for (const d of docsJson.navigation.dropdowns)
  for (const g of d.groups) walk(g.pages, d.dropdown, g.hidden);

// JSX attributes whose values are words a reader sees (card and tab titles, parameter names).
const SHOWN_ATTRS = /\b(?:title|path|query|body|header|name|label)="([^"]*)"/g;

/** MDX to plain text: JSX tags dropped (shown attribute values kept), markdown syntax removed. */
function plain(text) {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<\/?[A-Za-z][\w.]*(?:\s(?:[^<>{}]|\{[^{}]*\})*)?\/?>/g, (tag) =>
      [...tag.matchAll(SHOWN_ATTRS)].map((m) => ` ${m[1]}. `).join("")
    )
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\|/g, " ")
    .replace(/^\s*:?-{3,}:?(?:\s+:?-{3,}:?)*\s*$/gm, "")
    .replace(/[*_`]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split the page body into sections by heading; code goes to its own field. */
function parse(body) {
  const sections = [{ text: "" }];
  const headings = [];
  const code = [];
  // `<Visibility for="agents">` isn't on the page, so search mustn't link into it. bodyLines still
  // sees its headings, so the page's other heading ids stay as rendered.
  let agentsOnly = false;
  for (const { line, code: inCode, heading } of bodyLines(body)) {
    if (!inCode && /<Visibility\s+for="agents"\s*>/.test(line)) agentsOnly = true;
    if (agentsOnly) {
      if (!inCode && line.includes("</Visibility>")) agentsOnly = false;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (/^(import|export)\s/.test(line)) continue;
    if (heading) {
      const text = plain(heading.text);
      headings.push(text);
      sections.push({ id: heading.id, heading: text, text: "" });
    } else sections[sections.length - 1].text += line + "\n";
  }
  for (const s of sections) s.text = plain(s.text);
  return { sections: sections.filter((s) => s.text || s.heading), headings, code: code.join("\n") };
}

const snippets = readSnippets(contentDir);
const pageImports = {};

const pages = [];
for (const file of mdxFiles(contentDir)) {
  const raw = readFileSync(path.join(contentDir, file), "utf8");
  const fm = frontmatter(raw);
  if (!fm.title || fm.url) continue; // url: pages redirect elsewhere
  const slug = file.replace(/\.mdx$/, "").replace(/(^|\/)index$/, "");
  const imports = snippetImports(raw);
  if (imports) pageImports[file] = imports;
  const body = inlineSnippets(stripFrontmatter(raw), imports, snippets);
  const { sections, headings, code } = parse(body);
  const fields = {
    title: [fm.title, fm.sidebarTitle].filter(Boolean).join(" "),
    slug: slug.replace(/[/_-]/g, " "),
    headings: headings.join("\n"),
    description: fm.description ?? "",
    body: [fm.openapi ?? "", ...sections.map((s) => s.text)].join("\n"),
    code,
  };
  const tf = {};
  const len = {};
  for (const f of FIELDS) [tf[f], len[f]] = termFrequencies(fields[f]);
  pages.push({
    url: `/${slug}`,
    title: fm.title,
    description: fm.description || undefined,
    tag: sectionOf.get(slug),
    inNav: navSlugs.has(slug) && !fm.hidden,
    kind: fm.openapi
      ? "api"
      : /^guides\/(example-projects|examples)\//.test(slug)
        ? "example"
        : undefined,
    tf,
    len,
    sections,
  });
}

const avgLen = Object.fromEntries(
  FIELDS.map((f) => [f, pages.reduce((n, p) => n + p.len[f], 0) / pages.length])
);
mkdirSync(path.dirname(outFile), { recursive: true });
// JSON.parse of a string literal loads faster than an object literal, and keeps TypeScript off a 3 MB file.
writeFileSync(
  outFile,
  `export default JSON.parse(${JSON.stringify(JSON.stringify({ pages, avgLen }))});\n`
);
writeFileSync(
  outFile.replace(/\.js$/, ".d.ts"),
  `declare const index: import("../lib/search-core").SearchIndex;\nexport default index;\n`
);
const snippetsFile = path.join(appDir, ".generated/snippets.js");
writeFileSync(
  snippetsFile,
  `export const snippets = JSON.parse(${JSON.stringify(JSON.stringify(snippets))});\n` +
    `export const pageImports = JSON.parse(${JSON.stringify(JSON.stringify(pageImports))});\n`
);
writeFileSync(
  snippetsFile.replace(/\.js$/, ".d.ts"),
  `export declare const snippets: Record<string, string>;\nexport declare const pageImports: Record<string, string>;\n`
);
// Classes for highlighted code tokens (lib/shiki-themes.ts), imported by app/global.css.
writeFileSync(path.join(appDir, ".generated/shiki-tokens.css"), `${tokenCss}\n`);
// Shows the reader's package manager / framework tab before hydration (lib/choices.ts).
writeFileSync(path.join(appDir, ".generated/choices.css"), `${choiceCss}\n`);
// Images and videos under docs/ are served at the same paths (/docs/images/x.png,
// /docs/deployment/x.png). Copied, not symlinked: deployment output doesn't follow symlinks.
const publicDir = path.join(appDir, "public");
rmSync(publicDir, { recursive: true, force: true });
const assets = readdirSync(contentDir, { recursive: true }).filter(
  (f) =>
    /\.(png|jpe?g|gif|svg|webp|avif|ico|mp4|webm)$/i.test(f) &&
    !f.split(path.sep).includes("node_modules")
);
for (const f of assets) cpSync(path.join(contentDir, f), path.join(publicDir, f));
console.log(`assets: ${assets.length} files -> public/`);
// The brand kit's logos (https://trigger.dev/brand) belong to the app, not the content.
cpSync(path.join(appDir, "brand"), path.join(publicDir, "brand"), { recursive: true });

// Each page's last commit date, for the sitemap's <lastmod> and the JSON-LD dateModified.
// Left empty on a shallow clone or without git, where the dates would be wrong.
const lastmod = {};
try {
  const git = (...args) =>
    execFileSync("git", args, { cwd: contentDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (git("rev-parse", "--is-shallow-repository").trim() === "false") {
    let date;
    for (const line of git(
      "log",
      "--no-renames",
      "--format=%x00%cI",
      "--name-only",
      "--relative",
      "--",
      "."
    ).split("\n")) {
      if (line.startsWith("\0")) date = line.slice(1);
      else if (line.endsWith(".mdx") && date && !(line in lastmod)) lastmod[line] = date;
    }
  }
} catch (err) {
  console.warn(`lastmod: no git history (${err.message.split("\n")[0]})`);
}
// <SdkType> tables (lib/sdk-type-table.ts), generated here so neither pages nor the Ask AI
// route run TypeScript.
const sdkTypes = await generateSdkTypes(appDir);
const sdkTypesFile = path.join(appDir, ".generated/sdk-types.js");
writeFileSync(
  sdkTypesFile,
  `export const sdkTypes = JSON.parse(${JSON.stringify(JSON.stringify(sdkTypes))});\n`
);
writeFileSync(
  sdkTypesFile.replace(/\.js$/, ".d.ts"),
  'export declare const sdkTypes: Record<string, import("../lib/sdk-type-table").SdkTypeRow[]>;\n'
);
console.log(`sdk types: ${Object.keys(sdkTypes).join(", ")}`);

const lastmodFile = path.join(appDir, ".generated/lastmod.js");
writeFileSync(
  lastmodFile,
  `export const lastmod = JSON.parse(${JSON.stringify(JSON.stringify(lastmod))});\n`
);
writeFileSync(
  lastmodFile.replace(/\.js$/, ".d.ts"),
  "export declare const lastmod: Record<string, string>;\n"
);
console.log(`lastmod: ${Object.keys(lastmod).length} pages`);
console.log(`search index: ${pages.length} pages -> ${path.relative(appDir, outFile)}`);
