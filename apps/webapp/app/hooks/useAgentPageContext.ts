import { useLocation, useMatches } from "@remix-run/react";
import type { AgentPageContext } from "~/components/dashboard-agent/page-context-types";
import type { Handle } from "~/utils/handle";

/**
 * The page context the dashboard agent sees. Routes opt in with `handle = { agentPageContext }`.
 * The deepest mapper that returns something wins; pages with no mapper fall back to the path.
 */
export function useAgentPageContext(): AgentPageContext {
  const matches = useMatches();
  const location = useLocation();

  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const mapper = (match.handle as Handle | undefined)?.agentPageContext;
    if (typeof mapper !== "function") continue;
    try {
      const context = mapper(match.data);
      if (context) return context;
    } catch {
      // A broken mapper must not take the page down with it.
    }
  }

  return { page: { kind: "other", path: location.pathname }, signals: [] };
}
