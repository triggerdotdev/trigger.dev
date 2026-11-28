import { loader } from "fumadocs-core/source";
import type { TOCItemType } from "fumadocs-core/toc";
import type { MDXContent } from "mdx/types";
import { createOpenAPI } from "fumadocs-openapi/server";
import { docs } from "fumadocs-mdx:collections/server";
import { specs } from "@/.generated/openapi.js";
import docsJsonFile from "../../../docs/docs.json";
import { withSchemaExamples } from "./api-reference";
import { parseOpenapiRef } from "./openapi-slice";
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

// `openapi: "v3-openapi GET /api/v1/runs"` frontmatter names the spec by file stem. The specs come
// from the build, not the disk: MCP and Ask AI read API pages at request time, without trigger.dev/docs.
export const openapi = createOpenAPI({ input: specs });

export { parseOpenapiRef };

// Each spec as API pages render it (see withSchemaExamples), made once.
type Spec = Awaited<ReturnType<typeof openapi.getSchema>>["bundled"];
const pageSchemas = new Map<string, Promise<Spec>>();
function pageSchema(document: string) {
  let schema = pageSchemas.get(document);
  if (!schema)
    pageSchemas.set(
      document,
      (schema = openapi.getSchema(document).then((d) => withSchemaExamples(d.bundled)))
    );
  return schema;
}

export type PageApi = NonNullable<Awaited<ReturnType<typeof pageApi>>>;

/** The OpenAPI operation an API page documents, with its spec and required access. */
export async function pageApi(page: DocPage) {
  if (!page.data.openapi) return undefined;
  const api = parseOpenapiRef(page.data.openapi);
  const schema = withApiServer(await pageSchema(api.document));
  const op = operation(schema, api.path, api.method);
  const access = op?.["x-trigger-access"];
  // `x-trigger-access-also`: hand-written scopes the handler checks beyond the route gate.
  const also = Array.isArray(op?.["x-trigger-access-also"]) ? op["x-trigger-access-also"] : [];
  return {
    ...api,
    schema,
    access: typeof access === "string" ? [access, ...also] : null,
    // The endpoint's description, under the playground, unless the page has its own.
    showDescription: !page.data.description,
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
