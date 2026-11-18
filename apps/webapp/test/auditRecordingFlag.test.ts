// The per-org audit recording gate against real Postgres: org override, then the global
// FeatureFlag row, then off. Reads are counted by a delegating wrapper around the real client.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresBlipTest, postgresTest } from "@internal/testcontainers";
import { setTimeout } from "node:timers/promises";
import { Client } from "pg";
import { afterEach, describe, expect, vi } from "vitest";
import type { PrismaClientOrTransaction } from "~/db.server";
import { createAuditRecordingFlag } from "~/services/auditLogs/auditRecordingFlag.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeSetFlag } from "~/v3/featureFlags.server";

vi.setConfig({ testTimeout: 60_000 });

const KEY = FEATURE_FLAG.auditLogsRecording;
const TTL_MS = 30_000;

function countingClient(prisma: PrismaClient) {
  const reads = { organization: 0, featureFlag: 0 };
  const client = {
    organization: {
      findFirst: (args: unknown) => {
        reads.organization++;
        return (prisma.organization.findFirst as (a: unknown) => unknown)(args);
      },
    },
    featureFlag: {
      findFirst: (args: unknown) => {
        reads.featureFlag++;
        return (prisma.featureFlag.findFirst as (a: unknown) => unknown)(args);
      },
    },
  } as unknown as PrismaClientOrTransaction;
  return { client, reads };
}

function gate(client: PrismaClientOrTransaction) {
  return createAuditRecordingFlag({
    prisma: client,
    cacheTtlMs: TTL_MS,
    cacheMaxEntries: 100,
    lookupTimeoutMs: 1_000,
  });
}

async function createOrg(prisma: PrismaClient, featureFlags?: Record<string, unknown>) {
  const slug = `org-${Math.random().toString(36).slice(2, 10)}`;
  return prisma.organization.create({ data: { title: slug, slug, featureFlags } });
}

/** Closes the test's database to new connections and drops the open ones, until `end`. */
async function startDatabaseOutage(connectionUri: string) {
  const url = new URL(connectionUri);
  const database = url.pathname.slice(1);
  url.pathname = "/postgres";

  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`ALTER DATABASE "${database}" WITH ALLOW_CONNECTIONS false`);
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [
    database,
  ]);

  return {
    async end() {
      await admin.query(`ALTER DATABASE "${database}" WITH ALLOW_CONNECTIONS true`);
      await admin.end();
    },
  };
}

