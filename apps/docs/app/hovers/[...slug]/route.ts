import { loadPage, source } from "@/lib/source";

// Each page's type hover popups as a JSON array of HTML (components/type-hover.tsx).
export const dynamicParams = false;

export function generateStaticParams() {
  return source.generateParams();
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const page = source.getPage((await params).slug);
  if (!page) return new Response("Not found", { status: 404 });
  const { _exports } = await loadPage(page);
  return Response.json((_exports as { hovers?: string[] }).hovers ?? []);
}
