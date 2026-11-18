import { createStandalonePostgresContainer } from "@internal/testcontainers";
import type { AuditLogContext, AuditLogInput } from "@trigger.dev/plugins";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Database from "~/db.server";
import type * as AuditLogsModule from "~/services/auditLogs/auditLogs.server";
import type * as EnvVarReadAudit from "~/services/auditLogs/envVarReadAudit.server";
import type { EnvironmentVariableReadInput } from "~/services/auditLogs/envVarReadAudit.server";
import type * as HttpAsyncStorage from "~/services/httpAsyncStorage.server";
import type { RequestAuditIdentity } from "~/services/httpAsyncStorage.server";
import {
  enableAuditRecording,
  installAuditLogPlugin,
  uninstallAuditLogPlugin,
} from "./helpers/auditLogPlugin";

// The read rollup and the read recorders, without routes: each read is recorded with the request's
// identity, and repeated API reads are rolled up. Recording is on through the real gate, whose flag is
// read from a real database. The routes, auth and presenters are covered end to end in
// envVarReadAuditRoutes.test.ts and envVarReadAuditBuildServer.test.ts.

vi.mock("~/env.server", async (original) =>
  (await import("./helpers/auditLogPlugin")).auditRecordingEnv(await original())
);

vi.setConfig({ testTimeout: 30_000 });

let container: Awaited<ReturnType<typeof createStandalonePostgresContainer>>;
let database: typeof Database;
let auditLogs: typeof AuditLogsModule.auditLogs;
let envVarReadAudit: typeof EnvVarReadAudit;
let httpAsyncStorage: typeof HttpAsyncStorage;

beforeAll(async () => {
  container = await createStandalonePostgresContainer();
  vi.stubEnv("DATABASE_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_URL", container.url);
  vi.stubEnv("DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_READ_REPLICA_URL", container.url);

  database = await import("~/db.server");
  ({ auditLogs } = await import("~/services/auditLogs/auditLogs.server"));
  envVarReadAudit = await import("~/services/auditLogs/envVarReadAudit.server");
  httpAsyncStorage = await import("~/services/httpAsyncStorage.server");
}, 120_000);

afterAll(async () => {
  await database?.$replica.$disconnect();
  await database?.prisma.$disconnect();
  await container?.container.stop();
  vi.unstubAllEnvs();
});

const apiKeyIdentity = (overrides: Partial<RequestAuditIdentity> = {}): RequestAuditIdentity => ({
  actor: { type: "api_key", id: "env_dev" },
  credential: { kind: "root_api_key", id: "env_dev", last4: "abcd", fingerprintId: null },
  onBehalfOf: null,
  source: "cli",
  endpoint: { ip: "203.0.113.7", userAgent: "trigger.dev-cli/4.8.5" },
  origin: null,
  ...overrides,
});

const sessionIdentity = (): RequestAuditIdentity => ({
  actor: { type: "user", id: "user_1" },
  credential: null,
  onBehalfOf: null,
  source: "dashboard",
  endpoint: { ip: "198.51.100.2", userAgent: "Mozilla/5.0" },
  origin: null,
});

/** Runs `fn` inside a request whose auth functions noted `identity`, as server.ts would. */
function inRequest<T>(identity: RequestAuditIdentity | undefined, fn: () => Promise<T>) {
  return httpAsyncStorage.runWithHttpContext(
    {
      requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
      path: "/test",
      host: "localhost",
      method: "GET",
      abortController: new AbortController(),
      auditIdentity: identity ? structuredClone(identity) : undefined,
    },
    fn
  );
}

let recorded: Array<{ input: AuditLogInput; context: AuditLogContext }>;
let disableRecording: (() => Promise<void>) | undefined;

/** Each test starts with an empty rollup, as a freshly started process would. */
function resetSharedRollup() {
  delete (globalThis as any).__trigger_singletons?.auditEnvVarReadRollup;
}

beforeEach(async () => {
  resetSharedRollup();
  recorded = installAuditLogPlugin().recorded;
  disableRecording = await enableAuditRecording();
});

afterEach(async () => {
  await disableRecording?.();
  disableRecording = undefined;
  uninstallAuditLogPlugin();
  vi.restoreAllMocks();
});

