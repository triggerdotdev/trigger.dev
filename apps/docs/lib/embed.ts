import { basePath } from "./base-path";

// The docs embedded in the dashboard: /docs/embed/<page> is the page body alone, for an iframe.

/** Query params an embed page keeps as the reader moves between pages. */
const KEPT = ["project", "theme"];

type EmbedLink = { embed: string } | { hash: string } | { target: "_top" | "_blank" } | null;

/**
 * Where a link clicked inside an embed page goes: another docs page stays in the embed (`embed` is
 * its path under the /docs base path), the dashboard replaces the dashboard tab, anything else opens
 * a new tab. A section of the page already showing is `hash`, so EmbedFrame can report it (a
 * router navigation fires no `hashchange`). null leaves the click alone (other embed URLs).
 */
export function embedLink(href: string, current: string, dashboardOrigin: string): EmbedLink {
  const url = new URL(href, current);
  const here = new URL(current);
  if (url.origin === new URL(dashboardOrigin).origin) return { target: "_top" };
  if (url.origin !== here.origin || !url.pathname.startsWith(`${basePath}/`))
    return { target: "_blank" };
  const samePage = (u: URL) => u.pathname === here.pathname && u.search === here.search;
  if (url.pathname.startsWith(`${basePath}/embed/`)) {
    return samePage(url) && url.hash ? { hash: url.hash } : null;
  }
  // Routes and files (search, markdown, images) aren't pages.
  if (url.pathname.startsWith(`${basePath}/api/`) || /\.[a-z0-9]+$/i.test(url.pathname)) {
    return { target: "_blank" };
  }
  for (const key of KEPT) {
    const value = here.searchParams.get(key);
    if (value && !url.searchParams.has(key)) url.searchParams.set(key, value);
  }
  const embed = `/embed${url.pathname.slice(basePath.length)}${url.search}${url.hash}`;
  if (url.hash && samePage(new URL(`${basePath}${embed}`, here))) return { hash: url.hash };
  return { embed };
}

/** Sent to the parent window on every embed page, so the dashboard panel can show the title. */
// Read by apps/webapp/app/components/DocsPanel.tsx: keep the two types in step.
export type EmbedPageMessage = { type: "trigger-docs:page"; title: string; path: string };

/** The message for the page showing in the embed, with the section (`#hash`) the reader is on. */
export function embedPageMessage(title: string, path: string, hash: string): EmbedPageMessage {
  return { type: "trigger-docs:page", title, path: `${path}${hash}` };
}

// Before the first paint: `?theme=` wins over the reader's saved docs theme (next-themes' script
// ran just before this one). DocsRootProvider keeps it forced after hydration.
export const embedThemeScript = `try{var t=new URLSearchParams(location.search).get("theme");if(t==="dark"||t==="light"){var d=document.documentElement;d.classList.remove("dark","light");d.classList.add(t);d.style.colorScheme=t}}catch(e){}`;
