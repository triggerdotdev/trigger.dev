import { anthropic } from "@ai-sdk/anthropic";
import { pageMarkdown } from "@/lib/agent-markdown";
import { createAskHandler } from "@/lib/ask";
import { askEnabled, askModel } from "@/lib/ask-config";
import { listedPages } from "@/lib/nav";
import { limiterFromEnv } from "@/lib/ask-rate-limit";
import { searcher } from "@/lib/search";
import { excerpt } from "@/lib/search-core";
import { docsUrl, pageFromPath } from "@/lib/source";

export const maxDuration = 60;

function pageIndex() {
  const lines: string[] = [];
  let section = "";
  for (const { heading, page } of listedPages()) {
    if (heading !== section) lines.push(`## ${(section = heading)}`);
    lines.push(`${page.url}: ${page.data.title}`);
  }
  return lines.join("\n");
}

const limiter = limiterFromEnv();
if (askEnabled() && !limiter)
  console.warn("Ask AI: REDIS_URL is not set, so rate limits are off (local only).");

const handler = askEnabled()
  ? createAskHandler({
      model: anthropic(askModel()),
      limiter,
      proxySecret: process.env.DOCS_WORKER_SECRET || undefined,
      pageIndex: pageIndex(),
      search: (query) =>
        searcher.search(query, { limit: 6 }).map(({ page, sections }) => ({
          title: page.title,
          url: `${docsUrl}${page.url}`,
          description: page.description,
          sections: sections.map((s) => ({
            id: s.id,
            heading: s.heading,
            excerpt: excerpt(s.text, query, 700),
          })),
        })),
      async readPage(input) {
        const page = pageFromPath(input);
        if (!page || page.data.url) return undefined;
        return {
          title: page.data.title,
          url: `${docsUrl}${page.url}`,
          markdown: await pageMarkdown(page),
        };
      },
    })
  : undefined;

export function POST(req: Request) {
  if (!handler) return new Response("Ask AI is not configured.", { status: 404 });
  return handler(req);
}