async function flushed() {
  await auditLogs.flush();
  return recorded;
}

describe("read rollup", () => {
  const key = "org|env|listed|api_key|ip";

  // Catches: the first read of a key being suppressed, or repeats not being suppressed.
  it("records the first read and suppresses repeats within the idle window", () => {
    let now = 0;
    const rollup = envVarReadAudit.createReadRollup({
      idleMs: 1_000,
      maxAgeMs: 10_000,
      now: () => now,
    });
    expect(rollup.shouldRecord(key)).toBe(true);
    for (let i = 0; i < 5; i++) {
      now += 500;
      expect(rollup.shouldRecord(key)).toBe(false);
    }
  });

  // Catches: the window never closing, so a later session would be hidden behind an earlier one.
  it("records again once the key has been idle for the window", () => {
    let now = 0;
    const rollup = envVarReadAudit.createReadRollup({
      idleMs: 1_000,
      maxAgeMs: 10_000,
      now: () => now,
    });
    expect(rollup.shouldRecord(key)).toBe(true);
    now += 999;
    expect(rollup.shouldRecord(key)).toBe(false);
    now += 1_000;
    expect(rollup.shouldRecord(key)).toBe(true);
  });

  // Catches: a reader that never stops being hidden forever by the idle extension.
  it("records again after the maximum age even while reads keep coming", () => {
    let now = 0;
    const rollup = envVarReadAudit.createReadRollup({
      idleMs: 1_000,
      maxAgeMs: 3_000,
      now: () => now,
    });
    const results: boolean[] = [];
    for (let i = 0; i <= 8; i++) {
      results.push(rollup.shouldRecord(key));
      now += 500;
    }
    // Reads at 0..4000 ms every 500 ms: recorded at 0 and at 3000 ms.
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(results[0]).toBe(true);
    expect(results[6]).toBe(true);
  });

  // Catches: unbounded memory, and eviction hiding a first read instead of causing an extra one.
  it("keeps at most maxKeys keys, evicting the least recently read", () => {
    let now = 0;
    const rollup = envVarReadAudit.createReadRollup({
      idleMs: 60_000,
      maxAgeMs: 60_000,
      maxKeys: 3,
      now: () => now,
    });
    for (const k of ["a", "b", "c"]) expect(rollup.shouldRecord(k)).toBe(true);
    now += 1;
    expect(rollup.shouldRecord("a")).toBe(false); // a is now the most recently read
    expect(rollup.shouldRecord("d")).toBe(true); // evicts b
    expect(rollup.size).toBe(3);
    expect(rollup.shouldRecord("a")).toBe(false);
    expect(rollup.shouldRecord("b")).toBe(true);
  });
});

