import { postgresTest } from "@internal/testcontainers";
import { metrics } from "@internal/tracing";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { generateJWT } from "@trigger.dev/core/v3/jwt";
import type { PrismaClient } from "@trigger.dev/database";
import plugin from "@trigger.dev/rbac";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countMissingFingerprint,
  getRequestAuditContext,
  noteLegacyApiKeyAuthentication,
  noteOrganizationAccessTokenAuthentication,
  notePersonalAccessTokenAuthentication,
} from "~/services/auditLogs/auditContext.server";
import { authenticateBearerWithTelemetry } from "~/services/authTelemetry.server";
import { getHttpContext, runWithHttpContext } from "~/services/httpAsyncStorage.server";
import { generateAdditionalApiKey, hashApiKey } from "~/utils/apiKeys";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";
import {
  installFingerprintLookupPlugin,
  uninstallFingerprintLookupPlugin,
} from "./helpers/fingerprintLookupPlugin";

vi.setConfig({ testTimeout: 60_000 });

// A real meter provider, read on demand. It replaces the one the app's tracer setup registers on
// import, before the counter is first created.
const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const meterProvider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })],
});
metrics.disable();
metrics.setGlobalMeterProvider(meterProvider);

/** `audit_logs.events_without_fingerprint` so far (cumulative), for one reason or all of them. */
async function withoutFingerprint(reason?: string): Promise<number> {
  await meterProvider.forceFlush();
  const latest = exporter.getMetrics().at(-1);
  exporter.reset();
  return (latest?.scopeMetrics ?? [])
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === "audit_logs.events_without_fingerprint")
    .flatMap((metric) => metric.dataPoints)
    .filter((point) => reason === undefined || point.attributes.reason === reason)
    .reduce((sum, point) => sum + (point.value as number), 0);
}

afterEach(() => {
  uninstallFingerprintLookupPlugin();
});

function apiRequest(token: string) {
  return new Request("https://api.trigger.dev/api/v1/projects/proj/envvars/prod", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Runs `fn` the way server.ts runs a request. Returns the identity the auth functions stored and
 * the audit context an event recorded at the end of the request would get. With `events: 0` the
 * request records nothing; with 2 it records twice.
 */
async function inRequest(fn: () => Promise<unknown>, { events = 1 } = {}) {
  return runWithHttpContext(
    {
      requestId: "req_test",
      path: "/api/v1/test",
      host: "api.trigger.dev",
      method: "GET",
      abortController: new AbortController(),
    },
    async () => {
      await fn();
      const contexts = Array.from({ length: events }, () => getRequestAuditContext(new Date()));
      return { identity: getHttpContext()?.auditIdentity, context: contexts[0], contexts };
    }
  );
}

function controllerFor(prisma: PrismaClient) {
  return plugin.create({ primary: prisma, replica: prisma }, { forceFallback: true });
}

async function createProductionEnvironment(prisma: PrismaClient) {
  const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
  const apiKey = `tr_prod_${uniqueId("root").replace(/-/g, "")}`;
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    apiKey,
  });
  return { environment, user, apiKey };
}

/** A root key authenticated by the pre-RBAC path, which needs no database. */
function noteLegacyRootKey(apiKey: string) {
  noteLegacyApiKeyAuthentication(apiRequest(apiKey), {
    ok: true,
    apiKey,
    type: "PRIVATE",
    environment: { id: "env_1", parentEnvironmentId: null },
  });
}

const LEGACY_ROOT_KEY = "tr_prod_abcdefghijklmnopqrstuvwxyz0123";

