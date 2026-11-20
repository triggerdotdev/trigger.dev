import { createStandalonePostgresContainer } from "@internal/testcontainers";
import { metrics } from "@internal/tracing";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { AuditLogInput } from "@trigger.dev/plugins";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as Database from "~/db.server";
import type * as AuditContextModule from "~/services/auditLogs/auditContext.server";
import type * as AuditLogsModule from "~/services/auditLogs/auditLogs.server";
import { runWithHttpContext } from "~/services/httpAsyncStorage.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import {
  enableAuditRecording,
  installAuditLogPlugin,
  uninstallAuditLogPlugin,
} from "./helpers/auditLogPlugin";

// Recording starts off, as in production. The per-org flag is read from a real database.
vi.mock("~/env.server", async (original) =>
  (await import("./helpers/auditLogPlugin")).auditRecordingEnv(await original())
);

vi.setConfig({ testTimeout: 30_000 });

// A real meter provider, read on demand. It replaces the one the app's tracer setup registers on
// import, before the counters are first created.
const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const meterProvider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })],
});
metrics.disable();
metrics.setGlobalMeterProvider(meterProvider);

/** `audit_logs.events_without_fingerprint` so far (cumulative), for one reason. */
async function withoutFingerprint(reason: string): Promise<number> {
  await meterProvider.forceFlush();
  const latest = exporter.getMetrics().at(-1);
  exporter.reset();
  return (latest?.scopeMetrics ?? [])
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === "audit_logs.events_without_fingerprint")
    .flatMap((metric) => metric.dataPoints)
    .filter((point) => point.attributes.reason === reason)
    .reduce((sum, point) => sum + (point.value as number), 0);
}

let container: Awaited<ReturnType<typeof createStandalonePostgresContainer>>;
let database: typeof Database;
let auditLogs: typeof AuditLogsModule.auditLogs;
let auditContext: typeof AuditContextModule;

beforeAll(async () => {
  container = await createStandalonePostgresContainer();
  vi.stubEnv("DATABASE_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_URL", container.url);
  vi.stubEnv("DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_READ_REPLICA_URL", container.url);

  database = await import("~/db.server");
  ({ auditLogs } = await import("~/services/auditLogs/auditLogs.server"));
  auditContext = await import("~/services/auditLogs/auditContext.server");
}, 120_000);

afterAll(async () => {
  await database?.$replica.$disconnect();
  await database?.prisma.$disconnect();
  await container?.container.stop();
  vi.unstubAllEnvs();
});

// With an actor and a source, as a call site gives one: the helper drops an event without them.
function memberRemoved(organizationId: string): AuditLogInput {
  return {
    category: "members",
    action: "member.removed",
    organizationId,
    target: { type: "member", id: "user_1", name: null },
    actor: { type: "user", id: "user_2" },
    source: "dashboard",
  };
}

