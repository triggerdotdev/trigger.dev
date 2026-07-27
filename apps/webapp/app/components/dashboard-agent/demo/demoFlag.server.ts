/**
 * Demo-mode gating.
 *
 * An env var, not a feature flag: demo mode is a local review tool, not a
 * rollout. A per-org flag would mean a migration-free but user-visible switch on
 * a production org, which is exactly what we don't want for a screen full of
 * fabricated runs. `DASHBOARD_AGENT_DEMO=1` in `apps/webapp/.env` is the whole
 * mechanism.
 *
 * It is deliberately independent of `canAccessDashboardAgent`: the panel still
 * has to be reachable (so demo mode inherits that gate for free via the layout
 * loader), but a reviewer must not need agent access, an Anthropic key, or a
 * deployed agent task to look at the mockup.
 *
 * This is the ONLY server-side file under `demo/`. Nothing else in the directory
 * imports it, so the demo module graph stays free of server modules — the
 * isolation test asserts that.
 */
import { env } from "~/env.server";

export function isDashboardAgentDemoEnabled(): boolean {
  return env.DASHBOARD_AGENT_DEMO === "1";
}