describe("credential fingerprints in the request audit context", () => {
  postgresTest("gives a root key request's events the key's fingerprint", async ({ prisma }) => {
    const { environment, apiKey } = await createProductionEnvironment(prisma);
    const { lookups } = installFingerprintLookupPlugin(async (hash) =>
      hash === hashApiKey(apiKey) ? { fingerprintId: "fp_root" } : null
    );

    const { context } = await inRequest(() =>
      authenticateBearerWithTelemetry(apiRequest(apiKey), {}, controllerFor(prisma))
    );

    expect((await context).credential).toEqual({
      kind: "root_api_key",
      id: environment.id,
      last4: apiKey.slice(-4),
      fingerprintId: "fp_root",
    });
    expect(lookups).toEqual([hashApiKey(apiKey)]);
  });

  postgresTest("looks up a public JWT by the root key that signed it", async ({ prisma }) => {
    const { environment, apiKey } = await createProductionEnvironment(prisma);
    const { lookups } = installFingerprintLookupPlugin(async (hash) =>
      hash === hashApiKey(apiKey) ? { fingerprintId: "fp_signer" } : null
    );
    const token = await generateJWT({
      secretKey: apiKey,
      payload: { pub: true, sub: environment.id, scopes: ["read:runs"] },
    });

    const { context } = await inRequest(() =>
      authenticateBearerWithTelemetry(apiRequest(token), { allowJWT: true }, controllerFor(prisma))
    );

    expect((await context).credential).toMatchObject({
      kind: "public_jwt",
      fingerprintId: "fp_signer",
    });
    expect(lookups).toEqual([hashApiKey(apiKey)]);
  });

  postgresTest(
    "records no fingerprint, without holding up the request, when the lookup never answers",
    async ({ prisma }) => {
      const { apiKey } = await createProductionEnvironment(prisma);
      const { lookups } = installFingerprintLookupPlugin(() => new Promise(() => {}));

      // Authentication resolving at all shows it doesn't wait for the lookup, which never settles.
      const { context } = await inRequest(() =>
        authenticateBearerWithTelemetry(apiRequest(apiKey), {}, controllerFor(prisma))
      );

      const startedAt = performance.now();
      expect((await context).credential?.fingerprintId).toBeNull();
      expect(performance.now() - startedAt).toBeLessThan(5_000);
      expect(lookups).toHaveLength(1);
    }
  );

  /** Catches: a failing lookup failing the event instead of recording it without a fingerprint. */
  it("records no fingerprint when the lookup fails", async () => {
    const { lookups } = installFingerprintLookupPlugin(async () => {
      throw new Error("control plane unavailable");
    });

    const before = await withoutFingerprint("request_not_found");
    const { context } = await inRequest(async () => noteLegacyRootKey(LEGACY_ROOT_KEY));

    const resolved = await context;
    expect(resolved.credential).toMatchObject({ id: "env_1", fingerprintId: null });
    expect(lookups).toEqual([hashApiKey(LEGACY_ROOT_KEY)]);
    // The host logs the failure and answers null, so it counts with the keys it didn't find.
    countMissingFingerprint(resolved);
    expect((await withoutFingerprint("request_not_found")) - before).toBe(1);
  });

  /**
   * Catches: root key events stored without their fingerprint and counted nowhere, because the
   * lookup that gives them one runs here, not in the plugin's writer.
   */
  it("counts the events recorded without a fingerprint, by reason", async () => {
    const before = {
      notFound: await withoutFingerprint("request_not_found"),
      timedOut: await withoutFingerprint("request_lookup_timed_out"),
      all: await withoutFingerprint(),
    };

    installFingerprintLookupPlugin(async () => null);
    const notFound = await inRequest(async () => noteLegacyRootKey(LEGACY_ROOT_KEY), {
      events: 2,
    });
    for (const context of await Promise.all(notFound.contexts)) countMissingFingerprint(context);
    expect((await withoutFingerprint("request_not_found")) - before.notFound).toBe(2);

    uninstallFingerprintLookupPlugin();
    installFingerprintLookupPlugin(() => new Promise(() => {}));
    const slow = await inRequest(async () => noteLegacyRootKey(LEGACY_ROOT_KEY));
    const slowContext = await slow.context;
    expect(slowContext.credential?.fingerprintId).toBeNull();
    countMissingFingerprint(slowContext);
    expect((await withoutFingerprint("request_lookup_timed_out")) - before.timedOut).toBe(1);

    uninstallFingerprintLookupPlugin();
    installFingerprintLookupPlugin(async () => ({ fingerprintId: "fp_root" }));
    const found = await inRequest(async () => noteLegacyRootKey(LEGACY_ROOT_KEY));
    const foundContext = await found.context;
    expect(foundContext.credential?.fingerprintId).toBe("fp_root");
    countMissingFingerprint(foundContext);
    expect((await withoutFingerprint()) - before.all).toBe(3);
  });

  /** Catches: a plugin that failed to load failing the event instead of recording it. */
  it("records no fingerprint when the plugin fails to load", async () => {
    const global = globalThis as { __trigger_singletons?: Record<string, unknown> };
    global.__trigger_singletons ??= {};
    const singletons = global.__trigger_singletons;
    const failedLoad = Promise.reject(new Error("plugin did not load"));
    failedLoad.catch(() => {});
    singletons.auditLogController = failedLoad;

    const { identity, context } = await inRequest(async () => noteLegacyRootKey(LEGACY_ROOT_KEY));

    expect(identity?.lookUpCredentialFingerprint).toBeDefined();
    expect((await context).credential?.fingerprintId).toBeNull();
  });

  /** Catches: a lookup on sign-in for a key the legacy path can't identify by row id. */
  it("looks up legacy root and additional keys by their own hash", async () => {
    const { lookups } = installFingerprintLookupPlugin(async (hash) =>
      hash === hashApiKey(LEGACY_ROOT_KEY)
        ? { fingerprintId: "fp_root" }
        : { fingerprintId: "fp_additional" }
    );
    const additionalApiKey = generateAdditionalApiKey("PRODUCTION").apiKey;

    const root = await inRequest(async () => noteLegacyRootKey(LEGACY_ROOT_KEY));
    const additional = await inRequest(async () =>
      noteLegacyApiKeyAuthentication(apiRequest(additionalApiKey), {
        ok: true,
        apiKey: additionalApiKey,
        type: "PRIVATE",
        environment: { id: "env_1", parentEnvironmentId: null },
      })
    );

    expect((await root.context).credential).toMatchObject({
      kind: "root_api_key",
      fingerprintId: "fp_root",
    });
    expect((await additional.context).credential).toMatchObject({
      kind: "additional_api_key",
      id: null,
      fingerprintId: "fp_additional",
    });
    expect(lookups).toEqual([hashApiKey(LEGACY_ROOT_KEY), hashApiKey(additionalApiKey)]);
  });

  /** Catches: a plugin query on every PAT or OAT request, though both have a row id. */
  it("starts no lookup for a personal or organization access token", async () => {
    const { lookups } = installFingerprintLookupPlugin(async () => ({ fingerprintId: "fp_token" }));

    const pat = await inRequest(async () =>
      notePersonalAccessTokenAuthentication(apiRequest("tr_pat_abcdefghijklmnopqrstuvwxyz0123"), {
        userId: "user_1",
        tokenId: "pat_1",
      })
    );
    const oat = await inRequest(async () =>
      noteOrganizationAccessTokenAuthentication(
        apiRequest("tr_oat_abcdefghijklmnopqrstuvwxyz0123"),
        { tokenId: "oat_1" }
      )
    );

    expect(pat.identity?.lookUpCredentialFingerprint).toBeUndefined();
    expect(oat.identity?.lookUpCredentialFingerprint).toBeUndefined();
    // The kind and id are what the audit plugin finds the fingerprint by.
    expect((await pat.context).credential).toMatchObject({
      kind: "pat",
      id: "pat_1",
      fingerprintId: null,
    });
    expect((await oat.context).credential).toMatchObject({
      kind: "oat",
      id: "oat_1",
      fingerprintId: null,
    });
    expect(lookups).toEqual([]);
  });

  /** Catches: a plugin query on every additional key request, though the key has a row id. */
  postgresTest("starts no lookup for an RBAC additional key", async ({ prisma }) => {
    const { environment, user } = await createProductionEnvironment(prisma);
    const additionalApiKey = generateAdditionalApiKey("PRODUCTION").apiKey;
    const row = await prisma.apiKey.create({
      data: {
        name: "Integration",
        keyHash: createHash("sha256").update(additionalApiKey).digest("hex"),
        lastFour: additionalApiKey.slice(-4),
        runtimeEnvironmentId: environment.id,
        createdByUserId: user.id,
        scopes: ["admin"],
      },
    });
    const { lookups } = installFingerprintLookupPlugin(async () => ({
      fingerprintId: "fp_additional",
    }));

    const { identity, context } = await inRequest(() =>
      authenticateBearerWithTelemetry(apiRequest(additionalApiKey), {}, controllerFor(prisma))
    );

    expect(identity?.lookUpCredentialFingerprint).toBeUndefined();
    expect((await context).credential).toMatchObject({
      kind: "additional_api_key",
      id: row.id,
      fingerprintId: null,
    });
    expect(lookups).toEqual([]);
  });

  /** Catches: a plugin query on every authenticated request, though most record no event. */
  postgresTest("looks up nothing for a request that records no event", async ({ prisma }) => {
    const { apiKey } = await createProductionEnvironment(prisma);
    const { lookups } = installFingerprintLookupPlugin(async () => ({ fingerprintId: "fp_root" }));

    const { identity } = await inRequest(
      () => authenticateBearerWithTelemetry(apiRequest(apiKey), {}, controllerFor(prisma)),
      { events: 0 }
    );

    expect(identity?.lookUpCredentialFingerprint).toBeDefined();
    expect(lookups).toEqual([]);
  });

  /** Catches: each event in a request querying the plugin again for the same credential. */
  postgresTest("shares one lookup between a request's events", async ({ prisma }) => {
    const { apiKey } = await createProductionEnvironment(prisma);
    const { lookups } = installFingerprintLookupPlugin(async () => ({ fingerprintId: "fp_root" }));

    const { contexts } = await inRequest(
      () => authenticateBearerWithTelemetry(apiRequest(apiKey), {}, controllerFor(prisma)),
      { events: 2 }
    );

    for (const context of contexts) {
      expect((await context).credential?.fingerprintId).toBe("fp_root");
    }
    expect(lookups).toEqual([hashApiKey(apiKey)]);
  });

  postgresTest("stores neither the key nor its hash in the request", async ({ prisma }) => {
    const { apiKey } = await createProductionEnvironment(prisma);
    installFingerprintLookupPlugin(async () => ({ fingerprintId: "fp_root" }));

    const { identity, context } = await inRequest(() =>
      authenticateBearerWithTelemetry(apiRequest(apiKey), {}, controllerFor(prisma))
    );
    await context;

    const stored = JSON.stringify(identity);
    expect(stored).not.toContain(apiKey);
    expect(stored).not.toContain(hashApiKey(apiKey));
    // The lookup is kept only as a function that resolves to the fingerprint id.
    expect(Object.keys(identity ?? {}).sort()).toEqual([
      "actor",
      "credential",
      "endpoint",
      "lookUpCredentialFingerprint",
      "onBehalfOf",
      "origin",
      "source",
    ]);
    await expect(identity?.lookUpCredentialFingerprint?.()).resolves.toBe("fp_root");
  });
});
