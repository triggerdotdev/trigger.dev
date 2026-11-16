import type {
  AuditLogContext,
  AuditLogController,
  AuditLogCredentialFingerprintInput,
  AuditLogCredentialRevokedInput,
  AuditLogInput,
} from "@trigger.dev/plugins";

/**
 * An in-memory audit log plugin that keeps what the host sends it. `calls` keeps the order of
 * saves and marks. `onSave` runs before each save is kept, e.g. to look at the database then.
 * `recorded` keeps each event with its context; the host only records while recording is on (see
 * `enableAuditRecording`), and hands events over in the background (`auditLogs.flush()` waits).
 */
export function installAuditLogPlugin({
  failSaves = false,
  onSave,
}: {
  failSaves?: boolean;
  onSave?: (input: AuditLogCredentialFingerprintInput) => Promise<void>;
} = {}) {
  const saved: AuditLogCredentialFingerprintInput[] = [];
  const recorded: Array<{ input: AuditLogInput; context: AuditLogContext }> = [];
  const revoked: AuditLogCredentialRevokedInput[] = [];
  const graceUpdates: Array<{ hash: string; graceUntil: Date | null }> = [];
  const calls: Array<{ call: "save" | "markRevoked"; hash: string }> = [];
  const controller: AuditLogController = {
    async record(input, context) {
      recorded.push({ input, context });
    },
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
  return { saved, revoked, graceUpdates, calls, recorded };
}

/** Whether the host records events; `enableAuditRecording` turns it on. Off, as in production. */
const auditRecording = { enabled: false };

/**
 * The webapp `env` with the audit recording flag answered here, so a test never changes the real
 * one. A test file that records events mocks `env` with it:
 * `vi.mock("~/env.server", async (original) => (await import("./helpers/auditLogPlugin")).auditRecordingEnv(await original()))`.
 */
export function auditRecordingEnv<T extends { env: object }>(module: T): T {
  return {
    ...module,
    env: new Proxy(module.env, {
      get: (target, property, receiver) =>
        property === "AUDIT_LOGS_RECORDING_ENABLED"
          ? auditRecording.enabled
          : Reflect.get(target, property, receiver),
    }),
  };
}

/**
 * Turns event recording on, as `AUDIT_LOGS_RECORDING_ENABLED` does, in a test file whose `env` is
 * mocked with `auditRecordingEnv`; returns the function that turns it back off. The host reads the
 * flag on every call, so this works after the modules have loaded.
 */
export async function enableAuditRecording(): Promise<() => void> {
  const previous = auditRecording.enabled;
  auditRecording.enabled = true;
  return () => {
    auditRecording.enabled = previous;
  };
}

export function uninstallAuditLogPlugin() {
  delete (globalThis as any).__trigger_singletons?.auditLogController;
}
