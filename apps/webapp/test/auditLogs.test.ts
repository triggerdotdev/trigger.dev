import type {
  AuditLogContext,
  AuditLogController,
  AuditLogCredentialFingerprintInput,
  AuditLogCredentialRevokedInput,
  AuditLogEvent,
  AuditLogInput,
  AuditLogPluginConfig,
} from "@trigger.dev/plugins";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createAuditLogs } from "~/services/auditLogs/auditLogHost.server";
import { loadAuditLogPlugin } from "~/services/auditLogs/auditLogPlugin.server";

// Where the plugin package is installed, the missing-plugin path can't be observed; CI runs without it.
const pluginLocallyLinked = existsSync(
  resolve(__dirname, "..", "node_modules", "@triggerdotdev", "plugins")
);

const config: AuditLogPluginConfig = {
  controlPlane: { writerUrl: "postgresql://localhost:5432/control_plane" },
};

const input: AuditLogInput = {
  category: "envvars",
  action: "envvar.deleted",
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  environmentType: "STAGING",
  target: { type: "envvar", id: null, name: "STRIPE_SECRET" },
};

const fingerprint: AuditLogCredentialFingerprintInput = {
  hash: "a".repeat(64),
  kind: "additional_api_key",
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  credentialId: "key_1",
  name: "CI",
  last4: "k9Qz",
  createdBy: { type: "user", id: "user_1" },
  createdAt: new Date("2026-11-09T12:00:00Z"),
  expiresAt: null,
};

const revoked: AuditLogCredentialRevokedInput = {
  hash: "a".repeat(64),
  revokedAt: new Date("2026-11-09T13:00:00Z"),
  revokedBy: { type: "user", id: "user_1" },
  reason: "revoked",
  graceUntil: null,
  replacedByHash: null,
};

function contextAt(occurredAt: Date): AuditLogContext {
  return {
    occurredAt,
    actor: { type: "user", id: "user_1" },
    credential: null,
    onBehalfOf: null,
    source: "dashboard",
    endpoint: { ip: "203.0.113.7", userAgent: "test" },
    origin: null,
    requestId: "req_1",
  };
}

type InMemoryController = AuditLogController & {
  recorded: Array<[AuditLogInput, AuditLogContext]>;
  fingerprints: AuditLogCredentialFingerprintInput[];
  revocations: AuditLogCredentialRevokedInput[];
  graceUpdates: Array<[string, Date | null]>;
  flushes: number;
};

/** Keeps everything in memory, in place of the enterprise plugin's storage. */
function inMemoryController(overrides: Partial<AuditLogController> = {}): InMemoryController {
  const controller: InMemoryController = {
    recorded: [],
    fingerprints: [],
    revocations: [],
    graceUpdates: [],
    flushes: 0,
    async record(i, c) {
      controller.recorded.push([i, c]);
    },
    async flush() {
      controller.flushes++;
    },
    async saveCredentialFingerprint(i) {
      controller.fingerprints.push(i);
      return { fingerprintId: `fp_${controller.fingerprints.length}` };
    },
    async markCredentialRevoked(i) {
      controller.revocations.push(i);
    },
    async updateCredentialGrace(hash, graceUntil) {
      controller.graceUpdates.push([hash, graceUntil]);
    },
    async findCredentialFingerprint(hash) {
      return controller.fingerprints.some((f) => f.hash === hash)
        ? { fingerprintId: "fp_1" }
        : null;
    },
    async listEvents() {
      return { events: [], nextCursor: "next" };
    },
    ...overrides,
  };
  return controller;
}

function host(options: {
  controller: () => Promise<AuditLogController | null>;
  enabled?: boolean;
}) {
  return createAuditLogs({
    controller: options.controller,
    isRecordingEnabled: () => options.enabled ?? true,
    getContext: contextAt,
  });
}

describe.skipIf(pluginLocallyLinked)("audit log plugin loader, plugin not installed", () => {
  // Catches: self-hosted installs crashing or erroring because the enterprise plugin is absent.
  it("returns null", async () => {
    await expect(loadAuditLogPlugin({ requirePlugins: false, config })).resolves.toBeNull();
  });

  // Catches: a deployment that requires plugins going live without the audit plugin.
  it("throws when REQUIRE_PLUGINS=1", async () => {
    await expect(loadAuditLogPlugin({ requirePlugins: true, config })).rejects.toThrow(
      /REQUIRE_PLUGINS=1 but plugin "@triggerdotdev\/plugins\/audit" did not load/
    );
  });
});

