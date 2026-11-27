import type { Code, Root } from "mdast";
import { visit } from "unist-util-visit";
import { findTaskTests, isScriptLang, taskTestPath } from "./task-test";

/** Fence meta attribute carrying a sample's "Test in dashboard" path (read in source.config.ts). */
export const TASK_TEST_ATTR = "data-task-test";
export const TASK_TEST_META = /(?:^|\s)data-task-test="([^"]*)"/;

/**
 * "Test in dashboard" on task samples: the script blocks between two headings are one sample, and
 * a block that defines a task the sample triggers with a literal payload gets the dashboard Test
 * page path in its fence meta, which rehype-code puts on the <pre> for CodeSample.
 */
export function remarkTaskTest() {
  return (tree: Root) => {
    const sections: Code[][] = [[]];
    visit(tree, (node) => {
      if (node.type === "heading") sections.push([]);
      else if (node.type === "code" && isScriptLang(node.lang)) sections.at(-1)!.push(node);
    });
    for (const blocks of sections) {
      if (blocks.length === 0) continue;
      for (const [index, test] of findTaskTests(blocks.map((b) => b.value))) {
        const block = blocks[index]!;
        block.meta = `${block.meta ?? ""} ${TASK_TEST_ATTR}="${taskTestPath(test)}"`.trim();
      }
    }
  };
}
