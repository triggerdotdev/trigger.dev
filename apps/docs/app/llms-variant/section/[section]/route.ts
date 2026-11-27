import { markdownResponse, pagesText, requestChoices, sectionPages } from "@/lib/agent-markdown";
import { cdnCacheControl } from "@/lib/cdn-cache";

// /docs/llms-full/<section>.txt with `?pm=` or `?framework=` (rewrite in next.config.mjs).
export async function GET(req: Request, { params }: { params: Promise<{ section: string }> }) {
  const pages = sectionPages((await params).section);
  if (!pages) return new Response("Not found", { status: 404 });
  return markdownResponse(
    await pagesText(pages, requestChoices(req)),
    "text/plain",
    cdnCacheControl
  );
}
