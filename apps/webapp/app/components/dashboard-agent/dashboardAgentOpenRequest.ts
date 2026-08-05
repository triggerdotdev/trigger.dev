import { useEffect, useSyncExternalStore } from "react";
import { useSearchParams } from "@remix-run/react";

// Module-level bridge: `DashboardAgentProvider` is mounted by the environment layout, so
// callers above it cannot reach the agent through context.

export type DashboardAgentOpenRequest = {
  /** Omitted just opens the panel. */
  prompt?: string;
};

type Handler = (request: DashboardAgentOpenRequest) => void;

const handlers = new Set<Handler>();
const availabilityListeners = new Set<() => void>();

function notifyAvailability() {
  for (const listener of availabilityListeners) listener();
}

/** Returns the unsubscribe. */
export function registerDashboardAgentHost(handler: Handler): () => void {
  handlers.add(handler);
  notifyAvailability();
  return () => {
    handlers.delete(handler);
    notifyAvailability();
  };
}

/** Returns false when no host is mounted. */
export function requestDashboardAgent(prompt?: string): boolean {
  if (handlers.size === 0) return false;
  for (const handler of handlers) handler({ prompt });
  return true;
}

function subscribeToAvailability(listener: () => void): () => void {
  availabilityListeners.add(listener);
  return () => availabilityListeners.delete(listener);
}

export function useDashboardAgentAvailable(): boolean {
  return useSyncExternalStore(
    subscribeToAvailability,
    () => handlers.size > 0,
    // The host mounts client-side only, so the server snapshot is always unavailable.
    () => false
  );
}

/** `aiHelp` is legacy: the CLI's old links are still in people's terminal scrollback. */
const DEEP_LINK_PARAMS = ["ask", "aiHelp"] as const;

/** While `enabled` is false nothing is registered, so every entry point stays hidden. */
export function useDashboardAgentOpenRequests({
  enabled,
  openWith,
  setOpen,
}: {
  enabled: boolean;
  openWith: (text: string) => void;
  setOpen: (open: boolean) => void;
}) {
  useEffect(() => {
    if (!enabled) return;
    return registerDashboardAgentHost(({ prompt }) => (prompt ? openWith(prompt) : setOpen(true)));
  }, [enabled, openWith, setOpen]);

  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (!enabled) return;
    const param = DEEP_LINK_PARAMS.find((name) => searchParams.get(name));
    if (!param) return;
    const question = searchParams.get(param)!;
    // Consume it before opening, or a re-render asks the same question twice.
    const next = new URLSearchParams(searchParams);
    for (const name of DEEP_LINK_PARAMS) next.delete(name);
    setSearchParams(next, { replace: true, preventScrollReset: true });
    openWith(question);
  }, [enabled, searchParams, setSearchParams, openWith]);
}