describe("recordRolledUpEnvironmentVariableRead", () => {
  const input: EnvironmentVariableReadInput = {
    action: "envvar.listed",
    organizationId: "org_1",
    projectId: "project_1",
    environmentId: "env_dev",
    environmentType: "DEVELOPMENT",
    target: { type: "environment", id: "env_dev", name: "dev" },
  };

  // Catches: a dev CLI session recording one event per rebuild instead of one per session.
  it("rolls a dev CLI session's rebuild reads up into one event", async () => {
    for (let rebuild = 0; rebuild < 25; rebuild++) {
      await inRequest(apiKeyIdentity(), async () =>
        envVarReadAudit.recordRolledUpEnvironmentVariableRead(input)
      );
    }
    const events = await flushed();
    expect(events).toHaveLength(1);
    expect(events[0]!.context).toMatchObject({
      actor: { type: "api_key", id: "env_dev" },
      credential: { kind: "root_api_key", last4: "abcd" },
      source: "cli",
    });
  });

  // Catches: a leaked key used from another IP, or another credential, hidden in an existing rollup.
  it("records reads from another IP, credential or actor separately", async () => {
    await inRequest(apiKeyIdentity(), async () =>
      envVarReadAudit.recordRolledUpEnvironmentVariableRead(input)
    );
    await inRequest(
      apiKeyIdentity({ endpoint: { ip: "192.0.2.99", userAgent: "trigger.dev-cli/4.8.5" } }),
      async () => envVarReadAudit.recordRolledUpEnvironmentVariableRead(input)
    );
    await inRequest(
      apiKeyIdentity({
        actor: { type: "api_key", id: "key_2" },
        credential: { kind: "additional_api_key", id: "key_2", last4: "wxyz", fingerprintId: null },
      }),
      async () => envVarReadAudit.recordRolledUpEnvironmentVariableRead(input)
    );
    await inRequest(sessionIdentity(), async () =>
      envVarReadAudit.recordRolledUpEnvironmentVariableRead(input)
    );
    expect(await flushed()).toHaveLength(4);
  });

  // Catches: a listing and a single-key read, or two environments, sharing one rollup.
  it("rolls up per action, environment and target", async () => {
    await inRequest(apiKeyIdentity(), async () => {
      envVarReadAudit.recordRolledUpEnvironmentVariableRead(input);
      envVarReadAudit.recordRolledUpEnvironmentVariableRead({
        ...input,
        environmentId: "env_prod",
        environmentType: "PRODUCTION",
      });
      envVarReadAudit.recordRolledUpEnvironmentVariableRead({
        ...input,
        action: "envvar.read",
        target: { type: "environment_variable", id: "envvar_1", name: "A" },
      });
      envVarReadAudit.recordRolledUpEnvironmentVariableRead({
        ...input,
        action: "envvar.read",
        target: { type: "environment_variable", id: "envvar_2", name: "B" },
      });
    });
    expect(await flushed()).toHaveLength(4);
  });

  // Catches: reads filling the rollup while recording is off, so turning it on would hide reads.
  it("records nothing and keeps no rollup state while recording is off", async () => {
    await disableRecording?.();
    disableRecording = undefined;
    await inRequest(apiKeyIdentity(), async () =>
      envVarReadAudit.recordRolledUpEnvironmentVariableRead(input)
    );
    expect(await flushed()).toHaveLength(0);

    disableRecording = await enableAuditRecording();
    await inRequest(apiKeyIdentity(), async () =>
      envVarReadAudit.recordRolledUpEnvironmentVariableRead(input)
    );
    expect(await flushed()).toHaveLength(1);
  });

  // Catches: a recording failure escaping into the read.
  it("never throws when recording fails", async () => {
    vi.spyOn(auditLogs, "record").mockImplementation(() => {
      throw new Error("plugin exploded");
    });
    await inRequest(apiKeyIdentity(), async () => {
      expect(() => envVarReadAudit.recordRolledUpEnvironmentVariableRead(input)).not.toThrow();
    });
  });

  // Catches: dashboard loads or build server reads rolled up like API reads.
  it("records every read that isn't rolled up", async () => {
    for (let load = 0; load < 3; load++) {
      await inRequest(apiKeyIdentity(), async () =>
        envVarReadAudit.recordEnvironmentVariableRead(input)
      );
    }
    expect(await flushed()).toHaveLength(3);
  });
});

describe("build server", () => {
  // Catches: build server reads rolled up, so a retried or repeated build read goes unrecorded.
  it("records every build server read, each with its deployment", async () => {
    const input: EnvironmentVariableReadInput = {
      action: "envvar.listed",
      organizationId: "org_1",
      projectId: "project_1",
      environmentId: "env_prod",
      environmentType: "PRODUCTION",
      target: { type: "environment", id: "env_prod", name: "prod" },
    };
    for (const deploymentId of ["deployment_a", "deployment_a", "deployment_b"]) {
      await inRequest(apiKeyIdentity(), async () => {
        envVarReadAudit.noteDeploymentOrigin({ deploymentId });
        envVarReadAudit.recordEnvironmentVariableRead(input);
      });
    }
    const events = await flushed();
    expect(events.map((event) => event.context.origin?.deploymentId)).toEqual([
      "deployment_a",
      "deployment_a",
      "deployment_b",
    ]);
  });

  // Catches: noting a deployment outside an authenticated request inventing an identity.
  it("does nothing outside an authenticated request", async () => {
    await inRequest(undefined, async () => {
      expect(() =>
        envVarReadAudit.noteDeploymentOrigin({ deploymentId: "deployment_a" })
      ).not.toThrow();
    });
  });
});
