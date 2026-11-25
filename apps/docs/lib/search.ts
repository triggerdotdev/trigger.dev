import type { SortedResult } from "fumadocs-core/search";
import index from "@/.generated/search-index.js";
import { excerpt, Searcher } from "./search-core";

// The index is built at build time by scripts/build-search-index.mjs.
const searcher = new Searcher(index);

/** Search dialog results: each page, then its best matching sections. */
export function searchResults(query: string, tag?: string): SortedResult[] {
  return searcher.search(query, { tag, limit: 10 }).flatMap(({ page, sections }) => [
    { id: page.url, url: page.url, type: "page" as const, content: page.title },
    ...sections.slice(0, 2).map((s, i) => ({
      id: `${page.url}-${i}`,
      url: s.id ? `${page.url}#${s.id}` : page.url,
      type: s.text ? ("text" as const) : ("heading" as const),
      content: s.text ? excerpt(s.text, query) : s.heading!,
      breadcrumbs: s.text && s.heading ? [s.heading] : undefined,
    })),
  ]);
}
