// No imports: scripts/check-links.mjs loads this file with Node's type stripping.

/**
 * Heading ids exactly as the previous docs site made them, so existing #anchor links keep working:
 * straight apostrophes curled (the old site typeset them), lowercase, punctuation dropped except
 * / — – + & ’ @ _, dots and whitespace become hyphens.
 * "chat.agent()" -> "chat-agent", "Path A — x" -> "path-a-—-x". Matches all 367 headings sampled
 * from the live site.
 */
export function headingSlug(text: string): string {
  return text
    .replace(/'/g, "’")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s\-/—–+&’@._]/gu, "")
    .replace(/\./g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

/** Slugs for one page: a repeated heading gets -2, -3, ... like the previous site. */
export function headingSlugger() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = headingSlug(text);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
}

/** A markdown heading's visible text: tags dropped, links reduced to their text, emphasis and code marks removed. */
export function headingText(markdown: string): string {
  return markdown
    .replace(/\s+#+\s*$/, "")
    .replace(/<[^>]+>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]|\b_+|_+\b(?!\w)/g, "")
    .trim();
}

type Redirect = { source: string; destination: string };

/** Where docs.json's redirects send a page path (`/queue-concurrency` -> `/concurrency`), following
 * up to three hops; undefined when no internal rule matches. */
export function redirectTarget(pathname: string, redirects: Redirect[]): string | undefined {
  let path = pathname;
  for (let hop = 0; hop < 3; hop++) {
    let next: string | undefined;
    for (const r of redirects) {
      if (!r.destination.startsWith("/")) continue;
      const wild = /^(.*\/):slug\*$/.exec(r.source);
      if (wild && path.startsWith(wild[1]))
        next = r.destination.replace(":slug*", path.slice(wild[1].length));
      else if (r.source === path) next = r.destination;
      if (next) break;
    }
    if (!next) break;
    path = next;
  }
  return path === pathname ? undefined : path;
}
