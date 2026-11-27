import type { MetadataRoute } from "next";
import { pageLastModified } from "@/lib/seo";
import { docsUrl, source } from "@/lib/source";

export const revalidate = false;

// Hidden pages are in the sitemap like on live; only `noindex: true` pages and nav-only stubs are not.
export default function sitemap(): MetadataRoute.Sitemap {
  return source
    .getPages()
    .filter((p) => !p.data.url && !p.data.noindex)
    .map((p) => ({ url: `${docsUrl}${p.url}`, lastModified: pageLastModified(p) }));
}
