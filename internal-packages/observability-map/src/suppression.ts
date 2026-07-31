/**
 * The directive, and the reason that must follow it. The reason runs to the end of the line: `.`
 * does not match a newline, so a suppression on one line cannot pick up a reason from the next.
 * A trailing block-comment terminator is trimmed off so it does not end up inside the reason.
 *
 * It was `obs-map-disable-next-line`, which was a lie: a check applies to a whole entry point, so
 * the directive did too, and one on the last line of a file switched a check off for everything
 * above it. The honest options were to scope it to a line or to rename it, and scoping is not
 * available: a `CheckResult` carries no line number, and neither does an `EntryPoint`, so there is
 * nothing to match a line against. Scoping it would mean inventing a proximity rule that silently
 * drops legitimate suppressions. So the name now says what it does. Real line scoping needs
 * positions on the findings, which is scanner work.
 */
const PATTERN = /obs-map-disable\s+([a-z-]+)\s+--\s+(.+)/;

/**
 * The comment part of a line, or null if there is none.
 *
 * Line-scoped and comment-only, because the directive is a comment directive. Matching the raw
 * source meant a string literal that merely quotes the directive, in a test fixture or an error
 * message, silently switched a real check off. Handles line comments, block comments and the
 * leading star of a jsdoc block; a line-comment marker inside a string on the same line can still
 * be misread, which costs a suppression that was never written rather than hiding one that was.
 */
function commentPart(line: string): string | null {
  const slashes = line.indexOf("//");
  if (slashes !== -1) return line.slice(slashes + 2);

  const block = line.indexOf("/*");
  if (block !== -1) return line.slice(block + 2).replace(/\*\/\s*$/, "");

  const trimmed = line.trimStart();
  if (trimmed.startsWith("*")) return trimmed.slice(1);

  return null;
}

/** Check id to reason. A suppression without a reason, or outside a comment, is ignored. */
export function suppressedChecks(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of source.split("\n")) {
    const comment = commentPart(line);
    if (comment === null) continue;
    const match = PATTERN.exec(comment);
    if (!match) continue;
    const [, id, reason] = match;
    const trimmedReason = reason?.replace(/\*\/\s*$/, "").trim();
    if (id && trimmedReason && trimmedReason.length > 0) out.set(id, trimmedReason);
  }
  return out;
}
