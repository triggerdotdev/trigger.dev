import type { ExternalScriptsFunction } from "remix-utils/external-scripts";
import type { AgentPageContext } from "~/components/dashboard-agent/page-context-types";

export type Handle = {
  scripts?: ExternalScriptsFunction;
  // `matchData` is raw route match data, so a typedjson route sees the serialized shape.
  // Return undefined to fall through to the parent.
  agentPageContext?: (matchData: unknown) => AgentPageContext | undefined;
};
