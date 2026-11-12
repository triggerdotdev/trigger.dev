import type {
  AuditLogContext,
  AuditLogController,
  AuditLogCredentialFingerprintInput,
  AuditLogCredentialRevokedInput,
  AuditLogEventPage,
  AuditLogEventQuery,
  AuditLogInput,
  AuditLogListedEvent,
} from "@trigger.dev/plugins";
import { logger } from "~/services/logger.server";

export type AuditLogs = {
  /**
   * Never throws and never blocks the request. For a change, call it after the change commits,
   * never inside a transaction callback, so a rolled-back change records nothing.
   */
  record(input: AuditLogInput): void;
  /**
   * Resolves when every recorded event, revocation and grace update has been handled. For tests
   * and shutdown.
   */
  flush(): Promise<void>;
  /**
   * Whether fingerprint calls reach the plugin, i.e. it is installed. With REQUIRE_PLUGINS=1, a
   * plugin that failed to load throws the same generic error as `saveCredentialFingerprint`;
   * without it, a plugin that failed to load counts as not installed.
   */
  isFingerprintingEnabled(): Promise<boolean>;
  /**
   * Call before the change that creates the credential commits, and let it fail the change when
   * it throws. Throws a generic error that says nothing about auditing, safe to show customers;
   * the plugin's error is logged. Null
   * without the plugin. Ignores the recording flag.
   */
  saveCredentialFingerprint(
    input: AuditLogCredentialFingerprintInput
  ): Promise<{ fingerprintId: string } | null>;
  /**
   * Call after the revocation commits. Never throws and never blocks the request; `flush` waits
   * for it. Ignores the recording flag.
   *
   * `saveFirst` fingerprints are saved, in order, before the mark: e.g. a revoked key that may
   * predate fingerprints, which a mark alone would miss. Saving a hash that already has a
   * fingerprint changes nothing. A failed save is logged and the mark still runs.
   */
  markCredentialRevoked(
    input: AuditLogCredentialRevokedInput,
    options?: { saveFirst?: AuditLogCredentialFingerprintInput[] }
  ): void;
  /**
   * Call after the grace period change commits. Never throws and never blocks the request;
   * `flush` waits for it. Ignores the recording flag.
   */
  updateCredentialGrace(hash: string, graceUntil: Date | null): void;
  /** Null without the plugin or when the lookup fails. Never throws. */
  findCredentialFingerprint(hash: string): Promise<{ fingerprintId: string } | null>;
  /** No events without the plugin. */
  listEvents(query: AuditLogEventQuery): Promise<AuditLogEventPage>;
};

const NO_EVENTS: AuditLogEventPage = { events: [], nextCursor: null };

/** Fingerprint failures can reach customers, so the error says nothing about auditing. */
const CUSTOMER_SAFE_ERROR = "Something went wrong. Please try again.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copies only the fields customers may see. The plugin's rows can carry more than the type says,
 * e.g. staff identity or fingerprint ids, and those must never reach a customer.
 */
function toListedEvent(event: AuditLogListedEvent): AuditLogListedEvent {
  const { credential, endpoint, origin } = event;
  return {
    category: event.category,
    action: event.action,
    id: event.id,
    occurredAt: event.occurredAt,
    organizationId: event.organizationId,
    projectId: event.projectId,
    environmentId: event.environmentId,
    environmentType: event.environmentType,
    target: { type: event.target.type, id: event.target.id, name: event.target.name },
    actor: { type: event.actor.type, id: event.actor.id },
    credential: credential
      ? { kind: credential.kind, id: credential.id, last4: credential.last4 }
      : null,
    source: event.source,
    endpoint: endpoint ? { ip: endpoint.ip, userAgent: endpoint.userAgent } : null,
    origin: origin ? { deploymentId: origin.deploymentId } : null,
    requestId: event.requestId,
    changes: event.changes,
  } as AuditLogListedEvent;
}

