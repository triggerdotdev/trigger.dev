import { sectionFile } from "@/lib/agent-surface";
import { markdownResponse, pagesText, sectionPages } from "@/lib/agent-markdown";
import { sections } from "@/lib/nav";

export const revalidate = false;
export const dynamicParams = false;

// One docs section (a top-level tab) as a single file: /llms-full/documentation.txt and so on.
export async function GET(_req: Request, { params }: { params: Promise<{ section: string }> }) {
  const pages = sectionPages((await params).section);
  if (!pages) return new Response("Not found", { status: 404 });
  return markdownResponse(await pagesText(pages), "text/plain");
}

export function generateStaticParams() {
  return sections.map((s) => ({ section: sectionFile(s) }));
}
