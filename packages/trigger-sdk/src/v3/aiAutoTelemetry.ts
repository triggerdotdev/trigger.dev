/**
 * Auto-register `@ai-sdk/otel` so AI SDK 7 emits OpenTelemetry spans into the
 * Trigger.dev run trace with no customer setup.
 *
 * AI SDK 6 emitted spans from `ai` core, so `experimental_telemetry` (set by
 * `chat.toStreamTextOptions({ telemetry })`) was enough. v7 moved span emission
 * into the separate `@ai-sdk/otel` adapter, so on v7 `experimental_telemetry`
 * alone produces nothing until an integration is registered. We register it once
 * per worker process at chat.agent run boot. `@ai-sdk/otel` writes to the global
 * OpenTelemetry tracer, which is the same provider the Trigger worker installs
 * (the `@opentelemetry/api` global is a `globalThis` singleton keyed by major
 * version, so the separate copies still share it), so spans land in the trace.
 *
 * Fully guarded and best-effort — telemetry must never break a run:
 *  - `registerTelemetry` only exists in v7 `ai` (no-op on v5/v6).
 *  - `@ai-sdk/otel` is an OPTIONAL peer. The specifier is computed so the task
 *    bundler doesn't hard-require it (v5/v6 users never install it).
 *  - We detect an already-registered `@ai-sdk/otel` integration and skip, so a
 *    customer (or a library they import) that registers it themselves doesn't
 *    get duplicate spans. `registerTelemetry` is append-only, so without this
 *    guard a second integration would double every span.
 *  - To disable our auto-register entirely (e.g. you register `@ai-sdk/otel`
 *    yourself after this boot, or via a custom integration our detection can't
 *    see), set the env var `TRIGGER_AI_SDK_OTEL_AUTOREGISTER=0`.
 */
let registration: Promise<void> | null = null;

/** Registers the AI SDK OTel integration once per process. Safe to call on every run. */
export function ensureAiSdkTelemetry(): Promise<void> {
  if (!registration) {
    registration = register();
  }
  return registration;
}

async function register(): Promise<void> {
  try {
    if (isAutoRegisterDisabled()) {
      return; // opted out via TRIGGER_AI_SDK_OTEL_AUTOREGISTER
    }
    const aiMod: any = await import("ai");
    if (typeof aiMod.registerTelemetry !== "function") {
      return; // v5 / v6 — `ai` core emits spans itself, nothing to wire.
    }
    // Computed specifier keeps the optional peer out of static bundler
    // resolution; resolves at runtime only when the customer installed it.
    const otelSpecifier = ["@ai-sdk", "otel"].join("/");
    const otelMod: any = await import(otelSpecifier).catch(() => null);
    if (typeof otelMod?.OpenTelemetry !== "function") {
      return; // optional peer not installed
    }
    if (hasAiSdkOtelIntegration(otelMod.OpenTelemetry)) {
      return; // already registered by the customer or a library they import
    }
    aiMod.registerTelemetry(new otelMod.OpenTelemetry());
  } catch {
    // never throw from telemetry setup
  }
}

function isAutoRegisterDisabled(): boolean {
  const value = process.env.TRIGGER_AI_SDK_OTEL_AUTOREGISTER?.toLowerCase();
  return value === "0" || value === "false";
}

/**
 * True if an `@ai-sdk/otel` integration is already in v7's global telemetry
 * registry (`globalThis.AI_SDK_TELEMETRY_INTEGRATIONS`, a documented public
 * global that `registerTelemetry` appends to). `instanceof` matches a same-copy
 * registration; the constructor-name fallback catches a separate copy of
 * `@ai-sdk/otel`.
 */
function hasAiSdkOtelIntegration(OpenTelemetry: any): boolean {
  const integrations = (globalThis as any).AI_SDK_TELEMETRY_INTEGRATIONS;
  if (!Array.isArray(integrations)) {
    return false;
  }
  return integrations.some(
    (integration: any) =>
      (typeof OpenTelemetry === "function" && integration instanceof OpenTelemetry) ||
      integration?.constructor?.name === "OpenTelemetry"
  );
}
