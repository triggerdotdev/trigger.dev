// The MDX content in trigger.dev/docs, read from disk: by the app at build time and by the build and
// check scripts. Node built-ins and ./slug.ts only: scripts load this file with Node's type stripping.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { headingSlugger, headingText } from "./slug.ts";

/** trigger.dev/docs, relative to the docs app's directory. */
export const contentDirOf = (appDir: string) => path.resolve(appDir, "../../docs");

/** The content root for the app, which runs and builds in apps/docs. Scripts use contentDirOf with
 * their own location, since they may run from anywhere. Mintlify resolves `/snippets/x.mdx` from here. */
export const contentDir = contentDirOf(process.cwd());

/** `.mdx` files under `dir`, relative to it; `snippets/` folders only with `withSnippets`. */
export function mdxFiles(dir: string, withSnippets = false, rel = ""): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = path.posix.join(rel, e.name);
    if (e.isDirectory())
      return (e.name === "snippets" && !withSnippets) || e.name === "node_modules"
        ? []
        : mdxFiles(dir, withSnippets, r);
    return e.name.endsWith(".mdx") ? [r] : [];
  });
}

/** Every snippet's source, keyed the way pages import it (`/snippets/x.mdx`). */
export function readSnippets(contentDir: string): Record<string, string> {
  const dir = path.join(contentDir, "snippets");
  return Object.fromEntries(
    mdxFiles(dir, true).map((f) => [`/snippets/${f}`, readFileSync(path.join(dir, f), "utf8")])
  );
}

export const stripFrontmatter = (src: string) => src.replace(/^---[\s\S]*?---\s*/, "");

export type BodyLine = { line: string; code: boolean; heading?: { text: string; id: string } };

/**
 * The lines of an MDX body, fence lines left out: `code` inside fenced code, and outside it each
 * heading with the id the site renders for it (source.config.ts uses the same slug rule).
 */
export function* bodyLines(body: string): Generator<BodyLine> {
  const slug = headingSlugger();
  let fence: string | undefined;
  for (const line of body.split("\n")) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (f && line.trim().startsWith(fence)) fence = undefined;
      else yield { line, code: true };
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    yield h
      ? { line, code: false, heading: { text: h[1]!, id: slug(headingText(h[1]!)) } }
      : { line, code: false };
  }
}

/** The heading ids on a page body. */
export function headingIds(body: string): Set<string> {
  const ids = new Set<string>();
  for (const { heading } of bodyLines(body)) if (heading) ids.add(heading.id);
  return ids;
}
