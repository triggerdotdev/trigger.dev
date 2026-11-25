import { allPages, markdownResponse, pagesText, requestChoices } from "@/lib/agent-markdown";
import { cdnCacheControl } from "@/lib/cdn-cache";

// /docs/llms-full.txt with `?pm=` or `?framework=` (rewrite in next.config.mjs).
export async function GET(req: Request) {
  return markdownResponse(
    await pagesText(allPages(), requestChoices(req)),
    "text/plain",
    cdnCacheControl
  );
}
