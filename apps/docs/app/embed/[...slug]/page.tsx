import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { DocsDescription, DocsTitle } from "fumadocs-ui/layouts/notebook/page";
import { EmbedFrame } from "@/components/embed";
import { PageBody } from "@/components/page-body";
import { loadPage, pageApi, source } from "@/lib/source";

type Props = { params: Promise<{ slug: string[] }> };

/** A docs page's body alone, for the dashboard's docs panel. */
export default async function EmbedPage({ params }: Props) {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  // Link-only pages (GitHub, the changelog) refuse to load in a frame, so link out instead.
  if (page.data.url)
    return (
      <EmbedFrame title={page.data.title} path={page.url}>
        <article className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-5 py-5">
          <DocsTitle className="text-2xl">{page.data.title}</DocsTitle>
          <p className="text-fd-muted-foreground">This page is on another site.</p>
          <a
            href={page.data.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1.5 rounded-md bg-fd-primary px-3 py-1.5 text-sm font-medium text-fd-primary-foreground hover:bg-fd-primary/85"
          >
            Open {page.data.title}
            <ExternalLink className="size-3.5" />
          </a>
        </article>
      </EmbedFrame>
    );

  const { body: MDX } = await loadPage(page);
  const api = await pageApi(page);

  return (
    <EmbedFrame title={page.data.title} path={page.url}>
      <article className="mx-auto flex w-full max-w-[860px] flex-col gap-6 px-5 py-5">
        <header className="flex flex-col gap-2 border-b pb-5">
          {/* The panel header links out, and tracks in-panel navigation, so no link here. */}
          <DocsTitle className="text-2xl">{page.data.title}</DocsTitle>
          <DocsDescription className="mb-0 text-base">{page.data.description}</DocsDescription>
        </header>
        <PageBody MDX={MDX} api={api} />
      </article>
    </EmbedFrame>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  return { title: page.data.title };
}
