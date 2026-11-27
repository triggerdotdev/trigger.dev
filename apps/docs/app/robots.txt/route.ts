import { docsUrl } from "@/lib/source";

export const dynamic = "force-static";

// Same rules as the previous docs host served at /docs/robots.txt.
export function GET() {
  return new Response(
    [
      "User-agent: *",
      "Content-Signal: ai-train=yes, search=yes, ai-input=yes",
      "Disallow: /cdn-cgi/",
      "Allow: /_next/image",
      "Disallow: /_next/",
      `Sitemap: ${docsUrl}/sitemap.xml`,
      "",
    ].join("\n"),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );
}
