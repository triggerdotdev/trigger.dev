import { useLocation, useMatches } from "@remix-run/react";
import type { AgentPageContext } from "~/components/dashboard-agent/page-context-types";
import type { Handle } from "~/utils/handle";

/**
 * What the dashboard agent knows about the page the user is on.
 *
 * The single exposure mechanism is a route `handle`: a route that wants to
 * describe itself exports
 * `handle = { agentPageContext: (data) => ({ page, signals }) } satisfies Handle`
 * where `data` is that route's loader data. This walks the matches leaf-to-root
 * and uses the deepest mapper that returns something, so a child page overrides
 * its parent. Pages with no mapper fall back to the path.
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
      // A broken mapper must never take the page down with it — fall through.
    }
  }

  return { page: { kind: "other", path: location.pathname }, signals: [] };
}
