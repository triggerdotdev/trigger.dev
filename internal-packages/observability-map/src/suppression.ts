import ts from "@typescript/typescript6";
import { CHECKS } from "./checks/index.js";

const KNOWN_CHECK_IDS = new Set(CHECKS.map((c) => c.id));

/**
 * The directive, and the reason that must follow it. The reason runs to the end of the line: `.` does
 * not match a newline, so a suppression cannot pick up a reason from the next line. The old
 * `obs-map-disable-next-line` spelling and why it was renamed rather than scoped: README,
 * "Suppression".
 */
const PATTERN = /obs-map-disable\s+([a-z-]+)\s+--\s+(.+)/;

/**
 * Every leaf token in the parsed source, through `.getChildren()` rather than `ts.forEachChild`, which
 * silently skips a bare punctuation or keyword token. A comment can sit directly before one of those
 * with nothing else following it, on the last line inside a block.
 */
function leafTokens(node: ts.Node): ts.Node[] {
  const children = node.getChildren();
  return children.length === 0 ? [node] : children.flatMap(leafTokens);
}

/**
 * Node kinds whose text the parser has already claimed as content, so nothing inside their span can be
 * trivia however it is spelled. `jsx text is content, not a comment` is the four cases that fail
 * without `ts.isJsxText` here, and the positive control beside them, `still reads a directive from a
 * comment in a JSX expression container`, is what stops the filter being widened until it eats real
 * comments. The template and string kinds are covered by
 * `does not suppress from a directive inside a template literal` and
 * `ignores the directive inside a string literal`.
 *
 * The mutation corpus cannot cover any of this, because a suppression can only lower a score. See
 * INTERNALS.md, "Reading the directive out of the source".
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
 * Every comment range in the source, read off a real parsed `ts.SourceFile` rather than a standalone
 * `ts.createScanner`, and then filtered against the spans above. Both halves are needed, and the
 * filter is on the range's start offset rather than on the gap between a token's full start and its
 * start: INTERNALS.md, "Reading the directive out of the source". Both lexers are called at every
 * token
 * boundary, because which one returns a given comment depends on whether it shares a line with the
 * token before it.
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

/** One physical line of comment content per range, with comment delimiters and a jsdoc `*`
 * prefix stripped, so a multi-line block comment still matches the directive one line at a time. */
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

export type Suppressions = {
  /** Check id to reason, for ids that name a check in `CHECKS`. */
  byId: Map<string, string>;
  /** Ids that parsed as a directive but name no check, deduplicated. A typo (`eror-classification`)
   * used to land in the map, match nothing and appear nowhere, so the author read the finding as
   * acknowledged while the tool kept reporting it. */
  unknown: string[];
};

/**
 * Every suppression directive in the source, split by whether its id names a real check. A directive
 * without a reason, or outside a comment, is ignored either way.
 *
 * `fileName` picks the parser's script kind, because JSX is only distinguished from a generic type
 * argument list (`<T>(x) => x`) when the file is really a `.tsx`.
 */
export function parseSuppressions(source: string, fileName = "check.ts"): Suppressions {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind
  );

  const byId = new Map<string, string>();
  const unknown = new Set<string>();
  for (const line of commentLines(source, sf)) {
    const match = PATTERN.exec(line);
    if (!match) continue;
    const [, id, reason] = match;
    const trimmedReason = reason?.trim();
    if (!id || !trimmedReason || trimmedReason.length === 0) continue;
    if (KNOWN_CHECK_IDS.has(id)) byId.set(id, trimmedReason);
    else unknown.add(id);
  }
  return { byId, unknown: [...unknown] };
}

/** The known half of `parseSuppressions`, for callers that only apply suppressions. */
export function suppressedChecks(source: string, fileName = "check.ts"): Map<string, string> {
  return parseSuppressions(source, fileName).byId;
}
