import { specs } from "@/.generated/openapi.js";
import { absoluteUrl } from "@/lib/agent-mdx";
import { mcpUrl, sectionFile, siteDescription } from "@/lib/agent-surface";
import { listedPages, sections } from "@/lib/nav";
import { docsUrl, parseOpenapiRef } from "@/lib/source";

export const revalidate = false;

// Sections by nav group, one line per page with its description, like the Mintlify file,
// plus where agents find the full text, the MCP server and the skill.
// API pages have no frontmatter description: their entry gets the endpoint's, on one line.
function apiDescription(ref: string) {
  const { document, method, path } = parseOpenapiRef(ref);
  const op = (
    specs[document]?.paths?.[path] as Record<string, { description?: string; summary?: string }>
  )?.[method];
  return (op?.description ?? op?.summary)
    ?.replace(/\s+/g, " ")
    .trim()
    .replace(
      /\]\(([^)\s]+)\)/g,
      (_, url: string) => `](${absoluteUrl(url, { docsUrl, pageUrl: "/" })})`
    );
}

export function GET() {
  const lines = [
    "# Trigger.dev",
    "",
    `> ${siteDescription}`,
    "",
    "## For agents",
    "",
    `- [Full docs as one file](${docsUrl}/llms-full.txt), or one section at a time: ${sections
      .map((s) => `[${s}](${docsUrl}/llms-full/${sectionFile(s)})`)
      .join(", ")}`,
    `- Any page as markdown: add \`.md\` to its URL, or send \`Accept: text/markdown\``,
    `- MCP server (search and read the docs): ${mcpUrl}`,
    `- Agent skill: ${docsUrl}/skill.md`,
    `- REST API OpenAPI spec: ${docsUrl}/v3-openapi.yaml`,
    "",
    "## Docs",
  ];
  let group = "";
  for (const { heading, page } of listedPages()) {
    if (heading !== group) lines.push("", `### ${(group = heading)}`, "");
    const description =
      page.data.description ?? (page.data.openapi ? apiDescription(page.data.openapi) : undefined);
    const desc = description ? `: ${description}` : "";
    lines.push(`- [${page.data.title}](${docsUrl}${page.url}.md)${desc}`);
  }
  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
