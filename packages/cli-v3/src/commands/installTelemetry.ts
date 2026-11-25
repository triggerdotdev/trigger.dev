import { OutroCommandError } from "../cli/common.js";
import { readAuthConfigCurrentProfileName } from "../utilities/configFiles.js";
import { isTriggerCloudApi } from "../utilities/apiUrl.js";
import type { KnownUser } from "../utilities/knownUser.js";
import { lookupUserId } from "../utilities/lookupUserId.js";
import {
  createAnalytics,
  createPostHogSink,
  isAnalyticsEnabled,
  mcpInstalledEvent,
  type AnalyticsSink,
} from "../utilities/productAnalytics.js";
import { VERSION } from "../version.js";

const cancellations = new WeakSet<object>();

// Only a user backing out of a prompt counts as a cancellation, not any failed install.
export function cancelInstall(message: string) {
  const error = new OutroCommandError(message);
  cancellations.add(error);
  return error;
}

export function installOutcomeFor(error: unknown): "error" | "cancelled" {
  return typeof error === "object" && error !== null && cancellations.has(error)
    ? "cancelled"
    : "error";
}

export type McpInstallSource = "install-mcp" | "init" | "dev" | "mcp";

// Only when a stored login already says who this is; never prompts, never throws.
export async function reportMcpInstalled(input: {
  source: McpInstallSource;
  skipTelemetry?: boolean;
  results: Array<{ clientName: string; scope: { scope: string } }>;
  outcome: "success" | "error" | "cancelled";
  profile?: string;
  apiUrl?: string;
  sink?: AnalyticsSink;
  lookupUserId?: (options: {
    profile?: string;
    apiUrl?: string;
    signal?: AbortSignal;
  }) => Promise<KnownUser | undefined>;
}) {
  if (!isAnalyticsEnabled(input.skipTelemetry)) return;
  if (input.apiUrl && !isTriggerCloudApi(input.apiUrl)) return;
  if (input.outcome === "cancelled") return;
  if (input.outcome === "success" && input.results.length === 0) return;

  const analytics = createAnalytics({
    enabled: true,
    sink: input.sink ?? createPostHogSink({ flushAt: 5, flushIntervalMs: 2000 }),
  });
  const controller = new AbortController();
  analytics.capture(
    mcpInstalledEvent({
      clients: input.results.map((r) => r.clientName),
      scopes: input.results.map((r) => r.scope.scope),
      outcome: input.outcome,
      cliVersion: VERSION as string,
      source: input.source,
    }),
    () =>
      (input.lookupUserId ?? lookupUserId)({
        profile: input.profile ?? readAuthConfigCurrentProfileName(),
        apiUrl: input.apiUrl,
        signal: controller.signal,
      })
  );
  await analytics.shutdown(1500);
  controller.abort();
}
