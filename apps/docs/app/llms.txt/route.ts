import { sectionFile, siteDescription } from "@/lib/agent-surface";
import { listedPages, sections } from "@/lib/nav";
import { docsUrl } from "@/lib/source";

export const revalidate = false;

// Sections by nav group, one line per page with its description, like the Mintlify file,
// plus where agents find the full text.
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
    "",
    "## Docs",
  ];
  let group = "";
  for (const { heading, page } of listedPages()) {
    if (heading !== group) lines.push("", `### ${(group = heading)}`, "");
    const desc = page.data.description ? `: ${page.data.description}` : "";
    lines.push(`- [${page.data.title}](${docsUrl}${page.url}.md)${desc}`);
  }
  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
