import type { AgentPageContext } from "@internal/dashboard-agent-contracts";
import type { RepoSnapshot } from "./repo-tools";
import type { InvestigationsCapability } from "./tool-investigations";

/**
 * The agent is firewalled from the main database: every tool reads through the public
 * API as the user. Tools return `{ error }` on failure rather than throwing.
 */

// Injected server-side by the `in` proxy. All optional: a turn with no token gets
// tools that fail closed.
export type DashboardAgentToolContext = {
  userActorToken?: string;
  apiOrigin?: string;
  projectRef?: string;
  // Canonical API env name (dev/staging/prod/preview), resolved by the proxy.
  environmentName?: string;
  // Set when the current environment is a branch. The name-addressed routes resolve to the
  // parent without it, so a branch-scoped token would be refused there.
  environmentBranch?: string;
  // RuntimeEnvironment id: the `{env}` component of every trigger:// URI this turn
  // emits. Names and slugs must never appear in a URI.
  environmentId?: string;
  // The dashboard path the user is on, passed as context to ask_support.
  currentPage?: string;
  chatId?: string;
  // Structured view of the same page, when the host could classify it.
  pageContext?: AgentPageContext;
  // Present only when the project has a connected GitHub repo. Adds the source tools.
  repoSnapshot?: RepoSnapshot;
  investigations?: InvestigationsCapability;
};
