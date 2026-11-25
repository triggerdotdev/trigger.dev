import { loader } from "fumadocs-core/source";
import type { TOCItemType } from "fumadocs-core/toc";
import type { MDXContent } from "mdx/types";
import { createOpenAPI } from "fumadocs-openapi/server";
import path from "node:path";
import { docs } from "fumadocs-mdx:collections/server";
import { contentDir } from "./content-files";

export const siteUrl = "https://trigger.dev";
export const docsUrl = `${siteUrl}/docs`;
export const githubUrl = "https://github.com/triggerdotdev/trigger.dev";

// Pages are routed by file path relative to trigger.dev/docs, exactly like Mintlify.
// baseUrl is "/" because Next adds the /docs basePath.
export const source = loader({
  baseUrl: "/",
  source: docs.toFumadocsSource(),
});

export type DocPage = NonNullable<ReturnType<typeof source.getPage>>;

type LoadedPage = { body: MDXContent; toc: TOCItemType[]; _exports: Record<string, unknown> };

/** A page's compiled body: loaded on demand in builds, already there in dev (source.config.ts `async`). */
export function loadPage(page: DocPage): Promise<LoadedPage> {
  const data = page.data as unknown as LoadedPage & { load?: () => Promise<LoadedPage> };
  return data.load ? data.load() : Promise.resolve(data);
}

// `openapi: "v3-openapi GET /api/v1/runs"` frontmatter names the spec by file stem.
export const openapi = createOpenAPI({
  input: {
    openapi: path.join(contentDir, "openapi.yml"),
    "v3-openapi": path.join(contentDir, "v3-openapi.yaml"),
  },
});

export function parseOpenapiRef(ref: string) {
  const [spec, method, ...rest] = ref.trim().split(/\s+/);
  const document = spec!.replace(/\.(ya?ml|json)$/, "");
  return { document, method: method!.toLowerCase(), path: rest.join(" ") };
}

export type PageApi = NonNullable<Awaited<ReturnType<typeof pageApi>>>;

/** The OpenAPI operation an API page documents, with its spec. */
export async function pageApi(page: DocPage) {
  if (!page.data.openapi) return undefined;
  const api = parseOpenapiRef(page.data.openapi);
  const schema = withApiServer((await openapi.getSchema(api.document)).bundled);
  return { ...api, schema };
}

// A local or self-hosted API for the playground to call, listed before the spec's servers.
function withApiServer<T extends { servers?: { url?: string; description?: string }[] }>(
  doc: T
): T {
  const url = process.env.DOCS_API_SERVER_URL;
  return url
    ? { ...doc, servers: [{ url, description: "This environment" }, ...(doc.servers ?? [])] }
    : doc;
}
