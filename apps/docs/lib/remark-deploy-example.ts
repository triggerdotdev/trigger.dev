import path from "node:path";
import type { Code, Root, RootContent } from "mdast";
import { SKIP, visit } from "unist-util-visit";
import type { VFile } from "vfile";
import { contentDir } from "./content-files";

type ExampleRepo = {
  /** degit source: owner/repo[/dir][#branch] */
  source: string;
  /** Folder the code is copied into. */
  folder: string;
};

const GITHUB =
  /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob|edit)\/([\w.-]+)((?:\/[^/?#]+)*))?\/?(?:[?#].*)?$/;

/**
 * The example project a GitHub link points at: a repo, or a folder of one (a link to a file in it
 * means its folder). Null for other links, and for monorepo examples, whose tasks live in a
 * workspace package these generic commands don't reach.
 */
export function exampleFromHref(href: string): ExampleRepo | null {
  const m = GITHUB.exec(href);
  if (!m) return null;
  const [, owner, repo, branch, rest = ""] = m;
  const parts = rest.split("/").filter(Boolean);
  if (parts.length && /\.\w+$/.test(parts.at(-1)!)) parts.pop();
  if (parts.includes("monorepos")) return null;
  const ref = branch && branch !== "main" && branch !== "master" ? `#${branch}` : "";
  return {
    source: [owner, repo, ...parts].join("/") + ref,
    folder: parts.at(-1) ?? repo!,
  };
}

/** The commands that copy an example and deploy it to the reader's project. */
export function deployCommands(example: ExampleRepo): string {
  return [
    `npx degit ${example.source} ${example.folder}`,
    `cd ${example.folder}`,
    "npm install",
    "npx trigger.dev@latest login",
    // <your-project-ref> is a reader placeholder: signed-in readers see their own ref.
    "npx trigger.dev@latest deploy --project-ref <your-project-ref>",
  ].join("\n");
}

type JsxNode = {
  type: "mdxJsxFlowElement";
  name: string | null;
  attributes: Array<{ type: string; name?: string; value?: unknown }>;
  children: RootContent[];
};

/**
 * "Deploy this example" on guide pages: after the first card linking an example repo, a block with
 * the commands to run it in the reader's own project (components/deploy-example.tsx).
 */
export function remarkDeployExample() {
  return (tree: Root, file: VFile) => {
    if (!file.path?.startsWith(path.join(contentDir, "guides") + path.sep)) return;
    let done = false;
    visit(
      tree,
      "mdxJsxFlowElement" as never,
      (node: JsxNode, index, parent: { children: unknown[] }) => {
        if (done || node.name !== "Card" || index === undefined || !parent) return;
        const href = node.attributes.find((a) => a.name === "href")?.value;
        const example = typeof href === "string" ? exampleFromHref(href) : null;
        if (!example) return;
        done = true;
        const code: Code = {
          type: "code",
          lang: "bash",
          meta: null,
          value: deployCommands(example),
        };
        const block: JsxNode = {
          type: "mdxJsxFlowElement",
          name: "DeployExample",
          attributes: [{ type: "mdxJsxAttribute", name: "folder", value: example.folder }],
          children: [code],
        };
        parent.children.splice(index + 1, 0, block);
        return SKIP;
      }
    );
  };
}
