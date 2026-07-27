// The page-context contract the dashboard agent reads: what page the user is on
// and what's notable about it. Pages emit facts their loaders already computed,
// so producing this costs no extra queries.
//
// The schemas + types live in `@internal/dashboard-agent-contracts`; this module
// is the webapp's import point for them, so UI code doesn't reach into the
// contracts package directly.
export type {
  AgentPage,
  AgentPageContext,
  AgentPageSignal,
} from "@internal/dashboard-agent-contracts";
