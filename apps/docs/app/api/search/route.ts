import { cdnCacheControl } from "@/lib/cdn-cache";
import { searchResults } from "@/lib/search";

export function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const query = params.get("query")?.trim();
  const headers = { "Cache-Control": cdnCacheControl };
  if (!query) return Response.json([], { headers });
  return Response.json(searchResults(query, params.get("tag") || undefined), { headers });
}
