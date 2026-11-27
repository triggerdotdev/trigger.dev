import { Fragment } from "react";
import { highlightRanges } from "@/lib/search-core";

/** `text` with the query's words marked (lib/search-core.ts `highlightRanges`). */
export function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query);
  const out = [];
  let at = 0;
  for (const [start, end] of ranges) {
    out.push(text.slice(at, start), <mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  out.push(text.slice(at));
  // data-highlight-ignore: fumadocs' own highlighter (every query letter) skips this subtree.
  return (
    <span data-highlight-ignore className="search-hits">
      {out.map((part, i) =>
        typeof part === "string" ? <Fragment key={`t${i}`}>{part}</Fragment> : part
      )}
    </span>
  );
}
