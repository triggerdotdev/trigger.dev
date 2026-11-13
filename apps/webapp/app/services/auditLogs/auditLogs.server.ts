import type {
  AuditLogContext,
  AuditLogController,
  AuditLogPluginConfig,
} from "@trigger.dev/plugins";
import { env } from "~/env.server";
import { getHttpContext } from "~/services/httpAsyncStorage.server";
import { signalsEmitter } from "~/services/signals.server";
import { singleton } from "~/utils/singleton";
import { createAuditLogs } from "./auditLogHost.server";
import { loadAuditLogPlugin } from "./auditLogPlugin.server";

/** Until the request audit context lands, only the time and request id are known. */
function contextFromRequest(occurredAt: Date): AuditLogContext {
  return {
    occurredAt,
    actor: null,
    credential: null,
    onBehalfOf: null,
    source: null,
    endpoint: null,
    origin: null,
    requestId: getHttpContext()?.requestId ?? null,
  };
}

function pluginConfig(): AuditLogPluginConfig {
  return {
    controlPlane: {
      writerUrl: env.CONTROL_PLANE_DATABASE_URL ?? env.DATABASE_URL,
      readerUrl: env.CONTROL_PLANE_DATABASE_READ_REPLICA_URL ?? env.DATABASE_READ_REPLICA_URL,
    },
  };
}

export function getAuditLogController(): Promise<AuditLogController | null> {
  return singleton("auditLogController", () =>
    loadAuditLogPlugin({ requirePlugins: env.REQUIRE_PLUGINS === "1", config: pluginConfig() })
  );
}

/** @knipignore Entry point for audit events; call sites land with the event types. */
export const auditLogs = singleton("auditLogs", () => {
  const audit = createAuditLogs({
    controller: getAuditLogController,
    isRecordingEnabled: () => env.AUDIT_LOGS_RECORDING_ENABLED,
    getContext: contextFromRequest,
  });
  // Hands events and revocations still in flight to the plugin before the process exits.
  const flushOnShutdown = () => void audit.flush();
  signalsEmitter.on("SIGTERM", flushOnShutdown);
  signalsEmitter.on("SIGINT", flushOnShutdown);
  return audit;
});

/**
 * Hands every event and revocation recorded so far to the plugin. Never throws. server.ts calls it
 * once the HTTP server has closed, for events recorded by requests still running at the signal.
 */
export function flushAuditLogs(): Promise<void> {
  return auditLogs.flush();
}
