import { markdownResponse, pageMd, requestChoices } from "@/lib/agent-markdown";
import { cdnCacheControl } from "@/lib/cdn-cache";
import { source } from "@/lib/source";

// /docs/<path>.md?pm=pnpm&framework=nextjs, rewritten here by next.config.mjs: only the chosen
// variant of each tab group. Rendered per request; the plain `.md` stays static.
export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const page = source.getPage((await params).path);
  if (!page) return new Response("Not found", { status: 404 });
  return markdownResponse(await pageMd(page, requestChoices(req)), undefined, cdnCacheControl);
}
