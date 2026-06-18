import { SparklesIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { useFeatureFlags } from "~/hooks/useFeatureFlags";
import { useHasAdminAccess } from "~/hooks/useUser";
import { DashboardAgentPanel } from "./DashboardAgentPanel";

/**
 * Mount point for the dashboard agent. Rendered as the trailing flex child of
 * the env-scoped layout: when open it's a 380px side panel that pushes content;
 * when closed it's a floating launcher. The panel only mounts while open, so the
 * chat transport isn't created until the user opens it.
 *
 * Gated behind the `hasDashboardAgentAccess` flag (org override or global
 * default), with admins/impersonators always allowed. The resource route
 * enforces the same check server-side.
 */
export function DashboardAgent() {
  const hasAdminAccess = useHasAdminAccess();
  const { hasDashboardAgentAccess } = useFeatureFlags();
  const [open, setOpen] = useState(false);

  if (!hasAdminAccess && !hasDashboardAgentAccess) {
    return null;
  }

  if (open) {
    return <DashboardAgentPanel onClose={() => setOpen(false)} />;
  }

  return (
    <button
      type="button"
      aria-label="Open the dashboard agent"
      onClick={() => setOpen(true)}
      className="fixed bottom-4 right-4 z-40 flex items-center gap-1.5 rounded-full border border-charcoal-650 bg-background-bright px-3.5 py-2 text-sm text-text-bright shadow-lg transition hover:border-charcoal-550"
    >
      <SparklesIcon className="size-4 text-indigo-500" />
      Ask the agent
    </button>
  );
}
