import type { Element, ElementContent, Root } from "hast";
import type { VFile } from "vfile";
import { toHtml } from "hast-util-to-html";
import { visit } from "unist-util-visit";
import { tokenClass, tokenStyles } from "./shiki-themes";

// Both plugins run after rehype-code. Highlighted code is most of a page's weight, and the page
// ships it twice (the HTML and the RSC payload), so these keep it small.

const classByStyle = new Map(tokenStyles.map((s, i) => [s, tokenClass(i)]));

/** Token spans get a class (app/global.css imports the rules) instead of a per-span style. */
export function rehypeTokenClasses() {
  return (tree: Root) => {
    visit(tree, "element", (node) => {
      const style = node.properties.style;
      if (node.tagName !== "span" || typeof style !== "string") return;
      const cls = classByStyle.get(style);
      if (!cls) return;
      delete node.properties.style;
      const existing = node.properties.className;
      node.properties.className = Array.isArray(existing) ? [...existing, cls] : [cls];
    });
  };
}

/**
 * Twoslash type popups leave the page: each `Popup` becomes a `TypeHover` holding an index into
 * the page's `hovers` export (deduplicated popup HTML), which /hovers/<page> serves and
 * components/type-hover.tsx fetches on first hover or focus. A snippet compiles on its own, so its
 * indices would point into the importing page's list: its hovers keep their HTML inline instead.
 */
export function rehypeLazyHovers() {
  return (tree: Root, file?: VFile) => {
    const inline = /[\\/]snippets[\\/]/.test(file?.path ?? "");
    const hovers: string[] = [];
    const index = new Map<string, number>();
    visit(tree, "element", (node, i, parent) => {
      if (node.tagName !== "Popup" || !parent || i === undefined) return;
      const child = (name: string) =>
        node.children.find((c): c is Element => c.type === "element" && c.tagName === name);
      const content = child("PopupContent");
      const trigger = child("PopupTrigger");
      if (!content || !trigger) return;
      const html = toHtml(content.children);
      let n = index.get(html);
      if (n === undefined && !inline) index.set(html, (n = hovers.push(html) - 1));
      const hover: Element = {
        type: "element",
        tagName: "TypeHover",
        properties: inline ? { html } : { hover: n },
        children: trigger.children as ElementContent[],
      };
      parent.children[i] = hover;
      return "skip";
    });
    if (hovers.length === 0) return;
    // An ESM node passes through to the compiled module as `export const hovers = [...]`.
    tree.children.push({
      type: "mdxjsEsm",
      value: "",
      data: {
        estree: {
          type: "Program",
          sourceType: "module",
          body: [
            {
              type: "ExportNamedDeclaration",
              specifiers: [],
              source: null,
              attributes: [],
              declaration: {
                type: "VariableDeclaration",
                kind: "const",
                declarations: [
                  {
                    type: "VariableDeclarator",
                    id: { type: "Identifier", name: "hovers" },
                    init: {
                      type: "ArrayExpression",
                      elements: hovers.map((value) => ({ type: "Literal", value })),
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    } as unknown as Root["children"][number]);
  };
}
