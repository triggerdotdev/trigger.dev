import type {
  AuditLogContext,
  AuditLogController,
  AuditLogCredentialFingerprintInput,
  AuditLogCredentialRevokedInput,
  AuditLogInput,
} from "@trigger.dev/plugins";
import { resolveAuditEventAttribution } from "@trigger.dev/plugins";
import { Prisma } from "@trigger.dev/database";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { runWithHttpContext } from "~/services/httpAsyncStorage.server";

/**
 * An in-memory audit log plugin that keeps what the host sends it. `calls` keeps the order of
 * saves and marks. `onSave` runs before each save is kept, e.g. to look at the database then.
 * `recorded` keeps each event with its context; the host only records while recording is on (see
 * `enableAuditRecording`), and hands events over in the background (`auditLogs.flush()` waits).
 * An event the real plugin would drop lands in `dropped` instead, with the reason.
 * `listEvents` answers listings; without it there are no events.
 */
export function installAuditLogPlugin({
  failSaves = false,
  onSave,
  listEvents,
}: {
  failSaves?: boolean;
  onSave?: (input: AuditLogCredentialFingerprintInput) => Promise<void>;
  listEvents?: AuditLogController["listEvents"];
} = {}) {
  const saved: AuditLogCredentialFingerprintInput[] = [];
  const recorded: Array<{ input: AuditLogInput; context: AuditLogContext }> = [];
  const dropped: Array<{
    input: AuditLogInput;
    context: AuditLogContext;
    reason: "missing_actor" | "missing_source";
  }> = [];
  const revoked: AuditLogCredentialRevokedInput[] = [];
  const graceUpdates: Array<{ hash: string; graceUntil: Date | null }> = [];
  const calls: Array<{ call: "save" | "markRevoked"; hash: string }> = [];
  const controller: AuditLogController = {
    async record(input, context) {
      // The rule the real plugin applies before it stores an event, shared with it, so a call-site
      // test sees a lost actor or source the way production would lose the event.
      const attribution = resolveAuditEventAttribution(input, context);
      if ("dropped" in attribution) {
        dropped.push({ input, context, reason: attribution.dropped });
        return;
      }
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
    async listEvents(query) {
      return listEvents ? listEvents(query) : { events: [], nextCursor: null };
    },
  };
  // The host resolves its plugin through this singleton; a test sets it like a loaded plugin.
  const global = globalThis as any;
  global.__trigger_singletons ??= {};
  global.__trigger_singletons.auditLogController = Promise.resolve(controller);
  return { saved, revoked, graceUpdates, calls, recorded, dropped };
}

/** Whether the host records events; `enableAuditRecording` turns it on. Off, as in production. */
const auditRecording = { enabled: false };

/**
 * The webapp `env` with the audit recording switch answered here, so a test never changes the real
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

/** Drops the per-org recording flag's cache, so no answer leaks from one test into the next. */
function resetAuditRecordingFlagCache() {
  delete (globalThis as any).__trigger_singletons?.auditRecordingFlag;
}

/**
 * Turns event recording on for every org, through the real gate: `AUDIT_LOGS_RECORDING_ENABLED`
 * in a test file whose `env` is mocked with `auditRecordingEnv`, and the global
 * `auditLogsRecording` flag row in the database `~/db.server` connects to. An org's own override
 * still wins. Returns the function that puts both back. The host reads them on every call (the
 * flag through a cache this resets), so this works after the modules have loaded.
 */
export async function enableAuditRecording(): Promise<() => Promise<void>> {
  const { prisma } = await import("~/db.server");
  const key = FEATURE_FLAG.auditLogsRecording;
  const previousRow = await prisma.featureFlag.findFirst({ where: { key } });
  await prisma.featureFlag.upsert({
    where: { key },
    create: { key, value: true },
    update: { value: true },
  });
  const previous = auditRecording.enabled;
  auditRecording.enabled = true;
  resetAuditRecordingFlagCache();

  return async () => {
    auditRecording.enabled = previous;
    if (previousRow) {
      const value = previousRow.value ?? Prisma.JsonNull;
      await prisma.featureFlag.update({
        where: { key },
        data: { value: value as Prisma.InputJsonValue | typeof Prisma.JsonNull },
      });
    } else {
      await prisma.featureFlag.deleteMany({ where: { key } });
    }
    resetAuditRecordingFlagCache();
  };
}

/**
 * Runs `body` as a dashboard request by a test user, the way a call site runs in production, so the
 * events it records have an actor and a source. Without one, the helper drops them, as the real
 * plugin does. Tests that check what attribution an event gets set it themselves.
 */
export function inAuditedRequest<R>(body: () => Promise<R>): Promise<R> {
  return runWithHttpContext(
    {
      requestId: "req_test",
      path: "/test",
      host: "localhost",
      method: "POST",
      abortController: new AbortController(),
      auditIdentity: {
        actor: { type: "user", id: "user_test" },
        credential: null,
        onBehalfOf: null,
        source: "dashboard",
        endpoint: null,
        origin: null,
      },
    },
    body
  );
}

export function uninstallAuditLogPlugin() {
  delete (globalThis as any).__trigger_singletons?.auditLogController;
  resetAuditRecordingFlagCache();
}
