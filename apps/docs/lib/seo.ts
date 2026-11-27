import type { Metadata } from "next";
import { lastmod } from "@/.generated/lastmod.js";
import { navPages, sectionTabs } from "./nav";
import { plainText } from "./plain-text";
import { docsUrl, openapi, parseOpenapiRef, siteUrl, type DocPage } from "./source";

/** The page's meta description: frontmatter, or for API pages the operation's description, as text. */
export async function pageDescription(page: DocPage) {
  if (page.data.description) return plainText(page.data.description);
  if (!page.data.openapi) return undefined;
  const { document, method, path } = parseOpenapiRef(page.data.openapi);
  const spec = (await openapi.getSchema(document)).bundled as {
    paths?: Record<string, Record<string, { description?: string; summary?: string }>>;
  };
  const op = spec.paths?.[path]?.[method];
  return plainText(op?.description ?? op?.summary);
}

export const pageLastModified = (page: DocPage): string | undefined => lastmod[page.path];

const nav = new Map(navPages().map((p) => [p.slug, p]));
const organizationId = `${siteUrl}/#organization`;
const websiteId = `${docsUrl}#website`;
const website = {
  "@type": "WebSite",
  "@id": websiteId,
  name: "Trigger.dev",
  url: docsUrl,
  publisher: { "@id": organizationId },
};

/** schema.org graph for a page, with the same nodes live publishes. */
export function pageJsonLd(page: DocPage, description: string | undefined) {
  const url = `${docsUrl}${page.url}`;
  const name = page.data.title;
  const dateModified = pageLastModified(page);
  const section = sectionTabs.find((t) => t.title === nav.get(page.slugs.join("/"))?.section);
  // Every crumb but the last needs a URL; groups have none, so it's docs > section > page.
  const crumbs = [
    { name: "Trigger.dev", item: docsUrl },
    ...(section && section.url !== page.url
      ? [{ name: String(section.title), item: `${docsUrl}${section.url}` }]
      : []),
    { name, item: url },
  ];
  return [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          "@id": organizationId,
          name: "Trigger.dev",
          url: siteUrl,
          logo: { "@type": "ImageObject", url: `${docsUrl}/logo/dark.png` },
        },
        website,
        {
          "@type": "WebPage",
          "@id": `${url}#webpage`,
          url,
          name,
          description,
          dateModified,
          isPartOf: { "@id": websiteId },
          breadcrumb: { "@id": `${url}#breadcrumb` },
        },
        {
          "@type": "BreadcrumbList",
          "@id": `${url}#breadcrumb`,
          itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, ...c })),
        },
        {
          "@type": ["Article", "TechArticle"],
          "@id": `${url}#article`,
          headline: name,
          name,
          description,
          url,
          mainEntityOfPage: { "@id": `${url}#webpage` },
          dateModified,
          publisher: { "@id": organizationId },
          isPartOf: { "@id": websiteId },
        },
      ],
    },
    // Live also publishes the site on its own; kept so the page carries the same two blocks.
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Trigger.dev",
      url: docsUrl,
      publisher: { "@type": "Organization", name: "Trigger.dev", url: siteUrl },
    },
  ];
}

/** Next metadata for a page: title, description, canonical URL, robots, Open Graph and Twitter. */
export async function pageMetadata(page: DocPage): Promise<Metadata> {
  const url = `${docsUrl}${page.url}`;
  const title = `${page.data.title} - Trigger.dev`;
  const description = await pageDescription(page);
  // The social image is served by app/og/[...slug]/route.tsx.
  const image = {
    url: `${docsUrl}/og/${[...page.slugs, "image.png"].join("/")}`,
    width: 1200,
    height: 630,
  };
  return {
    title: page.data.title,
    description,
    alternates: { canonical: url },
    // Hidden pages are only left out of the nav; `noindex: true` keeps a page out of search.
    robots: page.data.noindex ? { index: false } : undefined,
    openGraph: {
      title,
      description,
      siteName: "Trigger.dev",
      url,
      type: "website",
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}
