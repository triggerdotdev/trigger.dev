// Scripts load this file with Node's type stripping: import only files that do the same, by .ts path.
import { stripFrontmatter } from "./content-files.ts";

const SNIPPET_IMPORT = /^import\s+(\w+)\s+from\s+["'](\/snippets\/[^"']+\.mdx)["'];?[ \t]*$/gm;

/** The snippet import lines of an MDX source (empty when it imports none). */
export function snippetImports(source: string): string {
  return source.match(SNIPPET_IMPORT)?.join("\n") ?? "";
}

/**
 * Replace `<Snippet prop="x" />` with the snippet's markdown, the way Mintlify's .md output does.
 * `source` holds the page's import lines; `snippets` maps "/snippets/x.mdx" to its source.
 */
export function inlineSnippets(
  markdown: string,
  source: string,
  snippets: Record<string, string>,
  depth = 0
): string {
  const imports = new Map([...source.matchAll(SNIPPET_IMPORT)].map((m) => [m[1]!, m[2]!]));
  if (!imports.size || depth > 3) return markdown;
  return markdown.replace(
    /<([A-Z]\w*)((?:\s+\w+=(?:"[^"]*"|\{[^}]*\}))*)\s*\/>/g,
    (all, name: string, attrs: string) => {
      const src = snippets[imports.get(name) ?? ""];
      if (src === undefined) return all;
      const props = Object.fromEntries(
        // `packages="x"` or `packages={"x"}`
        [...attrs.matchAll(/(\w+)=(?:"([^"]*)"|\{"([^"]*)"\})/g)].map((m) => [m[1]!, m[2] ?? m[3]!])
      );
      const body = stripFrontmatter(src)
        .replace(SNIPPET_IMPORT, "")
        .replace(/\{(\w+)\}/g, (m, k: string) => props[k] ?? m)
        .trim();
      return inlineSnippets(body, src, snippets, depth + 1);
    }
  );
}
