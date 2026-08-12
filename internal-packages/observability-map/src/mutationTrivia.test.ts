import { describe, expect, it } from "vitest";
import { MUTATIONS } from "./mutations.js";
import { parseSuppressions } from "./suppression.js";

/**
 * A suppression is file-scoped and can only lower a score, so a rewrite that drops one raises the
 * file back to its unsuppressed ratio. A `preserving` entry that does that breaks the corpus
 * assertion it is measured under, and no route in the real tree carries a directive, so the corpus
 * cannot see it. These fixtures put a directive in each position a rewrite joins across.
 */
const FIXTURES: { name: string; fileName: string; source: string }[] = [
  {
    name: "between two const declarations in a block",
    fileName: "consts.ts",
    source: [
      "export async function action() {",
      "  const a = compute();",
      "  // obs-map-disable error-classification -- fixture",
      "  const b = compute();",
      "  return a + b;",
      "}",
      "",
    ].join("\n"),
  },
  {
    name: "between two expression statements in a block",
    fileName: "statements.ts",
    source: [
      "export async function action() {",
      "  first();",
      "  // obs-map-disable request-context -- fixture",
      "  second();",
      "}",
      "",
    ].join("\n"),
  },
  {
    name: "between two expression statements at file scope",
    fileName: "toplevel.ts",
    source: ["first();", "// obs-map-disable audit-trail -- fixture", "second();", ""].join("\n"),
  },
  {
    name: "a block comment between two const declarations",
    fileName: "block-comment.ts",
    source: [
      "export async function action() {",
      "  const a = compute();",
      "  /* obs-map-disable auth-boundary -- fixture */",
      "  const b = compute();",
      "  return a + b;",
      "}",
      "",
    ].join("\n"),
  },
];

const PRESERVING = MUTATIONS.filter((m) => m.kind === "preserving");

describe("preserving mutations keep every suppression directive", () => {
  it("has preserving entries to check", () => {
    expect(PRESERVING.length).toBeGreaterThan(0);
  });

  for (const mutation of PRESERVING) {
    for (const fixture of FIXTURES) {
      it(`${mutation.id} keeps the directive ${fixture.name}`, () => {
        const before = parseSuppressions(fixture.source, fixture.fileName);
        expect(before.byId.size).toBe(1);

        const result = mutation.apply(fixture.fileName, fixture.source);
        if (result === null) return;

        // Superset, not equality: `suppress-every-check` adds a directive for every check on
        // purpose, and adding one can only lower a score. Losing one is the direction that raises.
        const after = parseSuppressions(result.source, fixture.fileName);
        const lost = [...before.byId.keys()].filter((id) => !after.byId.has(id));
        expect(lost).toEqual([]);
      });
    }
  }
});
