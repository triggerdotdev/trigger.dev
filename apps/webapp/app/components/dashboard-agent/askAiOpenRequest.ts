import { useEffect } from "react";

// Module-level bridge, mirroring `dashboardAgentOpenRequest`: Ask AI's host sits in the `_app`
// layout as a sibling of the app, so callers reach it by request rather than through context.

type Handler = (question?: string) => void;

const handlers = new Set<Handler>();

/** Returns the unsubscribe. */
export function registerAskAiHost(handler: Handler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** Returns false when no host is mounted (self-hosted, or before hydration). */
export function requestAskAi(question?: string): boolean {
  if (handlers.size === 0) return false;
  for (const handler of handlers) handler(question);
  return true;
}

export function useAskAiHost(open: Handler) {
  useEffect(() => registerAskAiHost(open), [open]);
}