describe("audit logs host", () => {
  // Catches: self-hosted installs (no plugin) throwing or returning data from any method.
  it("does nothing without the plugin", async () => {
    const audit = host({ controller: async () => null });

    expect(() => audit.record(input)).not.toThrow();
    await expect(audit.flush()).resolves.toBeUndefined();
    await expect(audit.isFingerprintingEnabled()).resolves.toBe(false);
    await expect(audit.saveCredentialFingerprint(fingerprint)).resolves.toBeNull();
    expect(() => audit.markCredentialRevoked(revoked)).not.toThrow();
    expect(() => audit.updateCredentialGrace(revoked.hash, null)).not.toThrow();
    await expect(audit.flush()).resolves.toBeUndefined();
    await expect(audit.findCredentialFingerprint(fingerprint.hash)).resolves.toBeNull();
    await expect(
      audit.listEvents({ organizationId: "org_1", from: new Date(0), to: new Date(), limit: 50 })
    ).resolves.toEqual({ events: [], nextCursor: null });
  });

  // Catches: events reaching the plugin after recording is switched off (the rollback path), or
  // fingerprints stopping with it, which would leave keys created meanwhile unattributable.
  it("stops recording events when recording is off but keeps fingerprints", async () => {
    const controller = inMemoryController();
    const audit = host({ controller: async () => controller, enabled: false });

    audit.record(input);
    await audit.flush();
    const saved = await audit.saveCredentialFingerprint(fingerprint);
    audit.markCredentialRevoked(revoked);
    audit.updateCredentialGrace(revoked.hash, null);
    await audit.flush();

    expect(controller.recorded).toHaveLength(0);
    expect(saved).toEqual({ fingerprintId: "fp_1" });
    expect(controller.fingerprints).toEqual([fingerprint]);
    expect(controller.revocations).toEqual([revoked]);
    expect(controller.graceUpdates).toEqual([[revoked.hash, null]]);
  });

  // Catches: the host passing an unresolved context, so a fingerprint looked up during
  // authentication never reaches the event.
  it("waits for a context that resolves later", async () => {
    const controller = inMemoryController();
    const audit = createAuditLogs({
      controller: async () => controller,
      isRecordingEnabled: () => true,
      getContext: async (occurredAt) => ({
        ...contextAt(occurredAt),
        credential: { kind: "root_api_key", id: "env_1", last4: "k9Qz", fingerprintId: "fp_9" },
      }),
    });

    audit.record(input);
    await audit.flush();

    expect(controller.recorded[0]?.[1].credential?.fingerprintId).toBe("fp_9");
  });

  // Catches: the plugin missing the call's context.
  it("passes the input and the request context to the plugin", async () => {
    const controller = inMemoryController();
    const audit = host({ controller: async () => controller });

    audit.record(input);
    await audit.flush();

    expect(controller.recorded).toHaveLength(1);
    const [passedInput, passedContext] = controller.recorded[0]!;
    expect(passedInput).toEqual(input);
    expect(passedContext.actor).toEqual({ type: "user", id: "user_1" });
    expect(passedContext.requestId).toBe("req_1");
    expect(passedContext.occurredAt).toBeInstanceOf(Date);
  });

  // Catches: a failing plugin surfacing as an error in a request whose change already committed.
  it("never throws from record, revocation, grace update or lookup when the plugin fails", async () => {
    const failing = () => Promise.reject(new Error("plugin failed"));
    const cases = [
      host({ controller: failing }),
      host({
        controller: async () =>
          inMemoryController({
            record: failing,
            flush: failing,
            markCredentialRevoked: failing,
            updateCredentialGrace: failing,
            findCredentialFingerprint: failing,
          }),
      }),
    ];

    for (const audit of cases) {
      expect(() => audit.record(input)).not.toThrow();
      expect(() => audit.markCredentialRevoked(revoked)).not.toThrow();
      expect(() => audit.updateCredentialGrace(revoked.hash, null)).not.toThrow();
      await expect(audit.flush()).resolves.toBeUndefined();
      await expect(audit.findCredentialFingerprint(fingerprint.hash)).resolves.toBeNull();
    }
  });

  // Catches: a context that throws or rejects escaping record() into a request whose change
  // already committed, or going unhandled while the plugin is missing or still loading.
  it("never throws or leaves a rejection unhandled when the context fails", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let loadPlugin!: (controller: AuditLogController) => void;
      const slowPlugin = new Promise<AuditLogController>((resolve) => (loadPlugin = resolve));
      const controller = inMemoryController();
      const failingContexts = [
        () => {
          throw new Error("context threw");
        },
        () => Promise.reject(new Error("context rejected")),
      ];
      const plugins = [async () => null, () => slowPlugin, async () => controller];

      const hosts = failingContexts.flatMap((getContext) =>
        plugins.map((plugin) =>
          createAuditLogs({
            controller: plugin,
            isRecordingEnabled: () => true,
            getContext,
          })
        )
      );
      for (const audit of hosts) {
        expect(() => audit.record(input)).not.toThrow();
      }
      // Proves the absence of unhandled rejections while the slow plugin is still loading.
      await setImmediate();
      await setImmediate();
      loadPlugin(controller);
      await Promise.all(hosts.map((audit) => audit.flush()));

      expect(unhandled).toEqual([]);
      expect(controller.recorded).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // Catches: a credential change waiting on the control plane after it committed, or shutdown
  // dropping revocations and grace updates still in flight.
  it("never waits for revocations or grace updates, and flush does", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const controller = inMemoryController();
    const markNow = controller.markCredentialRevoked;
    const graceNow = controller.updateCredentialGrace;
    controller.markCredentialRevoked = async (i) => {
      await gate;
      await markNow(i);
    };
    controller.updateCredentialGrace = async (hash, graceUntil) => {
      await gate;
      await graceNow(hash, graceUntil);
    };
    const audit = host({ controller: async () => controller });

    expect(audit.markCredentialRevoked(revoked)).toBeUndefined();
    expect(audit.updateCredentialGrace(revoked.hash, null)).toBeUndefined();
    const flushed = audit.flush();
    await setImmediate();
    expect(controller.revocations).toHaveLength(0);

    release();
    await flushed;
    expect(controller.revocations).toEqual([revoked]);
    expect(controller.graceUpdates).toEqual([[revoked.hash, null]]);
  });

  // Catches: a revoked key that predates fingerprints getting no row, because the mark ran
  // before the save, a failed save skipped the mark, or flush returned before either finished.
  it("saves fingerprints before marking, and marks even when a save fails", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const controller = inMemoryController({
      async saveCredentialFingerprint(i) {
        await gate;
        calls.push(`save:${i.last4}`);
        if (i.last4 === "fail") throw new Error("control plane down");
        return { fingerprintId: "fp_old" };
      },
      async markCredentialRevoked(i) {
        calls.push(`mark:${i.reason}`);
      },
    });
    const audit = host({ controller: async () => controller });

    audit.markCredentialRevoked(revoked, {
      saveFirst: [
        { ...fingerprint, last4: "fail" },
        { ...fingerprint, last4: "old1", createdAt: null },
      ],
    });
    const flushed = audit.flush();
    await setImmediate();
    expect(calls).toEqual([]);

    release();
    await flushed;
    expect(calls).toEqual(["save:fail", "save:old1", "mark:revoked"]);
  });

  // Catches: a plugin that failed to load (REQUIRE_PLUGINS=1) surfacing its loader message, which
  // names the plugin, to a customer creating or rotating a credential.
  it("hides a plugin load failure behind the generic error", async () => {
    const audit = host({
      controller: () =>
        Promise.reject(new Error('REQUIRE_PLUGINS=1 but plugin "audit" did not load: boom')),
    });

    const saveFailure = await audit.saveCredentialFingerprint(fingerprint).catch((error) => error);
    const checkFailure = await audit.isFingerprintingEnabled().catch((error) => error);

    expect(saveFailure.message).toBe("Something went wrong. Please try again.");
    expect(checkFailure.message).toBe("Something went wrong. Please try again.");
  });

  // Catches: shutdown dropping a revocation that started while flush was already waiting, e.g. a
  // member removal's post-commit marks racing SIGTERM.
  it("flush also waits for work started while it waits", async () => {
    let releaseRecord!: () => void;
    let releaseMark!: () => void;
    const recordGate = new Promise<void>((resolve) => (releaseRecord = resolve));
    const markGate = new Promise<void>((resolve) => (releaseMark = resolve));
    const controller = inMemoryController();
    const recordNow = controller.record;
    const markNow = controller.markCredentialRevoked;
    controller.record = async (i, c) => {
      await recordGate;
      await recordNow(i, c);
    };
    controller.markCredentialRevoked = async (i) => {
      await markGate;
      await markNow(i);
    };
    const audit = host({ controller: async () => controller });

    audit.record(input);
    let flushDone = false;
    const flushed = audit.flush().then(() => (flushDone = true));
    await setImmediate();
    audit.markCredentialRevoked(revoked);
    releaseRecord();
    // Proves flush is still waiting for the mark that started after it did.
    await setImmediate();
    await setImmediate();
    expect(flushDone).toBe(false);

    releaseMark();
    await flushed;
    expect(controller.recorded).toHaveLength(1);
    expect(controller.revocations).toEqual([revoked]);
  });

  // Catches: a key being created with no fingerprint because the failed write was swallowed, or
  // the plugin's error (SQL, table names, the new key's hash) reaching the customer.
  it("lets a failed fingerprint save fail the caller with a generic error", async () => {
    const audit = host({
      controller: async () =>
        inMemoryController({
          saveCredentialFingerprint: () =>
            Promise.reject(new Error('Failed query: insert into "fingerprints" params: aaaa')),
        }),
    });

    const failure = await audit.saveCredentialFingerprint(fingerprint).catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe("Something went wrong. Please try again.");
  });

  // Catches: staff identity, fingerprint ids or internal auth events reaching customers because
  // the plugin returned stored rows as they are.
  it("lists only the fields customers may see", async () => {
    const stored: AuditLogEvent = {
      ...input,
      id: "evt_1",
      occurredAt: new Date("2026-11-09T12:00:00Z"),
      projectId: "proj_1",
      environmentId: "env_1",
      environmentType: "STAGING",
      changes: null,
      actor: { type: "user", id: "user_1" },
      credential: { kind: "pat", id: "pat_1", last4: "k9Qz", fingerprintId: "fp_1" },
      onBehalfOf: { userId: "staff_1" },
      source: "staff",
      endpoint: { ip: "203.0.113.7", userAgent: "test" },
      origin: { deploymentId: "deployment_1" },
      requestId: "req_1",
    };
    const internal: AuditLogEvent = {
      ...stored,
      id: "evt_2",
      category: "auth",
      action: "auth.credential_rejected",
    };
    const controller = inMemoryController({
      listEvents: async () => ({
        events: [{ ...stored, internalNote: "x" }, internal] as never,
        nextCursor: "next",
      }),
    });
    const audit = host({ controller: async () => controller });

    const page = await audit.listEvents({
      organizationId: "org_1",
      from: new Date(0),
      to: new Date(),
      limit: 50,
    });

    const { onBehalfOf: _staff, credential: _credential, ...visible } = stored;
    expect(page).toEqual({
      events: [{ ...visible, credential: { kind: "pat", id: "pat_1", last4: "k9Qz" } }],
      nextCursor: "next",
    });
  });

  // Catches: flush resolving before in-flight records finish, or before the plugin flushes its
  // own buffer, so shutdown drops events.
  it("flush waits for records in flight and then flushes the plugin", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const controller = inMemoryController();
    const recordNow = controller.record;
    controller.record = async (i, c) => {
      await gate;
      await recordNow(i, c);
    };
    const audit = host({ controller: async () => controller });

    audit.record(input);
    const flushed = audit.flush();
    expect(controller.recorded).toHaveLength(0);

    release();
    await flushed;
    expect(controller.recorded).toHaveLength(1);
    expect(controller.flushes).toBe(1);
  });
});
