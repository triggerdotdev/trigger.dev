// `.server` so the ~80 KB registry stays out of the browser bundle; the loader
// ships only this map.
import registry from "~/trigger/ai-assistant-tools/api/registry.json";

export type ApiOperationSummary = { method: string; path: string };

export const apiOperationsMap: Record<string, ApiOperationSummary> = Object.fromEntries(
  (registry as Array<{ operationId: string; method: string; path: string }>).map((e) => [
    e.operationId,
    { method: e.method, path: e.path },
  ])
);
