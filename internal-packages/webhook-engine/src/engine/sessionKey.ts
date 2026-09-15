// Runtime evaluation of a session routing key template. The template ({body.x}/{webhook.x}/{header.x})
// is compiled from the SDK's session.webhook `key` at deploy-sync; here we resolve it against a live
// delivery to produce the session externalId. Returns undefined if any placeholder is missing/empty,
// so the engine can fail the delivery rather than route it to a garbage session key.

export type SessionKeyNamespaces = {
  body: unknown; // the parsed event body
  webhook: Record<string, string>; // endpoint meta: externalRef, tenantId, id, source, deliveryId
  header: Record<string, string>; // inbound request headers (matched case-insensitively)
};

export function evaluateSessionKeyTemplate(
  template: string,
  ns: SessionKeyNamespaces
): string | undefined {
  let ok = true;
  const out = template.replace(/\{([^}]+)\}/g, (_match, raw: string) => {
    // A placeholder may list fallbacks: `{a || b || c}` resolves to the first non-empty path (so a
    // Slack thread-start with no thread_ts falls back to ts). Missing/empty everywhere fails the key.
    for (const path of raw.split("||")) {
      const value = resolveKeyPath(path.trim(), ns);
      if (value !== undefined && value !== null && value !== "") return String(value);
    }
    ok = false;
    return "";
  });
  return ok ? out : undefined;
}

function resolveKeyPath(path: string, ns: SessionKeyNamespaces): unknown {
  if (path.startsWith("webhook.")) {
    return ns.webhook[path.slice("webhook.".length)];
  }
  if (path.startsWith("header.")) {
    const name = path.slice("header.".length).toLowerCase();
    for (const [key, value] of Object.entries(ns.header)) {
      if (key.toLowerCase() === name) return value;
    }
    return undefined;
  }
  // body. prefix or a bare path both resolve against the event body.
  const dotted = path.startsWith("body.") ? path.slice("body.".length) : path;
  return walkPath(ns.body, dotted);
}

// Resolve a dotted path over an arbitrary object (shared with the ingest handshake hook).
export function walkPath(root: unknown, dotted: string): unknown {
  let current: unknown = root;
  for (const segment of dotted.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
