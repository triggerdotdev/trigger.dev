import type { Folder, Item, Node, Root } from "fumadocs-core/page-tree";
import { createElement, Fragment } from "react";
import docsJsonFile from "../../../docs/docs.json";
import { parseOpenapiRef, source } from "./source";

// The sidebar is read straight from docs.json, the one nav file writers edit today.
type NavEntry = string | NavGroup;
type NavGroup = { group: string; pages: NavEntry[]; hidden?: boolean; expanded?: boolean };
type Dropdown = { dropdown: string; description?: string; icon?: string; groups: NavGroup[] };

// Imported, not read from disk, so the build bundles it.
const docsJson = docsJsonFile as unknown as {
  navigation: { dropdowns: Dropdown[] };
};

/** The top-level docs sections (docs.json dropdowns), in nav order. */
export const sections = docsJson.navigation.dropdowns.map((d) => d.dropdown);

// The colors of fumadocs-openapi's method labels, which it only adds to trees it builds itself.
const methodColors: Record<string, string> = {
  GET: "text-green-600 dark:text-green-400",
  POST: "text-blue-600 dark:text-blue-400",
  PUT: "text-yellow-600 dark:text-yellow-400",
  PATCH: "text-orange-600 dark:text-orange-400",
  DELETE: "text-red-600 dark:text-red-400",
};

/** An API page's sidebar name, with its HTTP method after it. */
function withMethod(name: string, openapi: string | undefined) {
  if (!openapi) return name;
  const method = parseOpenapiRef(openapi).method.toUpperCase();
  const color = methodColors[method] ?? "text-fd-muted-foreground";
  return createElement(
    Fragment,
    null,
    name,
    " ",
    createElement(
      "span",
      { className: `ms-auto font-mono text-xs font-medium text-nowrap ${color}` },
      method
    )
  );
}

function pageItem(slug: string, section: string): Item | undefined {
  const page = source.getPage(slug.split("/"));
  if (!page) {
    console.warn(`[nav] docs.json lists "${slug}" but there is no page`);
    return;
  }
  if (page.data.hidden) return;
  const name = page.data.sidebarTitle ?? page.data.title;
  if (page.data.url) return { type: "page", name, url: page.data.url, external: true };
  return { type: "page", name: withMethod(name, page.data.openapi), url: page.url };
}

function entries(list: NavEntry[], section: string): Node[] {
  return list.flatMap((e): Node[] => {
    if (typeof e === "string") {
      const item = pageItem(e, section);
      return item ? [item] : [];
    }
    const children = entries(e.pages, section);
    if (e.hidden || children.length === 0) return [];
    return [{ type: "folder", name: e.group, defaultOpen: e.expanded, children } satisfies Folder];
  });
}

// Top-level groups render as section headings (like Mintlify), nested groups as folders.
export const pageTree: Root = {
  name: "Trigger.dev",
  children: docsJson.navigation.dropdowns.map((d): Folder => ({
    type: "folder",
    name: d.dropdown,
    description: d.description,
    root: true,
    children: d.groups.flatMap((g): Node[] => {
      const children = entries(g.pages, d.dropdown);
      if (g.hidden || children.length === 0) return [];
      return [{ type: "separator", name: g.group }, ...children];
    }),
  })),
};

/** Pages in nav order, for llms.txt. */
export function navPages(): { section: string; group: string; slug: string }[] {
  const out: { section: string; group: string; slug: string }[] = [];
  const walk = (list: NavEntry[], section: string, group: string) => {
    for (const e of list) {
      if (typeof e === "string") out.push({ section, group, slug: e });
      else walk(e.pages, section, group);
    }
  };
  for (const d of docsJson.navigation.dropdowns)
    for (const g of d.groups) walk(g.pages, d.dropdown, g.group);
  return out;
}

/** Pages agents and Ask AI list, in nav order, each under its `Section: Group` heading (link-only pages left out). */
export function listedPages() {
  return navPages().flatMap(({ section, group, slug }) => {
    const page = source.getPage(slug.split("/"));
    return page && !page.data.url ? [{ heading: `${section}: ${group}`, page }] : [];
  });
}

const firstUrl = (nodes: Node[]): string | undefined => {
  for (const n of nodes) {
    if (n.type === "page" && !n.external) return n.url;
    if (n.type === "folder") {
      const u = n.index?.url ?? firstUrl(n.children);
      if (u) return u;
    }
  }
};

const allUrls = (nodes: Node[], out = new Set<string>()): Set<string> => {
  for (const n of nodes) {
    if (n.type === "page") out.add(n.url);
    if (n.type === "folder") {
      if (n.index) out.add(n.index.url);
      allUrls(n.children, out);
    }
  }
  return out;
};

// One top-level tab per section, as plain links with their page set: fumadocs'
// folder-bound tabs mislabel the Guides tab once the tree is serialized to the client.
export const sectionTabs = (pageTree.children as Folder[]).map((f) => ({
  title: f.name,
  description: f.description,
  url: firstUrl(f.children) ?? "/",
  urls: allUrls(f.children),
}));

/** Sidebar page URLs in nav order. */
export const navUrls = sectionTabs.flatMap((t) => [...t.urls]);
