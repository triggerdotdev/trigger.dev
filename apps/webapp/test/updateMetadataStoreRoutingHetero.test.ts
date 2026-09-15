import { heteroPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { parsePacket } from "@trigger.dev/core/v3";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { setTimeout } from "timers/promises";
import { describe, expect } from "vitest";
import { UpdateMetadataService } from "~/services/metadata/updateMetadata.server";

vi.setConfig({ testTimeout: 60_000 });

// Real heterogeneous NEW + LEGACY Postgres proof for UpdateMetadataService, exercising the REAL
// RoutingRunStore over two real PostgresRunStore instances (NEW = PG17, LEGACY = PG14). The DB is
// never mocked.
//
// The load-bearing design point: UpdateMetadataService forwards `this._prisma` as the tx/client to
// every findRun/updateMetadata call. That client is bound to the control plane — the wrong database
// for a run resident on either store — so the router must never forward it verbatim. It does not:
// a non-replica client escalates to the OWNING store's own primary, so residency routing is proved
// rather than the forwarded prisma.
//
// Residency comes from the id shape: a v1 run-ops id (26 chars, version "1" at index 25) resolves
// to NEW, a 25-char cuid to LEGACY.

function buildRoutingStore(prisma17: PrismaClient, prisma14: PrismaClient) {
  const newStore = new PostgresRunStore({
    prisma: prisma17,
    readOnlyPrisma: prisma17,
    schemaVariant: "dedicated",
  });
  const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
}

// 25-char cuid-format id (starts with "c"), no v1 version marker.
function generateLegacyCuid() {
  const suffix = Array.from(
    { length: 24 },
    () => "0123456789abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 36)]
  ).join("");
  return `c${suffix}`;
}

async function seedOrgProjectEnv(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `test-${suffix}`, slug: `test-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `test-${suffix}`,
      slug: `test-${suffix}`,
      organizationId: organization.id,
      externalRef: `test-${suffix}`,
    },
  });
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `test-${suffix}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `test-${suffix}`,
      pkApiKey: `test-${suffix}`,
      shortcode: `test-${suffix}`,
    },
  });
  return { organization, project, runtimeEnvironment };
}

