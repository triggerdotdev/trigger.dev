import { getCapability, type LimitSignal } from "@internal/alert-contracts";

const NOUN: Record<string, string> = {
  "limits.api": "API rate limit utilisation",
  "limits.concurrency": "Environment concurrency",
  "limits.queue": "Queue size",
  "limits.webhooks.processing": "Webhook processing concurrency",
  "limits.webhooks.env_rate": "Webhook environment rate limit",
  "limits.webhooks.endpoint_rate": "Webhook endpoint rate limit",
  "limits.webhooks.waiters": "Webhook waiters",
};

const LIMITED_PHRASE: Record<string, string> = {
  "limits.api": "requests denied",
  "limits.concurrency": "concurrency limit reached",
  "limits.webhooks.env_rate": "webhooks denied",
  "limits.webhooks.endpoint_rate": "webhooks denied",
  "limits.webhooks.waiters": "new waiters refused",
};

export function stateConditionSummary(state: {
  stateKey: string;
  compositeMode?: "any" | "all";
  components?: string[];
  signals?: LimitSignal[];
  params?: Record<string, number>;
}): string | undefined {
  const cap = getCapability(state.stateKey);
  if (!cap) return undefined;
  const compositeOf = cap.binding.compositeOf;
  if (compositeOf) {
    if (cap.area !== "limits") return undefined;
    const count = state.components?.length ?? compositeOf.length;
    return `${state.compositeMode === "all" ? "All" : "Any"} of ${count} limits`;
  }
  const supported = cap.supportedSignals;
  if (!supported) return undefined;
  const signals = state.signals ?? supported;
  const noun = NOUN[state.stateKey] ?? cap.title;
  const pct =
    state.params?.utilisationPct ??
    cap.binding.params?.find((p) => p.key === "utilisationPct")?.default;
  const parts = [
    signals.includes("approaching") ? `${noun} ≥ ${pct}%` : undefined,
    signals.includes("limited") ? LIMITED_PHRASE[state.stateKey] : undefined,
  ].filter(Boolean);
  if (parts.length === 2) return parts.join(" or ");
  if (parts.length === 1 && signals.includes("limited") && !signals.includes("approaching")) {
    return `${noun}: ${parts[0]}`;
  }
  return parts[0];
}

const SHORT_TITLE: Record<string, string> = {
  "limits.api": "API rate limit",
  "limits.concurrency": "Environment concurrency",
  "limits.queue": "Queue size",
  "limits.webhooks.processing": "Webhook processing",
  "limits.webhooks.env_rate": "Webhook ingress",
  "limits.webhooks.endpoint_rate": "Webhook endpoint",
  "limits.webhooks.waiters": "Webhook waiters",
};

export function limitScopeLabel(capabilityKey: string, components?: string[]): string | undefined {
  const cap = getCapability(capabilityKey);
  if (cap?.area !== "limits") return undefined;
  const parts = cap.binding.compositeOf;
  if (!parts) return SHORT_TITLE[capabilityKey] ?? cap.title;
  const picked = components?.length ? parts.filter((key) => components.includes(key)) : parts;
  return picked.length === parts.length
    ? "All limits"
    : picked.map((key) => SHORT_TITLE[key] ?? key).join(", ");
}
