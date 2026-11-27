import { AsyncLocalStorage } from "node:async_hooks";

type CallScope = { projectRef?: string };

const storage = new AsyncLocalStorage<CallScope>();

// Tied to the running tool call, so overlapping calls never see each other's project.
export function runInCallScope<T>(scope: CallScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function recordResolvedProjectRef(projectRef: string) {
  const scope = storage.getStore();
  if (scope) scope.projectRef ??= projectRef;
}
