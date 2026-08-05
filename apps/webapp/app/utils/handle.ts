import type { ExternalScriptsFunction } from "remix-utils/external-scripts";
import type { AgentPageContext } from "~/components/dashboard-agent/page-context-types";

export type Handle = {
  scripts?: ExternalScriptsFunction;
  /**
   * Describes this page to the dashboard agent. `matchData` is this route's own
   * loader data as it arrives on the route match, so a typedjson route sees the
   * serialized shape. Return undefined to fall through to a parent route's
   * mapper. Read via `useAgentPageContext()`.
   */
  agentPageContext?: (matchData: unknown) => AgentPageContext | undefined;
};
