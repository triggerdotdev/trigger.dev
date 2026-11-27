import type { Element, Root } from "hast";
import { assert, test } from "vitest";
import { rehypeHiddenToc } from "./rehype-hidden-toc.ts";

const h2 = (text: string): Element => ({
  type: "element",
  tagName: "h2",
  properties: { id: text },
  children: [{ type: "text", value: text }],
});
const visibility = (audience: string, children: Element[]) =>
  ({
    type: "mdxJsxFlowElement",
    name: "Visibility",
    attributes: [{ type: "mdxJsxAttribute", name: "for", value: audience }],
    children,
  }) as unknown as Element;
const text = (el: Element) => (el.children[0] as { value: string }).value;

// Catches: a section only agents read showing up in "On this page", where its link scrolls nowhere.
test("headings readers never see are marked out of the TOC; visible ones are not", () => {
  const hidden = h2("Facts for AI assistants");
  const shown = h2("For humans");
  const plain = h2("Overview");
  const tree: Root = {
    type: "root",
    children: [plain, visibility("agents", [hidden]), visibility("humans", [shown])],
  };
  rehypeHiddenToc()(tree);
  assert.equal(text(hidden), "Facts for AI assistants [!toc]");
  assert.equal(text(shown), "For humans");
  assert.equal(text(plain), "Overview");
});