/**
 * No-op when the plugin is missing. Recording stops when the recording flag is off; fingerprint
 * calls reach the plugin whenever it is installed.
 */
export function createAuditLogs(options: {
  controller: () => Promise<AuditLogController | null>;
  isRecordingEnabled: () => boolean;
  /**
   * Called synchronously inside the request, so read request state before any await. May resolve
   * later, e.g. to wait for a credential lookup started during authentication.
   */
  getContext: (occurredAt: Date) => AuditLogContext | Promise<AuditLogContext>;
}): AuditLogs {
  const pending = new Set<Promise<void>>();

  /** Runs `work` without blocking the caller; failures are logged, and `flush` waits for it. */
  function inBackground(work: () => Promise<void>, failure: string, details: object = {}): void {
    const tracked = Promise.resolve()
      .then(work)
      .catch((error) => {
        logger.error(failure, { ...details, error: errorMessage(error) });
      })
      .finally(() => pending.delete(tracked));
    pending.add(tracked);
  }

  async function recordWithController(
    input: AuditLogInput,
    context: Promise<AuditLogContext>
  ): Promise<void> {
    const controller = await options.controller();
    if (!controller) return;

    await controller.record(input, await context);
  }

  return {
    record(input) {
      if (!options.isRecordingEnabled()) return;

      let context: Promise<AuditLogContext>;
      try {
        context = Promise.resolve(options.getContext(new Date()));
      } catch (error) {
        context = Promise.reject(error);
      }
      // Handled now: without a plugin, or while it loads, nothing else waits on the context yet.
      context.catch(() => {});

      inBackground(
        () => recordWithController(input, context),
        "Audit logs: failed to record event",
        {
          action: input.action,
        }
      );
    },

    async flush() {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
      try {
        await (await options.controller())?.flush();
      } catch (error) {
        logger.error("Audit logs: flush failed", { error: errorMessage(error) });
      }
    },

    async isFingerprintingEnabled() {
      try {
        return (await options.controller()) !== null;
      } catch (error) {
        logger.error("Audit logs: plugin failed to load", { error: errorMessage(error) });
        throw new Error(CUSTOMER_SAFE_ERROR);
      }
    },

    async saveCredentialFingerprint(input) {
      try {
        const controller = await options.controller();
        if (!controller) return null;

        return await controller.saveCredentialFingerprint(input);
      } catch (error) {
        logger.error("Audit logs: failed to save credential fingerprint", {
          kind: input.kind,
          error: errorMessage(error),
        });
        throw new Error(CUSTOMER_SAFE_ERROR);
      }
    },

    markCredentialRevoked(input, { saveFirst = [] } = {}) {
      inBackground(
        async () => {
          const controller = await options.controller();
          if (!controller) return;

          for (const fingerprint of saveFirst) {
            try {
              await controller.saveCredentialFingerprint(fingerprint);
            } catch (error) {
              logger.error("Audit logs: failed to save credential fingerprint", {
                kind: fingerprint.kind,
                error: errorMessage(error),
              });
            }
          }
          await controller.markCredentialRevoked(input);
        },
        "Audit logs: failed to mark credential revoked",
        { reason: input.reason }
      );
    },

    updateCredentialGrace(hash, graceUntil) {
      inBackground(async () => {
        await (await options.controller())?.updateCredentialGrace(hash, graceUntil);
      }, "Audit logs: failed to update credential grace period");
    },

    async findCredentialFingerprint(hash) {
      try {
        return (await (await options.controller())?.findCredentialFingerprint(hash)) ?? null;
      } catch (error) {
        logger.error("Audit logs: credential fingerprint lookup failed", {
          error: errorMessage(error),
        });
        return null;
      }
    },

    async listEvents(query) {
      const controller = await options.controller();
      if (!controller) return NO_EVENTS;

      const page = await controller.listEvents(query);
      return {
        events: page.events
          .filter((event) => (event.category as string) !== "auth")
          .map(toListedEvent),
        nextCursor: page.nextCursor,
      };
    },
  };
}
