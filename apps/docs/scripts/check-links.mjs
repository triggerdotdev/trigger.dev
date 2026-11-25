#!/usr/bin/env node
// Every internal link in trigger.dev/docs resolves: the page exists (or a docs.json redirect covers
// it, or it is a file under docs/) and its #anchor is a heading on that page. Replaces
// `mintlify broken-links`. Reads only the MDX source, so it needs no build.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  contentDirOf,
  headingIds,
  mdxFiles,
  readSnippets,
  stripFrontmatter,
} from "../lib/content-files.ts";
import { inlineSnippets, snippetImports } from "../lib/snippets.ts";

const contentDir = contentDirOf(path.resolve(import.meta.dirname, ".."));

const snippets = readSnippets(contentDir);
const pageFiles = mdxFiles(contentDir, true).filter((f) => !f.startsWith("snippets/"));

function read(f) {
  return readFileSync(path.join(contentDir, f), "utf8");
}

/** Lines outside fenced code, inline code removed (fence lines blank, so line numbers hold). */
function prose(src) {
  let fence;
  return src.split("\n").map((line) => {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (f && line.trim().startsWith(fence)) fence = undefined;
      return "";
    }
    if (f) {
      fence = f[1];
      return "";
    }
    return line.replace(/`[^`]*`/g, "");
  });
}

const slugOf = (f) => "/" + f.replace(/\.mdx$/, "").replace(/(^|\/)index$/, "");
const pages = new Map();
for (const f of pageFiles) {
  const raw = read(f);
  const body = inlineSnippets(stripFrontmatter(raw), snippetImports(raw), snippets);
  pages.set(slugOf(f).replace(/^\/$/, "/"), { file: f, raw, anchors: headingIds(body) });
}

const docsJson = JSON.parse(read("docs.json".replace(/\.mdx$/, "")));
const redirects = docsJson.redirects ?? [];
function redirectTarget(p) {
  for (const r of redirects) {
    const wild = /^(.*):slug\*$/.exec(r.source);
    if (wild ? p.startsWith(wild[1]) : r.source === p)
      return wild ? r.destination.replace(/:slug\*$/, "") + p.slice(wild[1].length) : r.destination;
  }
}

// Link targets in MDX: markdown links, and href/link props on JSX (Card, Button, etc.).
const LINK =
  /(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|\b(?:href|link)=["']([^"']+)["']/g;
const SITE = /^https?:\/\/(?:www\.)?trigger\.dev\/docs(?=\/|#|$)/;

// Images and videos with a root path must exist under docs/ (the build copies them to public/).
const ASSET = /!\[[^\]]*\]\(\s*<?(\/(?:[^()\s>]|\([^()]*\))+)|\bsrc=["'](\/[^"']+)/g;

// Snippets too: their links render on every page that imports them. A snippet has no slug of its
// own, so only its root-absolute links are checked.
const sources = [
  ...pages,
  ...Object.entries(snippets).map(([key, raw]) => [undefined, { file: key.slice(1), raw }]),
];

const broken = [];
let count = 0;
for (const [slug, page] of sources) {
  // Frontmatter blanked, not removed, so line numbers match the file.
  prose(page.raw.replace(/^---[\s\S]*?---/, (fm) => fm.replace(/[^\n]/g, ""))).forEach(
    (line, i) => {
      for (const m of line.matchAll(ASSET)) {
        count++;
        const src = m[1] ?? m[2];
        if (!existsSync(path.join(contentDir, decodeURIComponent(src.split(/[?#]/)[0]))))
          broken.push(`${page.file}:${i + 1}: ${src} (no such file)`);
      }
      for (const m of line.matchAll(LINK)) {
        let href = (m[1] ?? m[2]).trim();
        if (SITE.test(href)) href = href.replace(SITE, "") || "/";
        else if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) continue; // external, mailto:
        count++;
        const [pathPart, anchor] = href.split("#");
        let target = pathPart.split("?")[0].replace(/\/$/, "");
        if (slug === undefined && !target.startsWith("/")) continue;
        if (!target) target = slug;
        else if (!target.startsWith("/"))
          target = path.posix.join(path.posix.dirname(slug), target);
        const problem = resolve(target, anchor);
        if (problem) broken.push(`${page.file}:${i + 1}: ${href} (${problem})`);
      }
    }
  );
}

function resolve(target, anchor) {
  for (let hops = 0; hops < 5; hops++) {
    if (target === "") target = "/";
    if (target.startsWith("/docs/"))
      return "has a /docs prefix; links are relative to the docs root";
    const page = pages.get(target) ?? pages.get(target.replace(/\.md$/, ""));
    if (page) {
      if (anchor && !page.anchors.has(decodeURIComponent(anchor))) return `no heading #${anchor}`;
      return;
    }
    const next = redirectTarget(target);
    if (!next) break;
    target = next.replace(/\/$/, "");
  }
  // Files the site serves as is (images, the OpenAPI specs) and its generated routes.
  if (existsSync(path.join(contentDir, target)) && path.extname(target)) return;
  if (["/llms.txt", "/llms-full.txt", "/sitemap.xml", "/mcp"].includes(target)) return;
  return "no such page";
}

console.log(`links: ${count} internal links and assets in ${pages.size} pages`);
for (const b of broken) console.log(`BROKEN ${b}`);
console.log(broken.length ? `${broken.length} broken` : "links: all resolve");
process.exitCode = broken.length ? 1 : 0;
