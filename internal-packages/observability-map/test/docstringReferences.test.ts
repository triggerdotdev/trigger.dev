import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CHECKS } from "../src/checks/index.js";
import { MUTATIONS } from "./mutations.js";

/**
 * Every test name a docstring in `src/` claims to be covered by must exist.
 *
 * The rule this enforces has been asked for six times in prose and broken six times, most recently
 * by a docstring naming `content-is-not-a-comment`, a test that was never written. Prose cannot
 * enforce itself, so this does.
 *
 * What is checked, precisely, because a checker that overstates its reach is the same defect again:
 *
 * - every backticked kebab-case token in a `src/` comment, e.g. `empty-instanceof-if`. Those are
 *   never valid JavaScript identifiers, so in this package they are always a check id, a mutation
 *   corpus id, a test name, or one of the handful of domain words in `NOT_A_TEST_NAME` below.
 * - a backticked glob, `dead-*`, which must match at least one corpus id by prefix.
 * - every backticked prose phrase of `MINIMUM_TITLE_WORDS` words or more that contains no code
 *   punctuation, e.g. `jsx text is content, not a comment`. That is what a test title looks like
 *   and what a code sample does not.
 *
 * What is NOT checked: a reference written without backticks, a test title of fewer than
 * `MINIMUM_TITLE_WORDS` words (`throw e` and `new URL` are code, and telling a short title from
 * short code needs more than punctuation), and anything outside `src/`. A docstring can still name
 * a nonexistent short test. The kebab half is the half that has actually failed.
 */

const SRC = resolve(__dirname, "../src");
const TESTS = resolve(__dirname);

/** Kebab-case tokens that are domain vocabulary rather than a test or corpus name. Anything added
 * here is a deliberate statement that the token names no test, and shows up in review as such. */
const NOT_A_TEST_NAME = new Set([
  // A `CheckStatus` value.
  "not-applicable",
  // The directive spelling that was retired, named in `suppression.ts` to say it is not honoured.
  "obs-map-disable-next-line",
]);

/** A backticked phrase this long or longer, with no code punctuation, is read as a test title. */
const MINIMUM_TITLE_WORDS = 5;

/** Characters that mean a backticked phrase is a code sample rather than a test title. */
const CODE_PUNCTUATION = /[{}()[\];=<>"'`|&$/\\]|\.\.\.|\.tsx?\b/;

function walkFiles(dir: string, suffix: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, suffix, out);
    else if (entry.name.endsWith(suffix)) out.push(path);
  }
  return out;
}

/** Comment text with jsdoc line prefixes removed, so a backticked phrase that wrapped across two
 * lines reads as one phrase rather than one with a stray asterisk in it. */
function commentText(file: string): string {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const seen = new Set<number>();
  const parts: string[] = [];
  const visit = (node: ts.Node) => {
    for (const range of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      parts.push(source.slice(range.pos, range.end));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return parts.join("\n").replace(/\n\s*\*\s?/g, " ");
}

/** Static titles from every `it`/`test`/`describe` call, including the literal chunks of a
 * template-literal title, so a reference to part of a generated name still resolves. */
function testTitles(): Set<string> {
  const titles = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed.length > 0) titles.add(trimmed);
  };
  for (const file of walkFiles(TESTS, ".test.ts")) {
    const source = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const root = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
        if (ts.isIdentifier(root) && ["it", "test", "describe"].includes(root.text)) {
          const first = node.arguments[0];
          if (first) {
            if (ts.isStringLiteralLike(first)) add(first.text);
            if (ts.isTemplateExpression(first)) {
              add(first.head.text);
              for (const span of first.templateSpans) add(span.literal.text);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return titles;
}

describe("docstrings in src name things that exist", () => {
  const known = new Set<string>([
    ...CHECKS.map((c) => c.id),
    ...MUTATIONS.map((m) => m.id),
    ...NOT_A_TEST_NAME,
  ]);
  const titles = testTitles();
  const corpusIds = MUTATIONS.map((m) => m.id);
  const files = walkFiles(SRC, ".ts");

  it("finds source files and test titles to check against", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(titles.size).toBeGreaterThan(50);
    expect(corpusIds.length).toBeGreaterThan(20);
  });

  it("every backticked kebab-case token names a check, a corpus entry or a test", () => {
    const unknown: string[] = [];
    for (const file of files) {
      for (const match of commentText(file).matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)) {
        const token = match[1]!;
        if (known.has(token)) continue;
        if ([...titles].some((t) => t.includes(token))) continue;
        unknown.push(`${file}: ${token}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("every backticked glob matches at least one corpus entry", () => {
    const unmatched: string[] = [];
    for (const file of files) {
      for (const match of commentText(file).matchAll(/`([a-z][a-z0-9-]*)-\*`/g)) {
        const prefix = `${match[1]!}-`;
        if (corpusIds.some((id) => id.startsWith(prefix))) continue;
        unmatched.push(`${file}: ${prefix}*`);
      }
    }
    expect(unmatched).toEqual([]);
  });

  it("every backticked prose phrase long enough to be a test title is one", () => {
    const unknown: string[] = [];
    for (const file of files) {
      for (const match of commentText(file).matchAll(/`([a-z][^`\n]*)`/g)) {
        const phrase = match[1]!.replace(/\s+/g, " ").trim();
        if (phrase.split(" ").length < MINIMUM_TITLE_WORDS) continue;
        if (CODE_PUNCTUATION.test(phrase)) continue;
        if (titles.has(phrase)) continue;
        unknown.push(`${file}: ${phrase}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  // The checker has to be able to fail, or it is decoration. These run the same predicates over an
  // invented docstring rather than over `src/`, so the guarantee does not rest on `src/` currently
  // happening to contain a bad reference.
  it("would reject a docstring naming a test that does not exist", () => {
    const invented = "see `content-is-not-a-comment` for the proof";
    const token = /`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/.exec(invented)![1]!;
    expect(known.has(token)).toBe(false);
    expect([...titles].some((t) => t.includes(token))).toBe(false);
  });

  it("would reject a docstring naming a corpus glob that matches nothing", () => {
    const prefix = /`([a-z][a-z0-9-]*)-\*`/.exec("covered by `no-such-family-*` above")![1]!;
    expect(corpusIds.some((id) => id.startsWith(`${prefix}-`))).toBe(false);
  });

  it("would reject a docstring naming a prose test title that does not exist", () => {
    const phrase = "reads a directive that nobody ever wrote down anywhere";
    expect(phrase.split(" ").length).toBeGreaterThanOrEqual(MINIMUM_TITLE_WORDS);
    expect(CODE_PUNCTUATION.test(phrase)).toBe(false);
    expect(titles.has(phrase)).toBe(false);
  });
});
