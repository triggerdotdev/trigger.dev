import { describe, expect, it } from "vitest";
import {
  expandDashboardFigures,
  figureTags,
  highlightKey,
  parseHighlight,
} from "./dashboard-figures";

describe("parseHighlight", () => {
  it("reads marks with optional badge labels", () => {
    expect(parseHighlight("environment-variables", "nav:1, add-new")).toEqual([
      { mark: "nav", label: "1" },
      { mark: "add-new", label: undefined },
    ]);
  });

  it("rejects a mark the figure doesn't have, and a malformed item", () => {
    expect(() => parseHighlight("environment-variables", "save")).toThrow(/no mark "save"/);
    expect(() => parseHighlight("environment-variables", "nav:<b>")).toThrow(/bad highlight/);
  });

  it("a value wrapped over two lines gives the same one-line key", () => {
    const marks = parseHighlight("environment-variables", "nav:1,\n    add-new:2");
    expect(highlightKey(marks)).toBe("nav:1,add-new:2");
  });
});

describe("figureTags", () => {
  it("finds tags with spaces around `=` and skips examples in code and comments", () => {
    const mdx = [
      '<DashboardFigure name = "api-keys" highlight = "nav" />',
      "```mdx",
      '<DashboardFigure name="api-keys" highlight="typo" />',
      "```",
      'Inline `<DashboardFigure name="x" />` and {/* <DashboardFigure name="y" /> */}',
      "> ```mdx",
      '> <DashboardFigure name="api-keys" highlight="typo" />',
      "> ```",
      '<DashboardFigure name="environment-variables" />',
    ].join("\n");
    const tags = figureTags(mdx);
    expect(tags.map((m) => mdx.slice(0, m.index).split("\n").length)).toEqual([1, 9]);
    expect(tags[0]!.tag).toBe('<DashboardFigure name = "api-keys" highlight = "nav" />');
  });
});

describe("figureTags fences", () => {
  // CommonMark containers: a fence closes at its own blockquote depth, and a quote ends its fence.
  it("a quoted fence marker inside a plain fence is code", () => {
    const mdx = '```mdx\n> ```\n<DashboardFigure name="api-keys" highlight="typo" />\n```';
    expect(figureTags(mdx)).toEqual([]);
  });

  it("CRLF files: a fence still hides its examples", () => {
    const mdx =
      '```mdx\r\n<DashboardFigure name="nope" />\r\n```\r\n<DashboardFigure name="api-keys" />';
    expect(figureTags(mdx).map((t) => t.attrs.name)).toEqual(["api-keys"]);
  });

  it("a fence marker in an MDX comment doesn't open a fence", () => {
    const mdx = '{/*\nOpen a block with\n```mdx\n*/}\n<DashboardFigure name="api-keys" />';
    expect(figureTags(mdx).map((t) => t.attrs.name)).toEqual(["api-keys"]);
  });

  it("`{/*` in inline code doesn't start a comment", () => {
    const mdx =
      'Use `{/*` to start an MDX comment.\n```mdx\n<DashboardFigure name="nope" />\n```\n<DashboardFigure name="api-keys" />';
    expect(figureTags(mdx).map((t) => t.attrs.name)).toEqual(["api-keys"]);
  });

  it("a backtick inside a comment doesn't hide its end", () => {
    const mdx =
      'Text {/*\nA literal backtick: ` */} with `inline code`.\n```mdx\n<DashboardFigure name="nope" />\n```\n<DashboardFigure name="api-keys" />';
    expect(figureTags(mdx).map((t) => t.attrs.name)).toEqual(["api-keys"]);
  });

  it("a comment ends at `*/` when its `}` is on the next line", () => {
    const mdx =
      '{/* note\n<DashboardFigure name="nope" />\n*/\n}\n```mdx\n<DashboardFigure name="nope" />\n```\n<DashboardFigure name="api-keys" />';
    expect(figureTags(mdx).map((t) => t.attrs.name)).toEqual(["api-keys"]);
  });

  it("comment markers in a fence stay code", () => {
    const mdx = '```mdx\n{/*\n```\n<DashboardFigure name="api-keys" />';
    expect(figureTags(mdx).map((t) => t.attrs.name)).toEqual(["api-keys"]);
  });

  it("a fence left open in a quote ends with the quote", () => {
    const mdx = '> ```mdx\n> code\n\n<DashboardFigure name="api-keys" />';
    expect(figureTags(mdx).map((t) => t.attrs.name)).toEqual(["api-keys"]);
  });
});

describe("expandDashboardFigures", () => {
  it("turns a tag into its description and caption, and leaves unknown names alone", () => {
    const md = expandDashboardFigures(
      'Before\n\n<DashboardFigure name="api-keys" highlight="nav" caption="Your keys" />\n\n<DashboardFigure name="nope" />'
    );
    expect(md).toMatch(
      /^Before\n\n\[Dashboard: The API keys page in the dashboard, .*\]\n\nYour keys\n\n<DashboardFigure name="nope" \/>$/s
    );
  });

  it("keeps code in a caption", () => {
    const md = expandDashboardFigures(
      '<DashboardFigure name="api-keys" caption="Copy the `tr_dev_` key" />'
    );
    expect(md).toMatch(/\]\n\nCopy the `tr_dev_` key$/);
  });

  it("names the mark behind each numbered badge, and keeps code examples as written", () => {
    const example = '```mdx\n<DashboardFigure name="api-keys" />\n```';
    const md = expandDashboardFigures(
      `<DashboardFigure name="environment-variables" highlight="nav:1, add-new:2" />\n\n${example}`
    );
    expect(md).toMatch(
      / Marked 1: nav, 2: add new\.\]\n\n```mdx\n<DashboardFigure name="api-keys" \/>\n```$/
    );
  });
});
