import { describe, expect, it } from "vitest";
import { linkCitations } from "./citations";

const sources = new Map([
  [1, { url: "https://trigger.dev/docs/errors-retrying#retrying" }],
  [2, { url: "https://trigger.dev/docs/tasks/overview" }],
]);

describe("linkCitations", () => {
  it("links known numbers and keeps unknown ones", () => {
    expect(linkCitations("Retries are on by default [1][2]. See [9].", sources)).toBe(
      "Retries are on by default [1](https://trigger.dev/docs/errors-retrying#retrying)[2](https://trigger.dev/docs/tasks/overview). See [9]."
    );
  });

  // Catches: array indexes in code turned into citation links.
  it("leaves fenced and inline code alone, including an unclosed fence while streaming", () => {
    const text =
      "Use `items[1]` here [2].\n```ts\nconst a = items[1];\n```\nDone [1].\n```ts\nb[2]";
    const out = linkCitations(text, sources);
    expect(out).toContain("`items[1]`");
    expect(out).toContain("const a = items[1];");
    expect(out).toContain("b[2]");
    expect(out).toContain("here [2](https://trigger.dev/docs/tasks/overview)");
    expect(out).toContain("Done [1](https://trigger.dev/docs/errors-retrying#retrying)");
  });

  it("doesn't touch existing markdown links", () => {
    expect(linkCitations("[1](/x) and [label](/y)", sources)).toBe("[1](/x) and [label](/y)");
  });
});
