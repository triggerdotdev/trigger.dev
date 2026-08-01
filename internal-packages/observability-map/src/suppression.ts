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
 * Every physical line of genuine comment content in the source, line comments and block comments
 * alike, one entry per line, with the `//`, `/*`, `*​/` and a jsdoc `*` prefix stripped.
 *
 * Read from the TypeScript scanner's own token stream rather than `indexOf("//")` against the raw
 * text. The old text-matching read the directive out of a string or template literal that merely
 * quoted it, so `"see // obs-map-disable auth-boundary -- nope"` granted a suppression nobody
 * wrote, silencing a real check. The scanner already knows the difference: a string or template
 * literal is one token, consumed in a single step, and never yields comment trivia for what is
 * inside it, so there is no substring rule left to fool.
 */
function commentLines(source: string): string[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    source
  );
  const lines: string[] = [];

  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia) {
      lines.push(scanner.getTokenText().slice(2));
      continue;
    }
    if (kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue;

    const text = scanner.getTokenText();
    const body = text.slice(2, text.length - 2); // drop the leading /* and the closing */
    for (const rawLine of body.split("\n")) {
      const trimmed = rawLine.trimStart();
      lines.push(trimmed.startsWith("*") ? trimmed.slice(1) : rawLine);
    }
  }

  return lines;
}

/** Check id to reason. A suppression without a reason, or outside a comment, is ignored. */
export function suppressedChecks(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of commentLines(source)) {
    const match = PATTERN.exec(line);
    if (!match) continue;
    const [, id, reason] = match;
    const trimmedReason = reason?.trim();
    if (id && trimmedReason && trimmedReason.length > 0) out.set(id, trimmedReason);
  }
  return out;
}
