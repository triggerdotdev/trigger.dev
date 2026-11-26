import { loader } from "fumadocs-core/source";
import type { TOCItemType } from "fumadocs-core/toc";
import type { MDXContent } from "mdx/types";
import { createOpenAPI } from "fumadocs-openapi/server";
import path from "node:path";
import { docs } from "fumadocs-mdx:collections/server";
import docsJsonFile from "../../../docs/docs.json";
import { contentDir } from "./content-files";
import { redirectTarget } from "./slug";

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

const { redirects = [] } = docsJsonFile as {
  redirects?: { source: string; destination: string }[];
};

/** The page at a docs path or URL (`/docs/queues#limits`, `https://trigger.dev/docs/queues.md`,
 * `queues`), following docs.json redirects from old paths. */
export function pageFromPath(input: string) {
  const slug = input
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\/?docs\//, "")
    .replace(/[#?].*$/, "")
    .replace(/\.mdx?$/, "")
    .split("/")
    .filter(Boolean);
  const moved = redirectTarget(`/${slug.join("/")}`, redirects);
  return (
    source.getPage(slug) ?? (moved ? source.getPage(moved.split("/").filter(Boolean)) : undefined)
  );
}

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

/** The OpenAPI operation an API page documents, with its spec and required access. */
export async function pageApi(page: DocPage) {
  if (!page.data.openapi) return undefined;
  const api = parseOpenapiRef(page.data.openapi);
  const schema = withApiServer((await openapi.getSchema(api.document)).bundled);
  const op = operation(schema, api.path, api.method);
  const access = op?.["x-trigger-access"];
  // `x-trigger-access-also`: hand-written scopes the handler checks beyond the route gate.
  const also = Array.isArray(op?.["x-trigger-access-also"]) ? op["x-trigger-access-also"] : [];
  return {
    ...api,
    schema,
    access: typeof access === "string" ? [access, ...also] : null,
    // Only a personal access token works: every listed alternative is `personalAccessToken` (the
    // env var operations also take a project's API key, so they keep the API keys link).
    pat:
      Array.isArray(op?.security) &&
      op.security.length > 0 &&
      op.security.every((s) => "personalAccessToken" in s),
  };
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

// The operation object. Its `x-trigger-access` is what a key needs to call it (checked against the routes).
function operation(doc: object, path: string, method: string) {
  type Op = {
    "x-trigger-access"?: unknown;
    "x-trigger-access-also"?: string[];
    security?: Record<string, unknown>[];
  };
  const paths = (doc as { paths?: Record<string, Record<string, Op>> }).paths;
  return paths?.[path]?.[method.toLowerCase()];
}
