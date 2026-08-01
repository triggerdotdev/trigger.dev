import ts from "typescript";

/**
 * The directive, and the reason that must follow it. The reason runs to the end of the line: `.`
 * does not match a newline, so a suppression on one line cannot pick up a reason from the next.
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
 * Every leaf token in the parsed source: keeps descending through `.getChildren()` rather than
 * `ts.forEachChild`, which only returns the child nodes a statement or expression models as its
 * own properties and silently skips a bare punctuation or keyword token (a closing brace, a
 * semicolon). A comment can sit directly before one of those with nothing else following it, the
 * last line inside a block, and `.getChildren()` still reaches it because the token itself is
 * still a node with a position.
 */
function leafTokens(node: ts.Node): ts.Node[] {
  const children = node.getChildren();
  return children.length === 0 ? [node] : children.flatMap(leafTokens);
}

/**
 * Every genuine comment range in the source, read off a real parsed `ts.SourceFile` rather than a
 * standalone `ts.createScanner`. A bare scanner has no parser state behind it, and that is exactly
 * what let two shapes through:
 *
 * - a template literal WITH a substitution never gets rescanned as a template continuation by a
 *   scanner running on its own, so the text after `${x}` reads as ordinary code and a `//` in it is
 *   a real comment to the scanner, though it never leaves the template literal to the parser.
 * - JSX text has no comment syntax at all, but a scanner created in `LanguageVariant.Standard`
 *   does not know it is looking at JSX text, so a `//` inside `<p>see https://x</p>` reads as a
 *   line comment starting mid-URL.
 *
 * The actual parser closes both: a template's literal segments and a JSX text node are real nodes
 * with their own span here, never trivia, so a directive inside either is content the parser
 * already claimed, not a comment. `getLeadingCommentRanges` and `getTrailingCommentRanges` are both
 * needed at every token boundary, because which one returns a given comment depends on whether it
 * shares a line with the token before it (trailing) or comes after a line break (leading), not on
 * which directive it happens to be.
 */
function commentRanges(source: string, sf: ts.SourceFile): ts.CommentRange[] {
  const seen = new Set<number>();
  const ranges: ts.CommentRange[] = [];
  const add = (found: ts.CommentRange[] | undefined) => {
    for (const range of found ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      ranges.push(range);
    }
  };
  for (const token of leafTokens(sf)) {
    add(ts.getLeadingCommentRanges(source, token.getFullStart()));
    add(ts.getTrailingCommentRanges(source, token.getEnd()));
  }
  return ranges;
}

/** One physical line of comment content per range, the `//`, `/*`, `*​/` and a jsdoc `*` prefix
 * stripped, so a multi-line block comment still matches the directive one line at a time. */
function commentLines(source: string, sf: ts.SourceFile): string[] {
  const lines: string[] = [];
  for (const range of commentRanges(source, sf)) {
    const text = source.slice(range.pos, range.end);
    if (range.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
      lines.push(text.slice(2));
      continue;
    }
    const body = text.slice(2, text.length - 2); // drop the leading /* and the closing */
    for (const rawLine of body.split("\n")) {
      const trimmed = rawLine.trimStart();
      lines.push(trimmed.startsWith("*") ? trimmed.slice(1) : rawLine);
    }
  }
  return lines;
}

/**
 * Check id to reason. A suppression without a reason, or outside a comment, is ignored.
 *
 * `fileName` picks the parser's script kind: JSX syntax is only legal, and only correctly
 * distinguished from a generic type argument list (`<T>(x) => x`), when the file is really a
 * `.tsx`. Defaults to a plain `.ts` for callers that only have source text.
 */
export function suppressedChecks(source: string, fileName = "check.ts"): Map<string, string> {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind
  );

  const out = new Map<string, string>();
  for (const line of commentLines(source, sf)) {
    const match = PATTERN.exec(line);
    if (!match) continue;
    const [, id, reason] = match;
    const trimmedReason = reason?.trim();
    if (id && trimmedReason && trimmedReason.length > 0) out.set(id, trimmedReason);
  }
  return out;
}
