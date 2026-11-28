import { pageImports, snippets } from "@/.generated/snippets.js";
import { agentMarkdown } from "./agent-mdx";
import { sectionFile } from "./agent-surface";
import { queryChoices, type Chosen } from "./choices";
import { expandDashboardFigures } from "./dashboard-figures";
import type { Folder, Node } from "fumadocs-core/page-tree";
import { navPages, pageTree, sections } from "./nav";
import { expandSdkTypes } from "./sdk-type-table";
import { pageLastModified } from "./seo";
import { inlineSnippets } from "./snippets";
import { operationSlice } from "./openapi-slice";
import { docsUrl, openapi, parseOpenapiRef, source, type DocPage } from "./source";
import { selectVariants } from "./variants";

/** `?pm=` / `?framework=` from a request; empty when neither names a known option. */
export const requestChoices = (req: Request) => queryChoices(new URL(req.url).searchParams);

type NavLink = { title: string; url: string };
type NavPlace = {
  section: string;
  group: string;
  previous?: NavLink;
  next?: NavLink;
  siblings: NavLink[];
};

// Where each page sits in the sidebar (visible pages, in order), keyed by page URL.
let places: Map<string, NavPlace> | undefined;
function navPlace(page: DocPage) {
  if (!places) {
    places = new Map();
    const listed: { section: string; group: string; link: NavLink; url: string }[] = [];
    const walk = (nodes: Node[], section: string, group: { name: string }) => {
      for (const n of nodes) {
        if (n.type === "separator") group.name = String(n.name ?? "");
        else if (n.type === "page" && !n.external) {
          const p = source.getPage(n.url.split("/").filter(Boolean));
          if (p) listed.push({ section, group: group.name, url: p.url, link: link(p) });
        } else if (n.type === "folder") walk(n.children, section, group);
      }
    };
    const link = (p: DocPage): NavLink => ({ title: p.data.title, url: `${docsUrl}${p.url}` });
    for (const f of pageTree.children as Folder[]) walk(f.children, String(f.name), { name: "" });
    listed.forEach((n, i) => {
      if (places!.has(n.url)) return;
      const prev = listed[i - 1]?.section === n.section ? listed[i - 1] : undefined;
      const next = listed[i + 1]?.section === n.section ? listed[i + 1] : undefined;
      places!.set(n.url, {
        section: n.section,
        group: n.group,
        previous: prev?.link,
        next: next?.link,
        siblings: listed
          .filter(
            (s) =>
              s.section === n.section &&
              s.group === n.group &&
              ![n.url, prev?.url, next?.url].includes(s.url)
          )
          .slice(0, 10)
          .map((s) => s.link),
      });
    });
  }
  return places.get(page.url);
}

/** The page's top-level docs section (a docs.json dropdown), when it's in the nav. */
export const pageSection = (page: DocPage) => navPlace(page)?.section;

// JSON strings are valid YAML scalars, so titles with colons or quotes need no special casing.
const y = (v: string) => JSON.stringify(v);

/** Frontmatter for agents: what the page is, where it lives, when it changed, and what's next to it. */
function pageFrontmatter(page: DocPage) {
  const place = navPlace(page);
  const updated = pageLastModified(page);
  const lines = [`title: ${y(page.data.title)}`];
  if (page.data.description) lines.push(`description: ${y(page.data.description)}`);
  lines.push(`url: ${y(`${docsUrl}${page.url}`)}`);
  if (updated) lines.push(`last_updated: ${updated.slice(0, 10)}`);
  if (place) {
    lines.push(`section: ${y(place.section)}`, `group: ${y(place.group)}`);
    const related = [
      ...(place.previous ? [{ ...place.previous, rel: "previous" }] : []),
      ...(place.next ? [{ ...place.next, rel: "next" }] : []),
      ...place.siblings.map((s) => ({ ...s, rel: "sibling" })),
    ];
    if (related.length) {
      lines.push("related:");
      for (const r of related)
        lines.push(`  - title: ${y(r.title)}`, `    url: ${y(r.url)}`, `    rel: ${r.rel}`);
    }
  }
  return `---\n${lines.join("\n")}\n---\n\n`;
}

