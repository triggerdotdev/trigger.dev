import { isWaitpointOutputTimeout, prettyPrintPacket } from "@trigger.dev/core/v3";
import { type PrismaClientOrTransaction, type PrismaReplicaClient } from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { generateHttpCallbackUrl } from "~/services/httpCallback.server";
import { logger } from "~/services/logger.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { readThroughRun } from "~/v3/runOpsMigration/readThrough.server";
import { BasePresenter } from "./basePresenter.server";
import { NextRunListPresenter, type NextRunListItem } from "./NextRunListPresenter.server";
import { waitpointStatusToApiStatus } from "./WaitpointListPresenter.server";

export type WaitpointDetail = NonNullable<Awaited<ReturnType<WaitpointPresenter["call"]>>>;

// Single-sourced display bound for a waitpoint's connected run friendlyIds.
export const CONNECTED_RUNS_DISPLAY_LIMIT = 5;

// Over-read connection rows on the FK-free dedicated join so danglers don't cost a display slot.
export const CONNECTED_RUNS_CONNECTION_SCAN_LIMIT = CONNECTED_RUNS_DISPLAY_LIMIT * 5;

export class WaitpointPresenter extends BasePresenter {
  constructor(
    prisma?: PrismaClientOrTransaction,
    replica?: PrismaClientOrTransaction,
    private readonly readThroughDeps?: {
      // The new run-ops client + the legacy run-ops read replica (never the legacy writer).
      // Omitted => single-DB / self-host: both default to `_replica` (passthrough).
      newClient?: PrismaClientOrTransaction;
      legacyReplica?: PrismaClientOrTransaction;
      // Resolved boot constant from isSplitEnabled(). When false/absent:
      // the waitpoint lookup is one plain findFirst and the connected-runs hydrate runs passthrough.
      splitEnabled?: boolean;
    }
  ) {
    super(prisma, replica);
  }

  async #findWaitpoint(friendlyId: string, environmentId: string) {
    const where = { friendlyId, environmentId };
    const select = {
      id: true,
      friendlyId: true,
      type: true,
      status: true,
      idempotencyKey: true,
      userProvidedIdempotencyKey: true,
      idempotencyKeyExpiresAt: true,
      inactiveIdempotencyKey: true,
      output: true,
      outputType: true,
      outputIsError: true,
      completedAfter: true,
      completedAt: true,
      createdAt: true,
      tags: true,
      environmentId: true,
    } as const;

    const hydrate = (client: PrismaReplicaClient) => client.waitpoint.findFirst({ where, select });

    if (!this.readThroughDeps) {
      return this._replica.waitpoint.findFirst({ where, select });
    }

    const result = await readThroughRun({
      runId: friendlyId,
      environmentId,
      readNew: (client) => hydrate(client),
      readLegacy: (replica) => hydrate(replica),
      deps: {
        splitEnabled: this.readThroughDeps.splitEnabled,
        newClient:
          (this.readThroughDeps.newClient as PrismaReplicaClient | undefined) ??
          (this._replica as unknown as PrismaReplicaClient),
        legacyReplica:
          (this.readThroughDeps.legacyReplica as PrismaReplicaClient | undefined) ??
          (this._replica as unknown as PrismaReplicaClient),
      },
    });

