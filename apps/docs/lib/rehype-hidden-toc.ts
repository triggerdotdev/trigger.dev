import type { Root } from "hast";
import { visit } from "unist-util-visit";

type JsxElement = { name: string | null; attributes: Array<{ name?: string; value?: unknown }> };

const HEADING = /^h[1-6]$/;

/**
 * Headings inside `<Visibility for="agents">` never render (components/mintlify.tsx), so they stay
 * out of "On this page". Runs before Fumadocs' rehype-toc, which drops a heading ending in `[!toc]`.
 */
export function rehypeHiddenToc() {
  return (tree: Root) => {
    visit(tree, "mdxJsxFlowElement", (node) => {
      const el = node as unknown as JsxElement;
      if (el.name !== "Visibility") return;
      const audience = el.attributes.find((a) => a.name === "for")?.value;
      if (audience === "humans") return;
      visit(node, "element", (heading) => {
        if (!HEADING.test(heading.tagName)) return;
        const last = heading.children.at(-1);
        if (last?.type === "text") last.value += " [!toc]";
        else heading.children.push({ type: "text", value: "[!toc]" });
      });
    });
  };
}
