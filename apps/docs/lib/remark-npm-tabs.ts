import convert from "npm-to-yarn";
import type { Code, Parent, Root } from "mdast";
import { visit } from "unist-util-visit";

export const SHELL = new Set(["bash", "sh", "shell", "zsh", "terminal", "console"]);
export const MANAGERS = ["pnpm", "yarn", "bun"] as const;

/** The block's commands for each package manager, or undefined unless every line is npm or npx. */
export function npmVariants(code: string): Record<(typeof MANAGERS)[number], string> | undefined {
  const lines = code.split("\n");
  const commands = lines.filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (!commands.length || !commands.every((l) => /^\s*(npm|npx)\s/.test(l))) return undefined;
  const out = {} as Record<(typeof MANAGERS)[number], string>;
  for (const pm of MANAGERS) {
    const converted = lines.map((l) =>
      /^\s*(npm|npx)\s/.test(l) ? convert(l, pm).replace(/^(\s*)bun x /, "$1bunx ") : l
    );
    // npm-to-yarn appends a comment when it can't translate a command (`npm cache clean`).
    if (converted.some((l) => l.includes("couldn't auto-convert"))) return undefined;
    out[pm] = converted.join("\n");
  }
  return out;
}

/**
 * A lone shell block of npm/npx commands becomes a CodeGroup with npm, pnpm, yarn and bun tabs,
 * which then follow the reader's package manager like hand-written ones. Blocks already in a
 * CodeGroup, or with a title, are left alone.
 */
export function remarkNpmTabs() {
  return (tree: Root) => {
    visit(tree, "code", (node: Code, index, parent: Parent | undefined) => {
      if (!parent || index === undefined || !SHELL.has(node.lang ?? "") || node.meta) return;
      if ((parent as { name?: string }).name === "CodeGroup") return;
      const variants = npmVariants(node.value);
      if (!variants) return;
      const block = (title: string, value: string): Code => ({
        type: "code",
        lang: node.lang,
        meta: title,
        value,
      });
      parent.children[index] = {
        type: "mdxJsxFlowElement",
        name: "CodeGroup",
        attributes: [],
        children: [block("npm", node.value), ...MANAGERS.map((pm) => block(pm, variants[pm]))],
      } as never;
    });
  };
}
