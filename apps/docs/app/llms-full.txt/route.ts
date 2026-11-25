import { allPages, markdownResponse, pagesText } from "@/lib/agent-markdown";

export const revalidate = false;

export async function GET() {
  return markdownResponse(await pagesText(allPages()), "text/plain");
}
