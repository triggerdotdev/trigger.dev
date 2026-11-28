import type { SortedResult } from "fumadocs-core/search";
import index from "@/.generated/search-index.js";
import { navPages } from "./nav";
import { Searcher } from "./search-core";

// One ranking for the search dialog and the MCP search tool. The index is built at build time
// by scripts/build-search-index.mjs.
export const searcher = new Searcher(index);

// Each page's place in the nav (`Documentation`, `Deployment`), shown under its search rows.
const navPath = new Map(
  navPages().map(({ section, group, slug }) => [`/${slug}`, [section, group]])
);

/**
 * Search dialog rows, one line each: the page, then its best matching sections by heading.
 * Breadcrumbs are where the row sits in the nav (sections add the page title).
 */
export function searchResults(query: string, tag?: string): SortedResult[] {
  return searcher.search(query, { tag, limit: 10 }).flatMap(({ page, sections }) => {
    const path = navPath.get(page.url) ?? [];
    const headings = sections.filter((s) => s.id && s.heading && s.heading !== page.title);
    return [
      {
        id: page.url,
        url: page.url,
        type: "page" as const,
        content: page.title,
        breadcrumbs: path,
      },
      ...headings.slice(0, 2).map((s) => ({
        id: `${page.url}#${s.id}`,
        url: `${page.url}#${s.id}`,
        type: "heading" as const,
        content: s.heading!,
        breadcrumbs: [...path, page.title],
      })),
    ];
  });
}
