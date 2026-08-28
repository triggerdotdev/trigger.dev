import { describe, expect, it } from "vitest";
import { DOCS_RESULT_MAX_CHARS, formatDocsResults } from "./tool-docs";

/** One result, as the docs endpoint writes it. */
function part(args: { title: string; page: string; body: string }): string {
  return `Title: ${args.title}\nLink: https://trigger.dev/docs/${args.page}\nPage: ${args.page}\nContent: ${args.body}`;
}

describe("what a docs answer costs", () => {
  it("keeps the title, page and link so the model can cite and link", () => {
    const formatted = formatDocsResults([
      part({
        title: "How it works",
        page: "runs/max-duration",
        body: "Set maxDuration in seconds.",
      }),
    ]);
    expect(formatted).toContain("Title: How it works");
    expect(formatted).toContain("Page: runs/max-duration");
    expect(formatted).toContain("https://trigger.dev/docs/runs/max-duration");
    expect(formatted).toContain("Set maxDuration in seconds.");
  });

  it("stays inside the cap however much the endpoint returns", () => {
    const parts = Array.from({ length: 12 }, (_, i) =>
      part({ title: `Result ${i}`, page: `page-${i}`, body: "x".repeat(9_000) })
    );
    const formatted = formatDocsResults(parts);
    expect(formatted.length).toBeLessThanOrEqual(DOCS_RESULT_MAX_CHARS);
    // A handful of results, each an excerpt rather than the whole section.
    expect(formatted.split("\n---\n").length).toBeLessThanOrEqual(5);
    expect(formatted).toContain("[excerpt — the rest is on the page]");
  });

  it("drops the image markup, which is bytes the model can't use", () => {
    const formatted = formatDocsResults([
      part({
        title: "Errors",
        page: "errors",
        body: `Before.\n\n<img src="https://cdn/x.png" srcset="${"y".repeat(2_000)}" />\n\nAfter.`,
      }),
    ]);
    expect(formatted).not.toContain("srcset");
    expect(formatted).toContain("Before.");
    expect(formatted).toContain("After.");
  });

  it("keeps a result it can't parse rather than dropping the answer", () => {
    expect(formatDocsResults(["just some prose with no fields"])).toContain("just some prose");
  });
});
