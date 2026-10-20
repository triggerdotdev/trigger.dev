import { getCapability } from "@internal/alert-contracts";

function summarizeScope(scope: unknown): string | null {
  if (!scope || typeof scope !== "object") return null;
  const s = scope as {
    type?: string;
    queue?: string;
    pattern?: string;
    taskIdentifier?: string;
  };
  switch (s.type) {
    case "queue":
      return s.queue ? `queue ${s.queue}` : null;
    case "queuePattern":
      return s.pattern ? `queue pattern ${s.pattern}` : null;
    case "task":
      return s.taskIdentifier ? `task ${s.taskIdentifier}` : null;
    default:
      return null;
  }
}

export function alertDisplayName(alert: {
  name?: string | null;
  capabilityKey: string;
  params?: unknown;
}): string {
  if (alert.name) return alert.name;

  const capability = getCapability(alert.capabilityKey);
  const title = capability?.title ?? alert.capabilityKey;
  const params = alert.params as { scope?: unknown } | undefined;
  const scopeSummary = summarizeScope(params?.scope);
  return scopeSummary ? `${title} · ${scopeSummary}` : title;
}
