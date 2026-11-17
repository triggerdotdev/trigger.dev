import type { AuditLogController } from "@trigger.dev/plugins";

/**
 * An in-memory audit log plugin whose fingerprint lookups the test controls. Every hash the host
 * looks up is kept in `lookups`.
 */
export function installFingerprintLookupPlugin(
  findCredentialFingerprint: (hash: string) => Promise<{ fingerprintId: string } | null>
) {
  const lookups: string[] = [];
  const controller: AuditLogController = {
    async record() {},
    async flush() {},
    async saveCredentialFingerprint() {
      return null;
    },
    async markCredentialRevoked() {},
    async updateCredentialGrace() {},
    findCredentialFingerprint(hash) {
      lookups.push(hash);
      return findCredentialFingerprint(hash);
    },
    async listEvents() {
      return { events: [], nextCursor: null };
    },
  };
  // The host resolves its plugin through this singleton; a test sets it like a loaded plugin.
  const global = globalThis as { __trigger_singletons?: Record<string, unknown> };
  global.__trigger_singletons ??= {};
  const singletons = global.__trigger_singletons;
  singletons.auditLogController = Promise.resolve(controller);
  return { lookups };
}

export function uninstallFingerprintLookupPlugin() {
  delete (globalThis as { __trigger_singletons?: Record<string, unknown> }).__trigger_singletons
    ?.auditLogController;
}
