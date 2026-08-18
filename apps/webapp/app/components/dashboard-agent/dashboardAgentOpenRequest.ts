import { useEffect, useRef, useSyncExternalStore } from "react";
import { useSearchParams } from "@remix-run/react";

// Module-level bridge: `DashboardAgentProvider` is mounted by the environment layout, so
// callers above it cannot reach the agent through context.

type DashboardAgentOpenRequest = {
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
function registerDashboardAgentHost(handler: Handler): () => void {
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

/**
 * The deep-link question still in the URL, or null when there is none left to ask. `sent` is the
 * question already handed to the agent: `setSearchParams` only starts the navigation that drops
 * the param, so every render until it commits sees the question again. Clearing `sent` once the
 * param is gone lets the same question arrive a second time on a later visit.
 */
export function consumeDeepLinkQuestion(
  params: URLSearchParams,
  names: readonly string[],
  sent: string | null
): { question: string | null; sent: string | null } {
  const name = names.find((candidate) => params.get(candidate));
  if (!name) return { question: null, sent: null };
  const question = params.get(name)!;
  if (question === sent) return { question: null, sent };
  return { question, sent: question };
}

/** While `enabled` is false nothing is registered, so every entry point stays hidden. */
export function useDashboardAgentOpenRequests({
  enabled,
  openWith,
  setOpen,
  /** `agentDeepLinkParams` decides these; `aiHelp` is Ask AI's unless it cannot open. */
  deepLinkParams,
}: {
  enabled: boolean;
  openWith: (text: string) => void;
  setOpen: (open: boolean) => void;
  deepLinkParams: readonly string[];
}) {
  useEffect(() => {
    if (!enabled) return;
    return registerDashboardAgentHost(({ prompt }) => (prompt ? openWith(prompt) : setOpen(true)));
  }, [enabled, openWith, setOpen]);

  const [searchParams, setSearchParams] = useSearchParams();
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const { question, sent: nextSent } = consumeDeepLinkQuestion(
      searchParams,
      deepLinkParams,
      sent.current
    );
    sent.current = nextSent;
    if (question === null) return;
    const next = new URLSearchParams(searchParams);
    for (const name of deepLinkParams) next.delete(name);
    setSearchParams(next, { replace: true, preventScrollReset: true });
    openWith(question);
  }, [enabled, searchParams, setSearchParams, openWith, deepLinkParams]);
}