    return result.source === "new" || result.source === "legacy-replica" ? result.value : null;
  }

  // Connected-run friendlyIds gathered across BOTH stores. The run<->waitpoint join co-locates with
  // the RUN (written on the run's DB), so the waitpoint's own store misses a cross-DB connection; we
  // read the join on each client, resolve the run's friendlyId on that same client, and union.
  async #connectedRunFriendlyIds(waitpointId: string): Promise<string[]> {
    const replica = this._replica as unknown as PrismaReplicaClient;
    const rawClients: PrismaReplicaClient[] =
      this.readThroughDeps?.splitEnabled === true
        ? [
            (this.readThroughDeps.newClient as PrismaReplicaClient | undefined) ?? replica,
            (this.readThroughDeps.legacyReplica as PrismaReplicaClient | undefined) ?? replica,
          ]
        : [replica];
    const clients = [...new Set(rawClients)];

    const friendlyIds = new Set<string>();
    for (const client of clients) {
      for (const friendlyId of await this.#connectedRunFriendlyIdsOn(client, waitpointId)) {
        friendlyIds.add(friendlyId);
      }
      if (friendlyIds.size >= CONNECTED_RUNS_DISPLAY_LIMIT) {
        break;
      }
    }
    return Array.from(friendlyIds).slice(0, CONNECTED_RUNS_DISPLAY_LIMIT);
  }

  // Connected-run friendlyIds for one store, via the ORM. Two indexed reads joined in memory instead
  // of a SQL JOIN onto the (very large) TaskRun table: `id IN (...)` can only plan as a PK lookup, so
  // the planner can never scan TaskRun.
  //
  // Dedicated subset: the explicit `WaitpointRunConnection` is scalar (`taskRunId`, no FK), so a
  // connection can outlive a deleted run. We over-read connection ids, resolve runs by id (a missing
  // id just drops out -- danglers cost no display slot), and cap at the display limit.
  //
  // Control-plane full schema: no queryable join delegate (implicit M2M), so we traverse the
  // `connectedRuns` relation; it cascade-deletes with the run, so no dangler can exist.
  async #connectedRunFriendlyIdsOn(
    client: PrismaReplicaClient,
    waitpointId: string
  ): Promise<string[]> {
    const dedicated = (
      client as unknown as {
        waitpointRunConnection?: {
          findMany: (args: unknown) => Promise<{ taskRunId: string }[]>;
        };
      }
    ).waitpointRunConnection;

    if (dedicated) {
      const connections = await dedicated.findMany({
        where: { waitpointId },
        select: { taskRunId: true },
        take: CONNECTED_RUNS_CONNECTION_SCAN_LIMIT,
      });
      if (connections.length === 0) {
        return [];
      }
      const runs = await client.taskRun.findMany({
        where: { id: { in: connections.map((connection) => connection.taskRunId) } },
        select: { friendlyId: true },
        take: CONNECTED_RUNS_DISPLAY_LIMIT,
      });
      return runs.map((run) => run.friendlyId);
    }

    const waitpoint = (await (
      client.waitpoint.findFirst as (
        args: unknown
      ) => Promise<{ connectedRuns: { friendlyId: string }[] } | null>
    )({
      where: { id: waitpointId },
      select: {
        connectedRuns: { select: { friendlyId: true }, take: CONNECTED_RUNS_DISPLAY_LIMIT },
      },
    })) as { connectedRuns: { friendlyId: string }[] } | null;
    return (waitpoint?.connectedRuns ?? []).map((run) => run.friendlyId);
  }

  public async call({
    friendlyId,
    environmentId,
    projectId,
  }: {
    friendlyId: string;
    environmentId: string;
    projectId: string;
  }) {
    const waitpoint = await this.#findWaitpoint(friendlyId, environmentId);

    if (!waitpoint) {
      logger.error(`WaitpointPresenter: Waitpoint not found`, {
        friendlyId,
      });
      return null;
    }

    const environment = await controlPlaneResolver.resolveAuthenticatedEnv(waitpoint.environmentId);

    if (!environment) {
      logger.error(`WaitpointPresenter: environment not found`, { friendlyId });
      return null;
    }

    const output =
      waitpoint.outputType === "application/store"
        ? `/resources/packets/${environmentId}/${waitpoint.output}`
        : typeof waitpoint.output !== "undefined" && waitpoint.output !== null
          ? await prettyPrintPacket(waitpoint.output, waitpoint.outputType ?? undefined)
          : undefined;

    let _isTimeout = false;
    if (waitpoint.outputIsError && output) {
      if (isWaitpointOutputTimeout(output)) {
        _isTimeout = true;
      }
    }

    const connectedRunIds = await this.#connectedRunFriendlyIds(waitpoint.id);
    const connectedRuns: NextRunListItem[] = [];

    if (connectedRunIds.length > 0) {
      const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
        environment.organizationId,
        "standard"
      );
      const runPresenter = new NextRunListPresenter(
        this._prisma,
        clickhouse,
        this.readThroughDeps
          ? {
              newClient: this.readThroughDeps.newClient ?? this._replica,
              legacyReplica: this.readThroughDeps.legacyReplica ?? this._replica,
              splitEnabled: this.readThroughDeps.splitEnabled ?? false,
            }
          : undefined
      );
      const { runs } = await runPresenter.call(environment.organizationId, environmentId, {
        projectId: projectId,
        runId: connectedRunIds,
        pageSize: 5,
        period: "31d",
      });

      connectedRuns.push(...runs);
    }

    return {
      id: waitpoint.friendlyId,
      type: waitpoint.type,
      url: generateHttpCallbackUrl(waitpoint.id, environment.apiKey),
      status: waitpointStatusToApiStatus(waitpoint.status, waitpoint.outputIsError),
      idempotencyKey: waitpoint.idempotencyKey,
      userProvidedIdempotencyKey: waitpoint.userProvidedIdempotencyKey,
      idempotencyKeyExpiresAt: waitpoint.idempotencyKeyExpiresAt,
      inactiveIdempotencyKey: waitpoint.inactiveIdempotencyKey,
      output: output,
      outputType: waitpoint.outputType,
      outputIsError: waitpoint.outputIsError,
      timeoutAt: waitpoint.completedAfter,
      completedAfter: waitpoint.completedAfter,
      completedAt: waitpoint.completedAt,
      createdAt: waitpoint.createdAt,
      tags: waitpoint.tags,
      connectedRuns,
    };
  }
}
