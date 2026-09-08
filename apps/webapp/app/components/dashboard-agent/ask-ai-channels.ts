/**
 * The dashboard agent owns every AI entry point, including the CLI's `?aiHelp=` deep link.
 */

/** The CLI's link. The agent's deep-link reader is keyed to this name. */
const ASK_AI_DEEP_LINK_PARAM = "aiHelp";

type DeepLinkParam = typeof ASK_AI_DEEP_LINK_PARAM;

// Returned by identity, so the reader's effect doesn't re-run every render.
const AGENT_PARAMS: readonly DeepLinkParam[] = [ASK_AI_DEEP_LINK_PARAM];

/** The agent always reads `aiHelp`. */
export function agentDeepLinkParams(): readonly DeepLinkParam[] {
  return AGENT_PARAMS;
}

/**
 * Where the link lands when the reader has no agent access: nothing in the dashboard would
 * read the deep link, so the question goes to the docs rather than to a page that ignores it.
 */
export function aiHelpDocsUrl(query: string): string {
  const docs = new URL("https://trigger.dev/docs");
  docs.searchParams.set("q", query);
  return docs.toString();
}

/**
 * Where `trigger dev`'s "Ask Trigger about this error" link lands. Always on `origin`: an
 * absolute or protocol-relative `environmentPath` would otherwise decide the host itself, and
 * the caller feeds this straight to `redirect()`.
 */
export function aiHelpRedirectUrl({
  environmentPath,
  origin,
  query,
}: {
  environmentPath: string;
  origin: string;
  query: string;
}): string {
  const base = new URL(origin);
  const requested = new URL(environmentPath, base);
  // Exactly one leading slash: a `javascript:` path has none and would run into the host, and
  // two would read as the start of another authority.
  const path = `/${requested.pathname.replace(/^\/+/, "")}`;
  const url = new URL(base.origin + path + requested.search + requested.hash);
  url.searchParams.set(ASK_AI_DEEP_LINK_PARAM, query);
  return url.toString();
}