describe("audit log recording in tests", () => {
  let disableRecording: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await disableRecording?.();
    disableRecording = undefined;
    uninstallAuditLogPlugin();
  });

  // Catches: the shared helper not capturing events, or recording staying off, which would make
  // every call-site test pass while asserting nothing.
  it("captures what call sites record, with the input's overrides", async () => {
    const { recorded } = installAuditLogPlugin();
    disableRecording = await enableAuditRecording();

    auditLogs.record({
      category: "support",
      action: "support.session_started",
      organizationId: "org_1",
      target: { type: "user", id: "user_1", name: null },
      actor: { type: "support", id: null },
      source: "staff",
      onBehalfOf: { userId: "staff_1" },
    });
    await auditLogs.flush();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.input).toMatchObject({
      action: "support.session_started",
      actor: { type: "support", id: null },
      source: "staff",
      onBehalfOf: { userId: "staff_1" },
    });
  });

  // Catches: recording on by default in tests, so call sites would record where production doesn't.
  it("records nothing while recording is off", async () => {
    const { recorded } = installAuditLogPlugin();

    auditLogs.record(memberRemoved("org_1"));
    await auditLogs.flush();

    expect(recorded).toEqual([]);
  });

  // Catches: the helper keeping an event the real plugin drops, so a call site that loses the actor
  // passes its test while production stores nothing. The helper applies the plugin's own rule
  // (resolveAuditEventAttribution); its cases are tested in the plugins package.
  it("drops an event with no actor, as the real plugin does", async () => {
    const { recorded, dropped } = installAuditLogPlugin();
    disableRecording = await enableAuditRecording();

    auditLogs.record({
      category: "members",
      action: "member.removed",
      organizationId: "org_1",
      target: { type: "member", id: "user_1", name: null },
      source: "dashboard",
    });
    await auditLogs.flush();

    expect(recorded).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toBe("missing_actor");
    expect(dropped[0]!.input.action).toBe("member.removed");
  });

  // Catches: the helper bypassing the per-org gate instead of setting the global flag, or the
  // gate recording for an org without the flag once the env switch is on.
  it("records through the real flag: the global row, else the org's override", async () => {
    const { recorded } = installAuditLogPlugin();
    disableRecording = await enableAuditRecording();
    const key = FEATURE_FLAG.auditLogsRecording;
    const globalRow = await database.prisma.featureFlag.findFirst({ where: { key } });
    expect(globalRow?.value).toBe(true);

    await database.prisma.featureFlag.deleteMany({ where: { key } });
    const flagged = await database.prisma.organization.create({
      data: { title: "flagged", slug: `flagged-${Date.now()}`, featureFlags: { [key]: true } },
    });
    auditLogs.record(memberRemoved("org_without_flag"));
    auditLogs.record(memberRemoved(flagged.id));
    await auditLogs.flush();

    expect(recorded.map(({ input }) => input.organizationId)).toEqual([flagged.id]);
  });

  // Catches: events an org doesn't record (its flag is off) counted as missing their credential's
  // fingerprint, which would raise false alerts during a staged rollout. The helper's plugin finds
  // no fingerprint, so each recorded event with a root key misses one.
  it("counts a missing fingerprint only for an event the org records", async () => {
    const { recorded } = installAuditLogPlugin();
    disableRecording = await enableAuditRecording();
    const key = FEATURE_FLAG.auditLogsRecording;
    await database.prisma.featureFlag.deleteMany({ where: { key } });
    const flagged = await database.prisma.organization.create({
      data: { title: "flagged", slug: `flagged-fp-${Date.now()}`, featureFlags: { [key]: true } },
    });
    const before = await withoutFingerprint("request_not_found");

    const apiKey = "tr_prod_abcdefghijklmnopqrstuvwxyz0123";
    await runWithHttpContext(
      {
        requestId: "req_test",
        path: "/api/v1/test",
        host: "api.trigger.dev",
        method: "POST",
        abortController: new AbortController(),
      },
      async () => {
        auditContext.noteLegacyApiKeyAuthentication(
          new Request("https://api.trigger.dev/api/v1/test", {
            headers: { Authorization: `Bearer ${apiKey}` },
          }),
          {
            ok: true,
            apiKey,
            type: "PRIVATE",
            environment: { id: "env_1", parentEnvironmentId: null },
          }
        );
        auditLogs.record(memberRemoved("org_without_flag"));
        auditLogs.record(memberRemoved(flagged.id));
      }
    );
    await auditLogs.flush();

    expect(recorded.map(({ input }) => input.organizationId)).toEqual([flagged.id]);
    expect(recorded[0]!.context.credential).toMatchObject({
      kind: "root_api_key",
      fingerprintId: null,
    });
    expect((await withoutFingerprint("request_not_found")) - before).toBe(1);
  });

  // Catches: the helper's undo leaving the global row behind, so later tests record while off.
  it("removes the global row it added when undone", async () => {
    const undo = await enableAuditRecording();
    await undo();

    await expect(
      database.prisma.featureFlag.findFirst({ where: { key: FEATURE_FLAG.auditLogsRecording } })
    ).resolves.toBeNull();
  });
});
