// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import {
  AgentMarkdownTable,
  AgentMarkdownTableBody,
  AgentMarkdownTableCell,
  AgentMarkdownTableHead,
  AgentMarkdownTableHeaderCell,
  AgentMarkdownTableRow,
} from "./AgentMarkdownTable";
import type { HastLikeNode } from "./agent-markdown-table";

function textNode(value: string): HastLikeNode {
  return { type: "text", value };
}

function tableNode(): HastLikeNode {
  return {
    type: "element",
    tagName: "table",
    children: [
      {
        type: "element",
        tagName: "thead",
        children: [
          {
            type: "element",
            tagName: "tr",
            children: [
              { type: "element", tagName: "th", children: [textNode("a")] },
              { type: "element", tagName: "th", children: [textNode("b")] },
            ],
          },
        ],
      },
      {
        type: "element",
        tagName: "tbody",
        children: [
          {
            type: "element",
            tagName: "tr",
            children: [
              { type: "element", tagName: "td", children: [textNode("1")] },
              { type: "element", tagName: "td", children: [textNode("2")] },
            ],
          },
        ],
      },
    ],
  };
}

// The same React children a real streamdown render would produce: this file's own thead/tbody/tr
// overrides wrapping the header row and a body row whose second cell holds a link.
function tableChildren() {
  return [
    createElement(
      AgentMarkdownTableHead,
      { key: "thead" },
      createElement(
        AgentMarkdownTableRow,
        { key: "tr" },
        createElement(AgentMarkdownTableHeaderCell, { key: "a" }, "a"),
        createElement(AgentMarkdownTableHeaderCell, { key: "b" }, "b")
      )
    ),
    createElement(
      AgentMarkdownTableBody,
      { key: "tbody" },
      createElement(
        AgentMarkdownTableRow,
        { key: "tr1" },
        createElement(AgentMarkdownTableCell, { key: "1" }, "1"),
        createElement(
          AgentMarkdownTableCell,
          { key: "2" },
          createElement("a", { href: "https://example.com" }, "docs")
        )
      ),
      createElement(
        AgentMarkdownTableRow,
        { key: "tr2" },
        createElement(AgentMarkdownTableCell, { key: "1" }, "3"),
        createElement(AgentMarkdownTableCell, { key: "2" }, "4")
      )
    ),
  ];
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(AgentMarkdownTable, { node: tableNode() }, ...tableChildren())
        )
      )
    );
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

describe("AgentMarkdownTable fullscreen", () => {
  it("renders the Table primitives font-mono text-xs, preserving a link inside a cell", () => {
    render();

    const maximizeButton = container!.querySelector<HTMLButtonElement>(
      '[aria-label="Maximize chart"]'
    );
    expect(maximizeButton).not.toBeNull();
    act(() => {
      maximizeButton!.click();
    });

    // The dialog portals to document.body, outside `container`.
    const dialog = [...document.querySelectorAll("[role='dialog']")].find(
      (el) => !container!.contains(el)
    );
    expect(dialog).toBeTruthy();

    // TableHeader is the only thing that renders a sticky `thead` — proves the primitive, not a
    // plain `<thead>`, rendered here.
    const thead = dialog!.querySelector("thead");
    expect(thead?.className).toContain("sticky");

    const link = dialog!.querySelector("a[href='https://example.com']");
    expect(link?.textContent).toBe("docs");

    const th = dialog!.querySelector("th");
    const td = dialog!.querySelector("td");
    expect(th?.className).toContain("font-mono");
    expect(th?.className).toContain("text-xs");
    expect(td?.className).toContain("font-mono");
    expect(td?.className).toContain("text-xs");

    const triggers = document.querySelectorAll('[aria-label="More actions"]');
    const dialogTrigger = [...triggers].find((el) => !container!.contains(el));
    expect(dialogTrigger).toBeTruthy();
  });

  it("gives every row the same full-width bottom separator, header and body alike", () => {
    render();

    act(() => {
      container!.querySelector<HTMLButtonElement>('[aria-label="Maximize chart"]')!.click();
    });
    const dialog = [...document.querySelectorAll("[role='dialog']")].find(
      (el) => !container!.contains(el)
    )!;

    const rows = [...dialog.querySelectorAll("tr")];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const rowClasses = rows.map((row) => row.className);

    // Same class list for every row (header included) — no per-row inset that would stagger
    // the separator line — and it spans the full row width, not inset from the first cell.
    expect(new Set(rowClasses).size).toBe(1);
    expect(rowClasses[0]).toContain("after:left-0");
    expect(rowClasses[0]).not.toContain("after:left-3");
  });

  it("keeps a GFM right-aligned column's text-align in fullscreen", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(
          OperatingSystemContextProvider,
          { platform: "mac" },
          createElement(
            ShortcutsProvider,
            null,
            createElement(
              AgentMarkdownTable,
              { node: tableNode() },
              createElement(
                AgentMarkdownTableHead,
                { key: "thead" },
                createElement(
                  AgentMarkdownTableRow,
                  { key: "tr" },
                  createElement(AgentMarkdownTableHeaderCell, { key: "a" }, "a"),
                  createElement(
                    AgentMarkdownTableHeaderCell,
                    { key: "b", style: { textAlign: "right" } },
                    "b"
                  )
                )
              ),
              createElement(
                AgentMarkdownTableBody,
                { key: "tbody" },
                createElement(
                  AgentMarkdownTableRow,
                  { key: "tr" },
                  createElement(AgentMarkdownTableCell, { key: "1" }, "1"),
                  createElement(
                    AgentMarkdownTableCell,
                    { key: "2", style: { textAlign: "right" } },
                    "2"
                  )
                )
              )
            )
          )
        )
      );
    });

    act(() => {
      container!.querySelector<HTMLButtonElement>('[aria-label="Maximize chart"]')!.click();
    });
    const dialog = [...document.querySelectorAll("[role='dialog']")].find(
      (el) => !container!.contains(el)
    )!;

    // `TableCell` (td) forwards `style` straight onto the DOM node, so alignment shows up as
    // inline style. `TableHeaderCell` (th) has no `style` prop — it takes an `alignment` enum
    // that renders as a text-right/text-center/text-left class instead, so it's asserted there.
    const rightTd = [...dialog.querySelectorAll("td")].find((cell) => cell.textContent === "2");
    const leftTd = [...dialog.querySelectorAll("td")].find((cell) => cell.textContent === "1");
    expect((rightTd as HTMLElement).style.textAlign).toBe("right");
    expect((leftTd as HTMLElement).style.textAlign).not.toBe("right");

    const rightTh = [...dialog.querySelectorAll("th")].find((cell) => cell.textContent === "b");
    const leftTh = [...dialog.querySelectorAll("th")].find((cell) => cell.textContent === "a");
    expect(rightTh?.className).toContain("text-right");
    expect(leftTh?.className).not.toContain("text-right");
  });
});
