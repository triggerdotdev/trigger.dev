import type { ExternalScriptsFunction } from "remix-utils/external-scripts";
import type { AgentPageContext } from "~/components/dashboard-agent/page-context-types";

/** The shape of a route's `handle` export. */
export type Handle = {
  scripts?: ExternalScriptsFunction;
  /**
   * Describe this page to the dashboard agent. `matchData` is this route's own
   * loader data as it arrives on the route match (so a typedjson route sees the
   * serialized shape). The mapper turns it into page facts the loader already
   * computed — no extra queries. Return undefined to fall through to a parent
   * route's mapper. Read via `useAgentPageContext()`.
   */
  agentPageContext?: (matchData: unknown) => AgentPageContext | undefined;
};
