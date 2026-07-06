// Managed resume reads a run's completed waitpoints by SNAPSHOT id
// (getExecutionSnapshotsSince -> getSnapshotWaitpointIds -> findSnapshotCompletedWaitpointIds).
// Snapshot ids are @default(cuid()), so #routeOrNew(snapshotId) always classifies LEGACY. For a
// NEW-residency run the snapshot's CompletedWaitpoint join rows live on #new, so routing to #legacy
// returns [] and the resumed run sees zero completed waitpoints and hangs. The fix fans out across
// both stores and merges, like findWaitpointCompletedSnapshotIds. Real two-DB topology; never mocked.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";

// cuid-shaped snapshot id -> classifies LEGACY (the always-wrong routing key).
const SNAPSHOT_CUID = "c".repeat(25);
const WAITPOINT_ID = "waitpoint_" + "n".repeat(20);

describe("run-ops split — completed waitpoints for a cuid snapshot are found on the owning store, not misrouted to legacy", () => {
  heteroRunOpsPostgresTest(
    "findSnapshotCompletedWaitpointIds finds a NEW-resident join despite the cuid snapshot id",
    async ({ prisma14, prisma17 }: { prisma14: PrismaClient; prisma17: RunOpsPrismaClient }) => {
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: prisma17 as never,
        schemaVariant: "dedicated",
      });
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      // A NEW-residency run's completed-waitpoint join lives on #new; its snapshot id is a cuid.
      await prisma17.completedWaitpoint.create({
        data: { snapshotId: SNAPSHOT_CUID, waitpointId: WAITPOINT_ID },
      });

      const ids = await router.findSnapshotCompletedWaitpointIds(SNAPSHOT_CUID);

      // RED: the cuid snapshot id routes to #legacy -> [] -> resumed run never completes its waitpoints.
      // GREEN: fan-out finds the #new-resident join.
      expect(ids).toEqual([WAITPOINT_ID]);
    }
  );

  // WithPresence reports, in one read, whether the snapshot is visible on the reader (so a multi-reader
  // replica can distinguish "no waitpoints" from "reader has not applied the snapshot yet").
  heteroRunOpsPostgresTest(
    "findSnapshotCompletedWaitpointIdsWithPresence reports present+ids for a dedicated snapshot, absent otherwise",
    async ({ prisma17 }: { prisma17: RunOpsPrismaClient }) => {
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: prisma17 as never,
        schemaVariant: "dedicated",
      });
      const runId = "run_" + "k".repeat(24) + "01";
      await prisma17.taskRun.create({
        data: {
          id: runId,
          friendlyId: "run_pres",
          engine: "V2",
          status: "PENDING",
          taskIdentifier: "t",
          payload: "{}",
          payloadType: "application/json",
          traceId: "tr",
          spanId: "sp",
          queue: "q",
          runtimeEnvironmentId: "env_pres",
          projectId: "proj_pres",
        },
      });
      const snap = await prisma17.taskRunExecutionSnapshot.create({
        data: {
          id: "c".repeat(25),
          engine: "V2",
          executionStatus: "EXECUTING",
          description: "continue",
          runStatus: "PENDING",
          runId,
          environmentId: "env_pres",
          environmentType: "DEVELOPMENT",
          projectId: "proj_pres",
          organizationId: "org_pres",
        },
      });
      await prisma17.completedWaitpoint.create({
        data: { snapshotId: snap.id, waitpointId: WAITPOINT_ID },
      });

      expect(await newStore.findSnapshotCompletedWaitpointIdsWithPresence(snap.id)).toEqual({
        present: true,
        ids: [WAITPOINT_ID],
      });
      // A snapshot the reader does not have -> present:false, so its empty ids are not trusted as authoritative.
      expect(
        await newStore.findSnapshotCompletedWaitpointIdsWithPresence("c".repeat(24) + "zz")
      ).toEqual({ present: false, ids: [] });
    }
  );
});
