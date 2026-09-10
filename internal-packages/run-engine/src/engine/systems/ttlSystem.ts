import { parseNaturalLanguageDuration } from "@trigger.dev/core/v3/isomorphic";
import { parseSnapshotRoute, toWireRoute, type SnapshotRouteWire } from "@internal/run-store";
import type { TaskRunError } from "@trigger.dev/core/v3/schemas";
import type { PrismaClientOrTransaction, TaskRunStatus } from "@trigger.dev/database";
import { isExecuting } from "../statuses.js";
import { getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import type { SystemResources } from "./systems.js";
import type { WaitpointSystem } from "./waitpointSystem.js";
import { startSpan } from "@internal/tracing";
import pMap from "p-map";

import { boundedIn } from "@trigger.dev/database";
export type TtlSystemOptions = {
  resources: SystemResources;
  waitpointSystem: WaitpointSystem;
  finalizationGuardDelayMs?: number;
};

export class TtlSystem {
  private readonly $: SystemResources;
  private readonly waitpointSystem: WaitpointSystem;
  private readonly finalizationGuardDelayMs: number;

  constructor(private readonly options: TtlSystemOptions) {
    this.$ = options.resources;
    this.waitpointSystem = options.waitpointSystem;
    this.finalizationGuardDelayMs = options.finalizationGuardDelayMs ?? 60_000;
  }

  /**
   * Write-ahead guard for TTL expiry, mirroring the run attempt system's: enqueued
   * before the EXPIRED commit so a crash or error between that commit and the
   * waitpoint completion cannot strand a waiting parent, and acked once the inline
   * side effects succeed.
   */
  async #scheduleFinalizationGuard(runId: string): Promise<void> {
    await this.$.worker.enqueue({
      id: `ensureRunFinalized:${runId}`,
      job: "ensureRunFinalized",
      payload: { runId },
      availableAt: new Date(Date.now() + this.finalizationGuardDelayMs),
    });
  }

  async expireRun({
    runId,
    tx,
    route,
  }: {
    runId: string;
    tx?: PrismaClientOrTransaction;
    // The run's already-resolved wire route, threaded from the TTL Lua via the batch path so the
    // terminal snapshot lands in the run's true store with no per-run durable lookup. Omitted by the
    // standalone scheduled-expiry job, which resolves the route durably (forceDurable) below.
    route?: SnapshotRouteWire;
  }) {
    const prisma = tx ?? this.$.prisma;
    await this.$.runLock.lock("expireRun", [runId], async () => {
      const snapshot = await getLatestExecutionSnapshot(prisma, runId, this.$.runStore);

      //if we're executing then we won't expire the run
      if (isExecuting(snapshot.executionStatus)) {
        return;
      }

      //only expire "PENDING" runs
      const run = await this.$.runStore.findRun({ id: runId }, prisma);

      if (!run) {
        this.$.logger.debug("Could not find enqueued run to expire", {
          runId,
        });
        return;
      }

      if (run.status !== "PENDING") {
        this.$.logger.debug("Run cannot be expired because it's not in PENDING status", {
          runId: run.id,
          status: run.status,
        });
        return;
      }

      if (run.lockedAt) {
        this.$.logger.debug("Run cannot be expired because it's locked, so will run", {
          runId: run.id,
          status: run.status,
          lockedAt: run.lockedAt,
        });
        return;
      }

      const error: TaskRunError = {
        type: "STRING_ERROR",
        raw: `Run expired because the TTL (${run.ttl}) was reached`,
      };

      await this.#scheduleFinalizationGuard(runId);

      // Prefer the route the caller already resolved (threaded from the TTL Lua's per-message
      // snapshotRoute). Only the standalone scheduled-expiry path arrives with no route: it runs on any
      // pod, so it resolves the residency durably (forceDurable) rather than take the never-enrolled
      // Postgres shortcut a poll-lagging pod would otherwise pick. Fails closed if it cannot confirm.
      let expireRouteWire: SnapshotRouteWire | undefined;
      if (route !== undefined) {
        expireRouteWire = route;
      } else {
        const expireRoute = await this.$.runStore.readSnapshotRoute(
          runId,
          snapshot.organizationId,
          {
            forceDurable: true,
          }
        );
        expireRouteWire = expireRoute ? toWireRoute(expireRoute) : undefined;
      }

      const updatedRun = await this.$.runStore.expireRun(
        runId,
        {
          error,
          completedAt: new Date(),
          expiredAt: new Date(),
          snapshot: {
            engine: "V2",
            executionStatus: "FINISHED",
            description: "Run was expired because the TTL was reached",
            runStatus: "EXPIRED",
            environmentId: snapshot.environmentId,
            environmentType: snapshot.environmentType,
            projectId: snapshot.projectId,
            organizationId: snapshot.organizationId,
            snapshotRoute: expireRouteWire,
          },
        },
        {
          select: {
            id: true,
            runtimeEnvironmentId: true,
            spanId: true,
            ttl: true,
            updatedAt: true,
            associatedWaitpoint: {
              select: {
                id: true,
              },
            },
            createdAt: true,
            completedAt: true,
            taskEventStore: true,
            parentTaskRunId: true,
            expiredAt: true,
            status: true,
          },
        },
        prisma
      );

      await this.$.runQueue.acknowledgeMessage(snapshot.organizationId, runId, {
        removeFromWorkerQueue: true,
      });

      // Complete the waitpoint if it exists (runs without waiting parents have no waitpoint)
      if (updatedRun.associatedWaitpoint) {
        await this.waitpointSystem.completeWaitpoint({
          id: updatedRun.associatedWaitpoint.id,
          output: { value: JSON.stringify(error), isError: true },
        });
      }

      this.$.eventBus.emit("runExpired", {
        run: updatedRun,
        time: new Date(),
        organization: { id: snapshot.organizationId },
        project: { id: snapshot.projectId },
        environment: { id: snapshot.environmentId },
      });

      await this.$.worker.ack(`ensureRunFinalized:${runId}`);
    });
  }

  async scheduleExpireRun({ runId, ttl }: { runId: string; ttl: string }) {
    const expireAt = parseNaturalLanguageDuration(ttl);

    if (expireAt) {
      await this.$.worker.enqueue({
        id: `expireRun:${runId}`,
        job: "expireRun",
        payload: { runId },
        availableAt: expireAt,
      });
    }
  }

  /**
   * Efficiently expire a batch of runs that were already atomically removed from
   * the queue by the TTL Lua script. This method:
   * - Does NOT use run locks (the Lua script already claimed these atomically)
   * - Does NOT call acknowledgeMessage (the Lua script already removed from queue)
   * - Batches database operations where possible
   */
  async expireRunsBatch(items: Array<{ runId: string; snapshotRoute?: unknown }>): Promise<{
    expired: string[];
    skipped: { runId: string; reason: string }[];
  }> {
    return startSpan(this.$.tracer, "TtlSystem.expireRunsBatch", async (span) => {
      span.setAttribute("runCount", items.length);

      if (items.length === 0) {
        return { expired: [], skipped: [] };
      }

      const runIds = items.map((i) => i.runId);
      const routeByRunId = new Map(items.map((i) => [i.runId, i.snapshotRoute]));
      const expired: string[] = [];
      const skipped: { runId: string; reason: string }[] = [];

      // Fetch all runs in a single query (no snapshot data needed)
      const runs = await this.$.runStore.findRuns(
        {
          where: { id: { in: boundedIn(runIds) } },
          select: {
            id: true,
            spanId: true,
            status: true,
            lockedAt: true,
            ttl: true,
            taskEventStore: true,
            createdAt: true,
            associatedWaitpoint: { select: { id: true } },
            organizationId: true,
            projectId: true,
            runtimeEnvironmentId: true,
          },
          // read-your-writes: the queue slot is already claimed; a lagging replica would orphan the run
        },
        this.$.prisma
      );

      // Filter runs that can be expired
      const runsToExpire: typeof runs = [];

      for (const run of runs) {
        if (run.status !== "PENDING") {
          skipped.push({ runId: run.id, reason: `status_${run.status}` });
          continue;
        }

        if (run.lockedAt) {
          skipped.push({ runId: run.id, reason: "locked" });
          continue;
        }

        runsToExpire.push(run);
      }

      // Track runs that weren't found
      const foundRunIds = new Set(runs.map((r) => r.id));
      for (const runId of runIds) {
        if (!foundRunIds.has(runId)) {
          skipped.push({ runId, reason: "not_found" });
        }
      }

      if (runsToExpire.length === 0) {
        span.setAttribute("expiredCount", 0);
        span.setAttribute("skippedCount", skipped.length);
        return { expired, skipped };
      }

      const now = new Date();

      const error: TaskRunError = {
        type: "STRING_ERROR",
        raw: "Run expired because the TTL was reached",
      };

      // Classify each run by the route the TTL Lua copied from its queue message. A VALID carried route
      // is the fast path: the run is resident and its MemoryDB head advances through the per-run snapshot
      // protocol, with NO durable lookup. But an ABSENT or MALFORMED route must NOT be assumed Postgres:
      // a mixed-version rollout can enqueue an enrolled run without stamping the route, and a future route
      // version parses as absent here. Treating either as Postgres-only would flip a redis-primary run to
      // EXPIRED in Postgres while its Redis head stays QUEUED (a strand), so those runs alone resolve their
      // residency durably (forceDurable) — a bounded lookup for the transition-period tail, not per run in
      // steady state. Only a CONFIRMED never-enrolled run (durable resolve returns undefined) takes the
      // efficient bulk SQL path; a durable resolution that cannot be confirmed fails closed (skipped).
      const postgresOnlyRuns: typeof runsToExpire = [];
      const residentRuns: Array<{ run: (typeof runsToExpire)[number]; route: SnapshotRouteWire }> =
        [];
      // Transient failures (durable residency unresolved, or a resident expiry that threw) for runs the
      // TTL Lua ALREADY removed from the normal queue. These must NOT be reported as a benign skip: the
      // batch worker would ACK the item and orphan the run (pending forever, no queue entry, no retry).
      // We finish processing the batch, then THROW so the redis-worker retries it (already-expired runs
      // re-expire idempotently). Distinct from a legitimate skip (not_found / wrong status), which needs
      // no retry because the run is no longer PENDING.
      const retriableFailures: string[] = [];
      await pMap(
        runsToExpire,
        async (run) => {
          const rawRoute = routeByRunId.get(run.id);
          const carried =
            rawRoute !== undefined && rawRoute !== null ? parseSnapshotRoute(rawRoute) : undefined;
          // A valid carried route is the fast path, but only when it belongs to THIS run's org. A route
          // whose organizationId does not match the run we are expiring cannot be trusted to describe its
          // residency (a mis-stamped or crossed message), so it is treated as malformed and resolved
          // durably rather than acted on.
          const carriedMatchesOrg = carried && carried.organizationId === run.organizationId;
          if (carried && carriedMatchesOrg) {
            // An explicit postgres route keeps the efficient bulk SQL path — no per-run resident write.
            // Only a Redis-backed residency (mirrored / redis-primary) advances a resident head.
            if (carried.residency === "postgres") {
              postgresOnlyRuns.push(run);
            } else {
              residentRuns.push({ run, route: carried });
            }
            return;
          }
          if (!run.organizationId) {
            postgresOnlyRuns.push(run);
            return;
          }
          try {
            // Absent or malformed route: resolve the durable residency for THIS route-less tail. The
            // primary findRuns query that produced this batch already returned each TaskRun row, so
            // `knownToExist` skips the resolver's per-run existence probe — repeating it here would be a
            // redundant Postgres query. Ordinary (non-batch) resolution keeps the full birth-race guard.
            const resolved = await this.$.runStore.readSnapshotRoute(run.id, run.organizationId, {
              forceDurable: true,
              knownToExist: true,
            });
            if (resolved) {
              // Never assume Postgres from an unresolved/absent route: a resolved redis-primary or mirrored
              // residency advances its resident head; only a CONFIRMED postgres residency takes bulk SQL.
              if (resolved.residency === "postgres") {
                postgresOnlyRuns.push(run);
              } else {
                residentRuns.push({ run, route: toWireRoute(resolved) });
              }
            } else {
              postgresOnlyRuns.push(run);
            }
          } catch (e) {
            this.$.logger.error("Failed to resolve residency for route-less TTL batch run", {
              runId: run.id,
              error: e,
            });
            skipped.push({ runId: run.id, reason: "route_unresolved" });
            retriableFailures.push(run.id);
          }
        },
        { concurrency: 10 }
      );

      // Resident runs go through the per-run snapshot transaction (same path as expireRun) so their
      // head advances in the run's true store, carrying the KNOWN route so expireRun does no durable
      // lookup. Bounded concurrency keeps a large resident batch from degrading into serial work.
      await pMap(
        residentRuns,
        async ({ run, route }) => {
          try {
            await this.expireRun({ runId: run.id, route });
            expired.push(run.id);
          } catch (e) {
            this.$.logger.error("Failed to expire resident run in TTL batch", {
              runId: run.id,
              error: e,
            });
            skipped.push({ runId: run.id, reason: "resident_expire_failed" });
            retriableFailures.push(run.id);
          }
        },
        { concurrency: 5, stopOnError: false }
      );

      if (postgresOnlyRuns.length === 0) {
        span.setAttribute("expiredCount", expired.length);
        span.setAttribute("skippedCount", skipped.length);
        this.#throwIfRetriable(retriableFailures);
        return { expired, skipped };
      }

      // Postgres-only runs keep the efficient bulk SQL path.
      const runIdsToExpire = postgresOnlyRuns.map((r) => r.id);

      await pMap(postgresOnlyRuns, (run) => this.#scheduleFinalizationGuard(run.id), {
        concurrency: 10,
      });

      await this.$.runStore.expireRunsBatch(runIdsToExpire, { error, now }, this.$.prisma);

      // Process each run: enqueue waitpoint completion jobs and emit events
      await pMap(
        postgresOnlyRuns,
        async (run) => {
          try {
            // Enqueue a finishWaitpoint worker job for resilient waitpoint completion
            if (run.associatedWaitpoint) {
              await this.$.worker.enqueue({
                id: `finishWaitpoint.ttl.${run.associatedWaitpoint.id}`,
                job: "finishWaitpoint",
                payload: {
                  waitpointId: run.associatedWaitpoint.id,
                  error: JSON.stringify(error),
                },
              });
            }

            // This should really never happen
            if (!run.organizationId) {
              return;
            }

            this.$.eventBus.emit("runExpired", {
              run: {
                id: run.id,
                spanId: run.spanId,
                ttl: run.ttl,
                taskEventStore: run.taskEventStore,
                createdAt: run.createdAt,
                updatedAt: now,
                completedAt: now,
                expiredAt: now,
                status: "EXPIRED" as TaskRunStatus,
              },
              time: now,
              organization: { id: run.organizationId },
              project: { id: run.projectId },
              environment: { id: run.runtimeEnvironmentId },
            });

            /**
             * Waitpoint completion in this path is delegated to the finishWaitpoint job,
             * which can still exhaust its retries, so the guard stays armed for runs with
             * a waiting parent and verifies the completion landed. Runs with no waitpoint
             * have nothing left to re-deliver, so release their guard now.
             */
            if (!run.associatedWaitpoint) {
              await this.$.worker.ack(`ensureRunFinalized:${run.id}`);
            }

            expired.push(run.id);
          } catch (e) {
            this.$.logger.error("Failed to process expired run", {
              runId: run.id,
              error: e,
            });
          }
        },
        { concurrency: 10, stopOnError: false }
      );

      span.setAttribute("expiredCount", expired.length);
      span.setAttribute("skippedCount", skipped.length);

      this.#throwIfRetriable(retriableFailures);
      return { expired, skipped };
    });
  }

  // A resident expiry or durable-residency resolution that failed for a run the TTL Lua already removed
  // from the queue must fail the batch so the redis-worker retries it, rather than ACK-ing and orphaning
  // the run. Thrown only after the rest of the batch is processed, so progress is never blocked; the
  // already-expired runs re-expire idempotently on the retry.
  #throwIfRetriable(retriableFailures: string[]): void {
    if (retriableFailures.length === 0) return;
    throw new Error(
      `TTL batch left ${retriableFailures.length} dequeued run(s) unexpired (transient); retrying to avoid orphaning: ${retriableFailures.join(", ")}`
    );
  }
}