/**
 * The markdown an agent gets for a page: title, description and the body with snippets, SDK type
 * tables and dashboard figure descriptions inlined, keeping only the `chosen` variant of each tab group,
 * then components turned into plain markdown with absolute links (lib/agent-mdx.ts).
 */
export async function pageMarkdown(page: DocPage, chosen: Chosen = {}) {
  // Snippet sources come from the build, not the disk: the deployed app has no trigger.dev/docs.
  const body = expandDashboardFigures(
    expandSdkTypes(
      inlineSnippets(await page.data.getText("processed"), pageImports[page.path] ?? "", snippets)
    )
  );
  const api = await apiMarkdown(page);
  const description = page.data.description ?? api?.description;
  const head = [`# ${page.data.title}`, description ? `> ${description}` : ""];
  const parts = [...head.filter(Boolean), "", body, ...(api ? ["", api.markdown] : [])];
  return agentMarkdown(selectVariants(parts.join("\n"), chosen), {
    docsUrl,
    pageUrl: page.url,
    pagePath: page.path,
    external: externalPages(),
  });
}

/** An API page's endpoint as an OpenAPI section (its body is only the playground component). */
async function apiMarkdown(page: DocPage) {
  if (!page.data.openapi) return undefined;
  const { document, method, path } = parseOpenapiRef(page.data.openapi);
  const spec = (await openapi.getSchema(document)).bundled as Parameters<typeof operationSlice>[0];
  const slice = operationSlice(spec, path, method);
  if (!slice) return undefined;
  const op = spec.paths?.[path]?.[method] as { description?: string; summary?: string };
  return {
    description: op.description ?? op.summary,
    markdown: `## OpenAPI\n\n\`\`\`\`json ${page.data.openapi.trim()}\n${JSON.stringify(slice, null, 2)}\n\`\`\`\``,
  };
}

/** A page's `.md`: agent frontmatter, then the page markdown. */
export async function pageMd(page: DocPage, chosen: Chosen = {}) {
  return pageFrontmatter(page) + (await pageMarkdown(page, chosen));
}

/** Pages joined for llms-full files. */
export async function pagesText(pages: DocPage[], chosen: Chosen = {}) {
  const parts = await Promise.all(
    pages.map(async (p) => `${await pageMarkdown(p, chosen)}\n\nSource: ${docsUrl}${p.url}`)
  );
  return parts.join("\n\n---\n\n");
}

export const markdownResponse = (body: string, type = "text/markdown", cacheControl?: string) =>
  new Response(body, {
    headers: {
      "Content-Type": `${type}; charset=utf-8`,
      ...(cacheControl ? { "Cache-Control": cacheControl } : {}),
      // A page's markdown twin stays out of search results; its URL may also serve the HTML page.
      ...(type === "text/markdown" ? { "X-Robots-Tag": "noindex", Vary: "Accept" } : {}),
    },
  });

/** Pages for /llms-full.txt. */
let external: Map<string, string> | undefined;
/** Stub pages whose `url` frontmatter sends readers elsewhere (e.g. /community to Discord). */
const externalPages = () =>
  (external ??= new Map(
    source.getPages().flatMap((p) => (p.data.url ? [[p.url, p.data.url] as const] : []))
  ));

export const allPages = () => source.getPages().filter((p) => !p.data.url);

/** Pages of one docs section (a top-level tab), or undefined for an unknown section file name. */
export function sectionPages(file: string) {
  const name = sections.find((s) => sectionFile(s) === file);
  if (!name) return undefined;
  return navPages()
    .filter((p) => p.section === name)
    .map((p) => source.getPage(p.slug.split("/")))
    .filter((p): p is DocPage => !!p && !p.data.url);
}
