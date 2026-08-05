// The page-context contract the dashboard agent reads: what page the user is on
// and what's notable about it. The schemas and types live in
// `@internal/dashboard-agent-contracts`; this module is the webapp's import
// point for them, so UI code doesn't reach into the contracts package directly.
export type {
  AgentPage,
  AgentPageContext,
  AgentPageSignal,
} from "@internal/dashboard-agent-contracts";
