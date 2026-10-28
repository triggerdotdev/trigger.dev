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
  it("opens a fullscreen dialog and preserves links inside cells", () => {
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

    const link = dialog!.querySelector("a[href='https://example.com']");
    expect(link?.textContent).toBe("docs");
  });
});