describe("UpdateMetadataService store routing (hetero)", () => {
  heteroPostgresTest(
    "routes read+CAS to the owning (NEW/PG17) store for a run-ops run",
    async ({ prisma17, prisma14 }) => {
      const runId = generateRunOpsId();
      expect(runId.length).toBe(26);

      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma17,
        "new"
      );

      const seeded = await prisma17.taskRun.create({
        data: {
          id: runId,
          friendlyId: `run_${runId}`,
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      const service = new UpdateMetadataService({
        // prisma is set to one of the clients only to satisfy the required option;
        // the routing store deliberately does NOT honor it for residency.
        prisma: prisma17,
        runStore: buildRoutingStore(prisma17, prisma14),
        flushIntervalMs: 100,
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024 * 1024 * 1,
        logLevel: "error",
      });

      const result = await service.call(runId, {
        operations: [{ type: "set", key: "foo", value: "bar" }],
      });

      expect(result?.metadata).toEqual({ foo: "bar" });

      // The owning store (PG17) has the update with version incremented by exactly 1.
      const newRow = await prisma17.taskRun.findFirst({ where: { id: runId } });
      expect(newRow).not.toBeNull();
      const newMetadata = await parsePacket({
        data: newRow?.metadata ?? undefined,
        dataType: newRow?.metadataType ?? "application/json",
      });
      expect(newMetadata).toEqual({ foo: "bar" });
      // CAS incremented the version by exactly 1.
      expect(newRow?.metadataVersion).toBe(seeded.metadataVersion + 1);

      // The LEGACY store (PG14) never saw this id — no cross-DB leakage.
      const legacyRow = await prisma14.taskRun.findFirst({ where: { id: runId } });
      expect(legacyRow).toBeNull();

      service.stopFlushing();
    }
  );

  heteroPostgresTest(
    "preserves CAS under concurrent writers on a NEW-DB (PG17) run",
    async ({ prisma17, prisma14 }) => {
      const runId = generateRunOpsId();
      expect(runId.length).toBe(26);

      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma17,
        "cas"
      );

      const seeded = await prisma17.taskRun.create({
        data: {
          id: runId,
          friendlyId: `run_${runId}`,
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      let onAfterReadCallCount = 0;

      const service = new UpdateMetadataService({
        prisma: prisma17,
        runStore: buildRoutingStore(prisma17, prisma14),
        flushIntervalMs: 100,
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024 * 1024 * 1,
        logLevel: "error",
        onAfterRead: async (rId) => {
          onAfterReadCallCount++;
          // Simulate a concurrent writer landing between the service's read and CAS,
          // for the first 3 reads — forcing CAS count===0 and a retry each time.
          // The concurrent writes go straight to PG17 (the owning DB).
          if (onAfterReadCallCount <= 3) {
            await prisma17.taskRun.updateMany({
              where: { id: rId },
              data: {
                metadata: JSON.stringify({ concurrent: `update${onAfterReadCallCount}` }),
                metadataVersion: { increment: 1 },
              },
            });
          }
        },
      });

      const result = await service.call(runId, {
        operations: [{ type: "set", key: "immediate", value: "value1" }],
      });

      // Initial read + 3 retries.
      expect(onAfterReadCallCount).toBe(4);

      // No lost update: the final state reflects BOTH the last concurrent write and
      // the service's operation.
      expect(result?.metadata).toEqual({ concurrent: "update3", immediate: "value1" });

      // Let the buffered (post-retry) operation flush to the owning store.
      await setTimeout(1000);

      const newRow = await prisma17.taskRun.findFirst({ where: { id: runId } });
      const metadata = await parsePacket({
        data: newRow?.metadata ?? undefined,
        dataType: newRow?.metadataType ?? "application/json",
      });
      expect(metadata).toEqual({ concurrent: "update3", immediate: "value1" });

      // 3 concurrent increments + 1 successful service CAS, relative to the seed.
      expect(newRow?.metadataVersion).toBe(seeded.metadataVersion + 4);

      // LEGACY store untouched.
      const legacyRow = await prisma14.taskRun.findFirst({ where: { id: runId } });
      expect(legacyRow).toBeNull();

      service.stopFlushing();
    }
  );

  heteroPostgresTest(
    "routes read-through + CAS to the LEGACY (PG14) store for a cuid run without spanning DBs",
    async ({ prisma17, prisma14 }) => {
      const runId = generateLegacyCuid();
      expect(runId.length).toBe(25);

      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma14,
        "legacy"
      );

      const seeded = await prisma14.taskRun.create({
        data: {
          id: runId,
          friendlyId: `run_${runId}`,
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      const service = new UpdateMetadataService({
        prisma: prisma17,
        runStore: buildRoutingStore(prisma17, prisma14),
        flushIntervalMs: 100,
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024 * 1024 * 1,
        logLevel: "error",
      });

      // Call WITHOUT an environment arg, so the `where` is just `{ id: runId }` and the router
      // resolves residency from the id shape (a 25-char cuid is not a v1 body => LEGACY).
      const result = await service.call(runId, {
        operations: [{ type: "set", key: "x", value: 1 }],
      });

      expect(result?.metadata).toEqual({ x: 1 });

      // The owning LEGACY store (PG14) got the update.
      const legacyRow = await prisma14.taskRun.findFirst({ where: { id: runId } });
      expect(legacyRow).not.toBeNull();
      const legacyMetadata = await parsePacket({
        data: legacyRow?.metadata ?? undefined,
        dataType: legacyRow?.metadataType ?? "application/json",
      });
      expect(legacyMetadata).toEqual({ x: 1 });
      // CAS incremented the version by exactly 1.
      expect(legacyRow?.metadataVersion).toBe(seeded.metadataVersion + 1);

      // The NEW store (PG17) never saw a write for this id — read-through resolved to
      // LEGACY and the CAS targeted the SAME store.
      const newRow = await prisma17.taskRun.findFirst({ where: { id: runId } });
      expect(newRow).toBeNull();

      service.stopFlushing();
    }
  );
});