describe("audit recording flag", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Catches: the org override being ignored, so an org turned on alone records nothing.
  postgresTest("an org override of true records", async ({ prisma }) => {
    const org = await createOrg(prisma, { [KEY]: true });

    await expect(gate(prisma)(org.id)).resolves.toBe(true);
  });

  // Catches: the global value beating the org override, so an org turned off still records.
  postgresTest("an org override of false wins over a global true", async ({ prisma }) => {
    await makeSetFlag(prisma)({ key: KEY, value: true });
    const org = await createOrg(prisma, { [KEY]: false });

    await expect(gate(prisma)(org.id)).resolves.toBe(false);
  });

  // Catches: the global row being ignored for orgs without an override.
  postgresTest("an org without an override follows a global true", async ({ prisma }) => {
    await makeSetFlag(prisma)({ key: KEY, value: true });
    const org = await createOrg(prisma, { someOtherFlag: true });

    await expect(gate(prisma)(org.id)).resolves.toBe(true);
  });

  // Catches: recording defaulting on, for every org, as soon as the env switch is on.
  postgresTest("records nothing without an override or a global row", async ({ prisma }) => {
    const org = await createOrg(prisma);

    await expect(gate(prisma)(org.id)).resolves.toBe(false);
  });

  // Catches: an event without an org failing the lookup or reading an org row instead of following
  // the global flag.
  postgresTest("an event without an org follows the global flag alone", async ({ prisma }) => {
    const { client, reads } = countingClient(prisma);

    await expect(gate(client)(null)).resolves.toBe(false);
    await makeSetFlag(prisma)({ key: KEY, value: true });
    await expect(gate(client)(null)).resolves.toBe(true);
    expect(reads.organization).toBe(0);
  });

  // Catches: a database read per recorded event, an org's answer reused for another org or for
  // events without an org, or a flag change never taking effect.
  postgresTest("caches each org's answer for the TTL", async ({ prisma }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const on = await createOrg(prisma, { [KEY]: true });
    const off = await createOrg(prisma, { [KEY]: false });
    const { client, reads } = countingClient(prisma);
    const isRecordingEnabledFor = gate(client);

    await expect(isRecordingEnabledFor(on.id)).resolves.toBe(true);
    await expect(isRecordingEnabledFor(off.id)).resolves.toBe(false);
    await expect(isRecordingEnabledFor(null)).resolves.toBe(false);
    expect(reads).toEqual({ organization: 2, featureFlag: 1 });

    await prisma.organization.update({
      where: { id: off.id },
      data: { featureFlags: { [KEY]: true } },
    });
    vi.advanceTimersByTime(TTL_MS - 1);
    await expect(isRecordingEnabledFor(on.id)).resolves.toBe(true);
    await expect(isRecordingEnabledFor(off.id)).resolves.toBe(false);
    await expect(isRecordingEnabledFor(null)).resolves.toBe(false);
    expect(reads).toEqual({ organization: 2, featureFlag: 1 });

    vi.advanceTimersByTime(1);
    await expect(isRecordingEnabledFor(off.id)).resolves.toBe(true);
    expect(reads.organization).toBe(3);
  });

  // Catches: a lookup that hangs (a stalled database) holding the org's events until it answers,
  // instead of dropping them after the timeout like a failure and looking again after the TTL.
  postgresTest(
    "records nothing when the lookup hangs past the timeout",
    async ({ prisma, postgresContainer }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const org = await createOrg(prisma, { [KEY]: true });
      const { client, reads } = countingClient(prisma);
      const isRecordingEnabledFor = gate(client);

      // Reads of "Organization" wait for this lock until it is released.
      const locker = new Client({ connectionString: postgresContainer.getConnectionUri() });
      await locker.connect();
      let answers: boolean[] | "still waiting";
      try {
        await locker.query(`BEGIN; LOCK TABLE "Organization" IN ACCESS EXCLUSIVE MODE`);
        answers = await Promise.race([
          Promise.all([1, 2, 3].map(() => isRecordingEnabledFor(org.id))),
          setTimeout(5_000, "still waiting" as const),
        ]);
      } finally {
        await locker.query("ROLLBACK");
        await locker.end();
      }
      expect(answers, "the lookup waited for the database instead of timing out").toEqual([
        false,
        false,
        false,
      ]);
      expect(reads.organization).toBe(1);

      vi.advanceTimersByTime(TTL_MS - 1);
      await expect(isRecordingEnabledFor(org.id)).resolves.toBe(false);
      vi.advanceTimersByTime(1);
      await expect(isRecordingEnabledFor(org.id)).resolves.toBe(true);
      expect(reads.organization).toBe(2);
    }
  );

  // Catches: events that arrive while an org's lookup runs each reading the database.
  postgresTest("events that arrive during a lookup share it", async ({ prisma }) => {
    const org = await createOrg(prisma, { [KEY]: true });
    const { client, reads } = countingClient(prisma);
    const isRecordingEnabledFor = gate(client);

    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => isRecordingEnabledFor(org.id)));

    expect(answers).toEqual([true, true, true, true, true]);
    expect(reads.organization).toBe(1);
  });

  // Catches: a failed lookup recording anyway (fail open), throwing into the host, reading the
  // database for every event during an outage (including events that arrive while the failing
  // lookup runs), or recording staying off after the cached answer expires.
  // On the pg driver adapter, as in production: the Rust engine never drops a closed connection.
  postgresBlipTest(
    "records nothing during a database outage, and looks again once the TTL passes",
    async ({ prisma, postgresContainer }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const org = await createOrg(prisma, { [KEY]: true });
      const { client, reads } = countingClient(prisma);
      const isRecordingEnabledFor = gate(client);

      const outage = await startDatabaseOutage(postgresContainer.getConnectionUri());
      try {
        const answers = await Promise.all([1, 2, 3].map(() => isRecordingEnabledFor(org.id)));
        expect(answers).toEqual([false, false, false]);
        await expect(isRecordingEnabledFor(org.id)).resolves.toBe(false);
        expect(reads.organization).toBe(1);
      } finally {
        await outage.end();
      }
      // The pool drops the closed connections as it meets them: wait until it reconnects.
      const deadline = performance.now() + 10_000;
      let reconnected = false;
      while (!reconnected && performance.now() < deadline) {
        reconnected = await prisma.$queryRaw`SELECT 1`.then(
          () => true,
          () => false
        );
      }
      expect(reconnected, "the client never reconnected after the outage").toBe(true);

      vi.advanceTimersByTime(TTL_MS - 1);
      await expect(isRecordingEnabledFor(org.id)).resolves.toBe(false);
      vi.advanceTimersByTime(1);
      await expect(isRecordingEnabledFor(org.id)).resolves.toBe(true);
      expect(reads.organization).toBe(2);
    }
  );
});
