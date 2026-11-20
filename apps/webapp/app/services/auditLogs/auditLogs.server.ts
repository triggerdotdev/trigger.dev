import type { AuditLogController, AuditLogPluginConfig } from "@trigger.dev/plugins";
import { env } from "~/env.server";
import { getIpLocation } from "~/services/platform.v3.server";
import { signalsEmitter } from "~/services/signals.server";
import { singleton } from "~/utils/singleton";
import { countMissingFingerprint, getRequestAuditContext } from "./auditContext.server";
import { createAuditLogs } from "./auditLogHost.server";
import { loadAuditLogPlugin } from "./auditLogPlugin.server";
import { isAuditRecordingEnabledFor } from "./auditRecordingFlag.server";

function pluginConfig(): AuditLogPluginConfig {
  return {
    controlPlane: {
      writerUrl: env.CONTROL_PLANE_DATABASE_URL ?? env.DATABASE_URL,
      readerUrl: env.CONTROL_PLANE_DATABASE_READ_REPLICA_URL ?? env.DATABASE_READ_REPLICA_URL,
    },
    lookupIpLocation: (ip) => getIpLocation(ip),
  };
}

export function getAuditLogController(): Promise<AuditLogController | null> {
  return singleton("auditLogController", () =>
    loadAuditLogPlugin({ requirePlugins: env.REQUIRE_PLUGINS === "1", config: pluginConfig() })
  );
}

/** Entry point for audit events and credential fingerprints. */
export const auditLogs = singleton("auditLogs", () => {
  const audit = createAuditLogs({
    controller: getAuditLogController,
    isRecordingEnabled: () => env.AUDIT_LOGS_RECORDING_ENABLED,
    isRecordingEnabledFor: isAuditRecordingEnabledFor,
    // Resolved at call time: the context module imports this one.
    getContext: (occurredAt) => getRequestAuditContext(occurredAt),
    onRecord: (context) => countMissingFingerprint(context),
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
