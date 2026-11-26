import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import {
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/notebook/page";
import { TrackPageActions } from "@/components/analytics";
import { CopyPromptButton } from "@/components/copy-prompt";
import { pageSection } from "@/lib/agent-markdown";
import { isPromptPage } from "@/lib/copy-prompt";
import { PageFeedback } from "@/components/feedback";
import { PageBody } from "@/components/page-body";
import { PageFreshness } from "@/components/page-freshness";
import { pageDescription, pageJsonLd, pageLastModified, pageMetadata } from "@/lib/seo";
import { docsUrl, githubUrl, loadPage, pageApi, source } from "@/lib/source";

type Props = { params: Promise<{ slug: string[] }> };

export default async function Page({ params }: Props) {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  // `url:` stub pages are external links in the nav; Mintlify redirects them too.
  if (page.data.url) redirect(page.data.url);

  const { body: MDX, toc } = await loadPage(page);
  // fumadocs prefixes the /docs basePath itself.
  const markdownUrl = `${page.url}.md`;
  const api = await pageApi(page);
  const promptable = !api && isPromptPage(pageSection(page), await page.data.getText("processed"));

  return (
    <DocsPage toc={toc} full={page.data.full || page.data.mode === "wide" || !!api}>
      <script
        type="application/ld+json"
        // JSON.stringify can't close the script tag: "<" is escaped.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(pageJsonLd(page, await pageDescription(page))).replace(
            /</g,
            "\\u003c"
          ),
        }}
      />
      <header className="flex flex-col gap-2 border-b pb-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <DocsTitle>{page.data.title}</DocsTitle>
          <div className="flex shrink-0 flex-row items-center gap-2 sm:pt-1.5">
            <TrackPageActions path={page.url}>
              <MarkdownCopyButton markdownUrl={markdownUrl} />
              {promptable && (
                <CopyPromptButton
                  path={page.url}
                  title={page.data.title}
                  mdUrl={`${docsUrl}${page.url}.md`}
                />
              )}
              <ViewOptionsPopover
                markdownUrl={markdownUrl}
                pageUrl={`${docsUrl}${page.url}`}
                githubUrl={`${githubUrl}/blob/main/docs/${page.path}`}
              />
            </TrackPageActions>
          </div>
        </div>
        <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      </header>
      <PageBody MDX={MDX} api={api} />
      <PageFeedback path={page.url} />
      <PageFreshness path={page.path} updated={pageLastModified(page)} />
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  return pageMetadata(page);
}
