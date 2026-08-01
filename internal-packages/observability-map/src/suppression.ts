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
 * Node kinds whose text the parser has already claimed as content, so nothing inside their span can
 * be trivia however it is spelled. `getLeadingCommentRanges` and `getTrailingCommentRanges` are raw
 * lexers over source text from an offset and consult no parse tree at all, so at a leaf-token
 * boundary they will happily lex the inside of one of these as a comment: a JSX text node that
 * BEGINS with `//` or `/*` is the shape that reached the real tree, in
 * `resources.branches.create.tsx`'s `<InlineCode>//</InlineCode>`.
 *
 * The four cases in `jsx text is content, not a comment` (`test/suppression.test.ts`) are the ones
 * that fail without `ts.isJsxText` here; the positive control beside them, `still reads a directive
 * from a comment in a JSX expression container`, is what stops the filter being widened until it
 * eats real comments. `does not suppress from a directive inside a template literal` and the two
 * substitution cases cover the template kinds, and `ignores the directive inside a string literal`
 * covers the string kind.
 *
 * The mutation corpus does NOT cover any of this, and cannot: a suppression can only lower an
 * entry's score, because `scoreEntry` caps it at the pre-suppression ratio. Suppression bugs are
 * invisible to a harness that watches for the score rising, so they need ordinary unit tests.
 */
function isClaimedContent(node: ts.Node): boolean {
  return (
    ts.isJsxText(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
    ts.isRegularExpressionLiteral(node)
  );
}

/**
 * Every comment range in the source, read off a real parsed `ts.SourceFile` rather than a
 * standalone `ts.createScanner`, and then filtered against the spans above.
 *
 * Both halves are needed. Parsing rather than scanning is what stops a template literal WITH a
 * substitution being rescanned as ordinary code after `${x}`, and what makes JSX text a node at all.
 * Filtering by span is what stops the two comment-range lexers reading the start of such a node as
 * a comment anyway, which they do because they never see the tree the parser built.
 *
 * The filter is on the range's start offset falling inside a claimed span, not on the gap between a
 * token's full start and its start. A gap filter was tried and rejected: it loses a same-line
 * trailing comment and a comment inside a JSX expression container, both of which are real.
 *
 * Both lexers are called at every token boundary, because which one returns a given comment depends
 * on whether it shares a line with the token before it (trailing) or comes after a line break
 * (leading), not on which directive it happens to be.
 */
function commentRanges(source: string, sf: ts.SourceFile): ts.CommentRange[] {
  const claimed: ts.TextRange[] = [];
  const collectClaimed = (node: ts.Node) => {
    if (isClaimedContent(node)) claimed.push({ pos: node.getStart(sf), end: node.end });
    ts.forEachChild(node, collectClaimed);
  };
  collectClaimed(sf);
  const inClaimedSpan = (pos: number) => claimed.some((s) => pos >= s.pos && pos < s.end);

  const seen = new Set<number>();
  const ranges: ts.CommentRange[] = [];
  const add = (found: ts.CommentRange[] | undefined) => {
    for (const range of found ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      if (inClaimedSpan(range.pos)) continue;
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
