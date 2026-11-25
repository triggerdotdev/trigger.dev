import { markdownResponse, pageMd } from "@/lib/agent-markdown";
import { source } from "@/lib/source";

export const revalidate = false;
export const dynamicParams = false;

// Served at /docs/<path>.md through the rewrite in next.config.mjs.
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const page = source.getPage((await params).path);
  if (!page) return new Response("Not found", { status: 404 });
  return markdownResponse(await pageMd(page));
}

export function generateStaticParams() {
  return source.getPages().map((p) => ({ path: p.slugs }));
}
