import { describe, expect, it } from "vitest";
import {
  extractMarkdownTableGrid,
  gridToCSV,
  gridToJSON,
  gridToMarkdown,
  type HastLikeNode,
} from "./agent-markdown-table";

function text(value: string): HastLikeNode {
  return { type: "text", value };
}

function el(tagName: string, children: HastLikeNode[]): HastLikeNode {
  return { type: "element", tagName, children };
}

function table(children: HastLikeNode[]): HastLikeNode {
  return el("table", children);
}

describe("extractMarkdownTableGrid", () => {
  it("extracts a header and body", () => {
    const node = table([
      el("thead", [el("tr", [el("th", [text("a")]), el("th", [text("b")])])]),
      el("tbody", [el("tr", [el("td", [text("1")]), el("td", [text("2")])])]),
    ]);

    expect(extractMarkdownTableGrid(node)).toEqual({
      columns: ["a", "b"],
      rows: [["1", "2"]],
    });
  });

  it("returns empty strings for empty cells", () => {
    const node = table([
      el("thead", [el("tr", [el("th", [text("a")]), el("th", [])])]),
      el("tbody", [el("tr", [el("td", []), el("td", [text("x")])])]),
    ]);

    expect(extractMarkdownTableGrid(node)).toEqual({
      columns: ["a", ""],
      rows: [["", "x"]],
    });
  });

  it("flattens inline code and links inside a cell", () => {
    const node = table([
      el("thead", [el("tr", [el("th", [text("cell")])])]),
      el("tbody", [
        el("tr", [
          el("td", [
            text("see "),
            el("code", [text("foo()")]),
            text(" or "),
            el("a", [text("the docs")]),
          ]),
        ]),
      ]),
    ]);

    expect(extractMarkdownTableGrid(node)).toEqual({
      columns: ["cell"],
      rows: [["see foo() or the docs"]],
    });
  });

  it("returns no columns when thead is missing, but still reads body rows", () => {
    const node = table([el("tbody", [el("tr", [el("td", [text("1")])])])]);

    expect(extractMarkdownTableGrid(node)).toEqual({
      columns: [],
      rows: [["1"]],
    });
  });

  it("handles an undefined node", () => {
    expect(extractMarkdownTableGrid(undefined)).toEqual({ columns: [], rows: [] });
  });
});

describe("gridToMarkdown", () => {
  it("serializes a header and body as a pipe table", () => {
    const markdown = gridToMarkdown({ columns: ["a", "b"], rows: [["1", "2"]] });

    expect(markdown).toBe(["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"));
  });

  it("escapes a pipe in a cell", () => {
    const markdown = gridToMarkdown({ columns: ["a"], rows: [["1 | 2"]] });

    expect(markdown).toContain("1 \\| 2");
  });

  it("returns an empty string for an empty grid", () => {
    expect(gridToMarkdown({ columns: [], rows: [] })).toBe("");
  });
});

describe("gridToCSV", () => {
  it("serializes rows as CSV", () => {
    expect(gridToCSV({ columns: ["a", "b"], rows: [["1", "2"]] })).toBe("a,b\n1,2");
  });

  it("quotes a cell containing a comma", () => {
    expect(gridToCSV({ columns: ["a"], rows: [["1,2"]] })).toBe('a\n"1,2"');
  });
});

describe("gridToJSON", () => {
  it("serializes rows keyed by column name", () => {
    const json = gridToJSON({ columns: ["a", "b"], rows: [["1", "2"]] });

    expect(JSON.parse(json)).toEqual([{ a: "1", b: "2" }]);
  });
});

// A malformed markdown table (or a model-authored one) can have rows that don't match the
// header width. Each export format handles that differently; pin the exact behaviour of each.
describe("ragged rows (fewer/more cells than the header)", () => {
  const grid = { columns: ["a", "b"], rows: [["1"], ["2", "3", "4"]] };

  it("gridToMarkdown pads short rows and widens the table for long ones", () => {
    expect(gridToMarkdown(grid)).toBe(
      ["| a | b | Column 3 |", "| --- | --- | --- |", "| 1 |  |  |", "| 2 | 3 | 4 |"].join("\n")
    );
  });

  it("gridToCSV leaves rows as-is, without padding or truncating", () => {
    expect(gridToCSV(grid)).toBe("a,b\n1\n2,3,4");
  });

  it("gridToJSON pads a short row and drops cells past the header width", () => {
    expect(JSON.parse(gridToJSON(grid))).toEqual([
      { a: "1", b: "" },
      { a: "2", b: "3" },
    ]);
  });
});
