import path from "node:path";
import { visit } from "unist-util-visit";
import type { Root } from "mdast";
import type { VFile } from "vfile";
import { withBase } from "./base-path";
import { contentDir } from "./content-files";

// Mintlify fence flags that are not part of the title.
const FLAGS = new Set(["wrap", "lines", "expandable", "twoslash", "highlight", "focus"]);

/**
 * Mintlify code fence meta: everything that is not `key=value`, `{1-3}` or a flag is the title,
 * e.g. ```ts trigger/my-task.ts -> title="trigger/my-task.ts". An explicit `title=` wins.
 */
function mintlifyMetaToFumadocs(meta: string): string {
  if (/(^|\s)title=/.test(meta)) return meta;
  const keep: string[] = [];
  const title: string[] = [];
  // tokens: key="quoted value" | key={...} | {...} | word
  const re = /(\w+=(?:"[^"]*"|'[^']*'|\{[^}]*\}|\S+))|(\{[^}]*\})|(\S+)/g;
  for (const m of meta.matchAll(re)) {
    if (m[1]) keep.push(m[1]);
    else if (m[2]) continue; // Mintlify line ranges; Fumadocs uses notation comments instead
    else if (FLAGS.has(m[3]!)) continue;
    else if (/^no-?twoslash$/.test(m[3]!)) keep.push(m[3]!); // read by lib/twoslash.ts
    else title.push(m[3]!);
  }
  if (title.length) keep.unshift(`title="${title.join(" ").replace(/"/g, "&quot;")}"`);
  return keep.join(" ");
}

type EsmNode = {
  type: "mdxjsEsm";
  value: string;
  data?: { estree?: { body: Array<{ type: string; source?: { value: unknown; raw?: string } }> } };
};

type JsxNode = { name: string | null; attributes: Array<{ name?: string; value?: unknown }> };

type ExprNode = {
  value: string;
  data?: {
    estree?: {
      body: Array<{
        type: string;
        expression?: Record<string, unknown> & { type: string; name?: string };
      }>;
    };
  };
};

/** Mintlify-compatible remark plugin: fence titles and root-absolute snippet imports. */
export function remarkMintlify() {
  return (tree: Root, file: VFile) => {
    visit(tree, "code", (node) => {
      if (node.meta) node.meta = mintlifyMetaToFumadocs(node.meta);
    });

    // JSX tags written in the content (`<img src="/images/x.png">`) bypass the MDX components, so
    // their root-relative URLs get the /docs base path here.
    visit(tree, ["mdxJsxFlowElement", "mdxJsxTextElement"] as never, (node: JsxNode) => {
      if (!node.name || !["img", "video", "source"].includes(node.name)) return;
      for (const attr of node.attributes) {
        const value = attr.value;
        if (typeof value !== "string") continue;
        if (attr.name === "src" || attr.name === "poster") attr.value = withBase(value);
        // `srcSet` is a comma-separated list of "url [descriptor]" candidates.
        if (attr.name === "srcSet")
          attr.value = value
            .split(",")
            .map((c) => c.trim().replace(/^\S+/, (u) => withBase(u)))
            .join(", ");
      }
    });

    // Mintlify snippets read their props as bare variables (`{framework}`); MDX needs `props.framework`.
    if (file.path?.startsWith(path.join(contentDir, "snippets") + path.sep)) {
      visit(tree, ["mdxTextExpression", "mdxFlowExpression"] as never, (node: ExprNode) => {
        const stmt = node.data?.estree?.body[0];
        const id = stmt?.type === "ExpressionStatement" ? stmt.expression : undefined;
        if (
          id?.type !== "Identifier" ||
          !id.name ||
          !/^[a-z]\w*$/.test(id.name) ||
          id.name === "props"
        )
          return;
        stmt!.expression = {
          type: "MemberExpression",
          object: { type: "Identifier", name: "props" },
          property: { type: "Identifier", name: id.name },
          computed: false,
          optional: false,
        };
        node.value = `props.${id.name}`;
      });
    }

    visit(tree, "mdxjsEsm" as never, (node: EsmNode) => {
      for (const stmt of node.data?.estree?.body ?? []) {
        const src = stmt.source;
        if (!src || typeof src.value !== "string" || !src.value.startsWith("/snippets/")) continue;
        // Relative to the importing file: the bundler doesn't take absolute filesystem specifiers.
        let rel = path.relative(path.dirname(file.path), path.join(contentDir, src.value));
        if (!rel.startsWith(".")) rel = `./${rel}`;
        node.value = node.value.split(JSON.stringify(src.value)).join(JSON.stringify(rel));
        src.value = rel;
        src.raw = JSON.stringify(rel);
      }
    });
  };
}
