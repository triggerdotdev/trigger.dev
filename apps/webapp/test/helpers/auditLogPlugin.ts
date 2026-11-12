import type {
  AuditLogController,
  AuditLogCredentialFingerprintInput,
  AuditLogCredentialRevokedInput,
} from "@trigger.dev/plugins";

/**
 * An in-memory audit log plugin that keeps what the host sends it. `calls` keeps the order of
 * saves and marks. `onSave` runs before each save is kept, e.g. to look at the database then.
 */
export function installAuditLogPlugin({
  failSaves = false,
  onSave,
}: {
  failSaves?: boolean;
  onSave?: (input: AuditLogCredentialFingerprintInput) => Promise<void>;
} = {}) {
  const saved: AuditLogCredentialFingerprintInput[] = [];
  const revoked: AuditLogCredentialRevokedInput[] = [];
  const graceUpdates: Array<{ hash: string; graceUntil: Date | null }> = [];
  const calls: Array<{ call: "save" | "markRevoked"; hash: string }> = [];
  const controller: AuditLogController = {
    async record() {},
    async flush() {},
    async saveCredentialFingerprint(input) {
      if (failSaves) throw new Error("control plane unavailable");
      await onSave?.(input);
      saved.push(input);
      calls.push({ call: "save", hash: input.hash });
      return { fingerprintId: `fp_${saved.length}` };
    },
    async markCredentialRevoked(input) {
      revoked.push(input);
      calls.push({ call: "markRevoked", hash: input.hash });
    },
    async updateCredentialGrace(hash, graceUntil) {
      graceUpdates.push({ hash, graceUntil });
    },
    async findCredentialFingerprint() {
      return null;
    },
    async listEvents() {
      return { events: [], nextCursor: null };
    },
  };
  // The host resolves its plugin through this singleton; a test sets it like a loaded plugin.
  const global = globalThis as any;
  global.__trigger_singletons ??= {};
  global.__trigger_singletons.auditLogController = Promise.resolve(controller);
  return { saved, revoked, graceUpdates, calls };
}

export function uninstallAuditLogPlugin() {
  delete (globalThis as any).__trigger_singletons?.auditLogController;
}
