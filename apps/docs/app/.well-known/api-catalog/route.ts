import { docsUrl, siteUrl } from "@/lib/source";

export const dynamic = "force-static";

// RFC 9727 API catalog: the REST API, its OpenAPI description and its docs.
export function GET() {
  return Response.json(
    {
      linkset: [
        {
          anchor: `${siteUrl}/api`,
          "service-desc": [{ href: `${docsUrl}/v3-openapi.yaml`, type: "application/yaml" }],
          "service-doc": [{ href: `${docsUrl}/management/overview`, type: "text/html" }],
        },
      ],
    },
    { headers: { "Content-Type": "application/linkset+json" } }
  );
}
