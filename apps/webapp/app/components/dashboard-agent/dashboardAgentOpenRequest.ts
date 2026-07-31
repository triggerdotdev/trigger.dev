import { useEffect, useSyncExternalStore } from "react";
import { useSearchParams } from "@remix-run/react";

/**
 * Opening the agent from OUTSIDE its provider.
 *
 * `DashboardAgentProvider` is mounted by the environment layout, so anything
 * above that in the tree can't reach `openWith` through context. The side menu is
 * exactly that case: Help & Feedback lives in the app layout, one level up from
 * the environment layout, and its "Ask {agent}" item still has to open the panel.
 *
 * So this is a one-hop bridge. The host (`DashboardAgent`, inside the provider)
 * registers a handler; callers anywhere publish a request. Module-level rather
 * than another context, because the whole point is that the caller has no
 * provider above it.
 *
 * Availability is part of the contract: with no host mounted — the agent is
 * gated off, or the user is on a page outside an environment — there is nothing
 * to open, and every entry point hides itself rather than offering a dead click.
 */

export type DashboardAgentOpenRequest = {
  /** Text to open with, as the user's first message. Omitted just opens the panel. */
  prompt?: string;
};

type Handler = (request: DashboardAgentOpenRequest) => void;

const handlers = new Set<Handler>();
const availabilityListeners = new Set<() => void>();

function notifyAvailability() {
  for (const listener of availabilityListeners) listener();
}

/**
 * Register the mounted agent host. Called by `DashboardAgent` (via
 * {@link useDashboardAgentOpenRequests}); returns the unsubscribe.
 */
export function registerDashboardAgentHost(handler: Handler): () => void {
  handlers.add(handler);
  notifyAvailability();
  return () => {
    handlers.delete(handler);
    notifyAvailability();
  };
}

/**
 * Ask the agent to open, optionally with a first message. Returns false when no
 * host is mounted, so a caller that ignored {@link useDashboardAgentAvailable}
 * still fails quietly rather than pretending something happened.
 */
export function requestDashboardAgent(prompt?: string): boolean {
  if (handlers.size === 0) return false;
  for (const handler of handlers) handler({ prompt });
  return true;
}

function subscribeToAvailability(listener: () => void): () => void {
  availabilityListeners.add(listener);
  return () => availabilityListeners.delete(listener);
}

/** Whether anything can honour a request right now. */
export function useDashboardAgentAvailable(): boolean {
  return useSyncExternalStore(
    subscribeToAvailability,
    () => handlers.size > 0,
    // The host mounts client-side only, so the server renders every entry point
    // as unavailable and the client fills them in.
    () => false
  );
}

/**
 * Deep-link parameters that open the agent with a question. `ask` is the current
 * one; `aiHelp` is what the CLI's `/projects/:ref/ai-help` link used to redirect
 * to (it fed the old docs chat) and is still honoured, because those links live
 * in people's terminal scrollback.
 */
const DEEP_LINK_PARAMS = ["ask", "aiHelp"] as const;

/**
 * The agent host's side of the bridge: honour outside requests, and the
 * `?ask=`/`?aiHelp=` deep link the CLI sends people to.
 *
 * Called by `DashboardAgent` so all of this logic stays in one place. `enabled`
 * is the host's access gate — while false nothing is registered, so every entry
 * point stays hidden.
 */
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
    // Consume it before opening, so a re-render (or a back/forward) can't ask
    // the same question twice.
    const next = new URLSearchParams(searchParams);
    for (const name of DEEP_LINK_PARAMS) next.delete(name);
    setSearchParams(next, { replace: true, preventScrollReset: true });
    openWith(question);
  }, [enabled, searchParams, setSearchParams, openWith]);
}
