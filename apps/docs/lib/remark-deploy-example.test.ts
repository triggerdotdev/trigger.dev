import path from "node:path";
import type { Code, Root } from "mdast";
import type { VFile } from "vfile";
import { describe, expect, it } from "vitest";
import { contentDir } from "./content-files";
import { deployCommands, exampleFromHref, remarkDeployExample } from "./remark-deploy-example";
import { remarkNpmTabs } from "./remark-npm-tabs";

describe("exampleFromHref", () => {
  it("reads example folders, files in them, and whole repos", () => {
    expect(
      exampleFromHref("https://github.com/triggerdotdev/examples/tree/main/batch-llm-evaluator")
    ).toEqual({
      source: "triggerdotdev/examples/batch-llm-evaluator",
      folder: "batch-llm-evaluator",
    });
    expect(
      exampleFromHref("https://github.com/triggerdotdev/examples/tree/main/nextjs-webhooks/my-app")
        ?.source
    ).toBe("triggerdotdev/examples/nextjs-webhooks/my-app");
    expect(
      exampleFromHref(
        "https://github.com/triggerdotdev/examples/blob/main/realtime-csv-importer/README.md"
      )?.folder
    ).toBe("realtime-csv-importer");
    expect(
      exampleFromHref(
        "https://github.com/triggerdotdev/examples/edit/main/python-pdf-form-extractor/"
      )?.folder
    ).toBe("python-pdf-form-extractor");
    expect(exampleFromHref("https://github.com/code-with-antonio/ai-teammates")).toEqual({
      source: "code-with-antonio/ai-teammates",
      folder: "ai-teammates",
    });
    expect(exampleFromHref("https://github.com/acme/demo/tree/v2/app")?.source).toBe(
      "acme/demo/app#v2"
    );
  });

  it("skips other links and monorepo examples", () => {
    expect(exampleFromHref("https://trigger.dev/docs")).toBeNull();
    expect(exampleFromHref("https://github.com/triggerdotdev")).toBeNull();
    expect(
      exampleFromHref(
        "https://github.com/triggerdotdev/examples/tree/main/monorepos/turborepo-prisma-tasks-package"
      )
    ).toBeNull();
  });
});

describe("deployCommands", () => {
  it("deploys with the reader's project ref placeholder", () => {
    const commands = deployCommands({ source: "triggerdotdev/examples/x", folder: "x" });
    expect(commands.split("\n")).toEqual([
      "npx degit triggerdotdev/examples/x x",
      "cd x",
      "npm install",
      "npx trigger.dev@latest login",
      "npx trigger.dev@latest deploy --project-ref <your-project-ref>",
    ]);
  });
});

describe("remarkDeployExample", () => {
  // Catches: package manager tabs on the deploy block, whose yarn or pnpm tab can fail in an
  // example that pins another manager.
  it("adds one npm block after a guide's first example card, without tabs", () => {
    const card = { type: "mdxJsxAttribute", name: "href", value: "https://github.com/acme/resend" };
    const tree = {
      type: "root",
      children: [{ type: "mdxJsxFlowElement", name: "Card", attributes: [card], children: [] }],
    } as unknown as Root;
    // Plugin order as in source.config.ts.
    remarkNpmTabs()(tree);
    remarkDeployExample()(tree, { path: path.join(contentDir, "guides/x.mdx") } as VFile);
    const deploy = tree.children[1] as unknown as { name: string; children: Code[] };
    expect(deploy.name).toBe("DeployExample");
    expect(deploy.children.map((c) => [c.type, c.lang])).toEqual([["code", "bash"]]);
    expect(deploy.children[0]!.value).toContain("\ncd resend\nnpm install\n");
  });
});
