"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { FileText, Search } from "lucide-react";
import type { SortedResult } from "fumadocs-core/search";
import { Highlighted } from "./search-highlight";
import { basePath } from "@/lib/base-path";
import { track } from "@/lib/analytics";

// "/v3/tasks-overview" -> "tasks overview": the path's words, minus the version prefixes old URLs carry.
const pathWords = (path: string) =>
  path
    .split(/[/\-_.#?=&]+/)
    .filter((w) => w && !/^(docs|v\d+|md|mdx|html)$/i.test(w))
    .join(" ");

export function NotFoundSearch() {
  // In the dashboard's panel the URL is /embed/<page>; the reader asked for /<page>.
  const pathname = usePathname().replace(/^\/embed(?=\/)/, "");
  const [query, setQuery] = useState(() => pathWords(pathname));
  const [results, setResults] = useState<SortedResult[]>();

  // The page view alone doesn't say it was a 404; this does, with where the broken link was.
  useEffect(() => {
    let referrer: string | undefined;
    try {
      const r = new URL(document.referrer);
      referrer = r.origin + r.pathname;
    } catch {}
    track("docs_not_found", { path: pathname, referrer });
  }, [pathname]);

  useEffect(() => {
    const q = query.trim();
    if (!q) return setResults([]);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`${basePath}/api/search?query=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => r.json() as Promise<SortedResult[]>)
        .then((rows) => setResults(rows.filter((r) => r.type === "page").slice(0, 5)))
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  return (
    <div className="not-prose">
      <p className="text-fd-muted-foreground">
        Nothing is published at{" "}
        <code className="rounded bg-fd-muted px-1.5 py-0.5 font-mono text-sm text-fd-foreground">
          /docs{pathname}
        </code>
        . It may have moved. These pages look closest:
      </p>
      <label className="mt-5 flex items-center gap-2 rounded-lg border bg-fd-card px-3 py-2 focus-within:ring-2 focus-within:ring-fd-ring">
        <Search className="size-4 text-fd-muted-foreground" />
        <span className="sr-only">Search the docs</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-fd-muted-foreground"
          placeholder="Search the docs"
        />
      </label>
      <ul className="mt-3 flex flex-col">
        {results?.map((r) => (
          <li key={r.id}>
            <a
              href={`${basePath}${r.url}`}
              className="flex items-center gap-3 rounded-md px-3 py-2.5 hover:bg-fd-accent"
            >
              <FileText className="size-4 shrink-0 text-fd-muted-foreground" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  <Highlighted text={r.content} query={query} />
                </span>
                <span className="block truncate font-mono text-xs text-fd-muted-foreground">
                  /docs{r.url}
                </span>
              </span>
            </a>
          </li>
        ))}
        {results?.length === 0 && (
          <li className="px-3 py-2.5 text-sm text-fd-muted-foreground">No matching pages.</li>
        )}
      </ul>
    </div>
  );
}
