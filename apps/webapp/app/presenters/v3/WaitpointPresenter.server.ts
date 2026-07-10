import { isWaitpointOutputTimeout, prettyPrintPacket } from "@trigger.dev/core/v3";
import {
  DATABASE_SCHEMA,
  type PrismaClientOrTransaction,
  type PrismaReplicaClient,
} from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { generateHttpCallbackUrl } from "~/services/httpCallback.server";
import { logger } from "~/services/logger.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { readThroughRun } from "~/v3/runOpsMigration/readThrough.server";
import { BasePresenter } from "./basePresenter.server";
import { NextRunListPresenter, type NextRunListItem } from "./NextRunListPresenter.server";
import { waitpointStatusToApiStatus } from "./WaitpointListPresenter.server";

export type WaitpointDetail = NonNullable<Awaited<ReturnType<WaitpointPresenter["call"]>>>;

// Single-sourced bound for connected run friendlyIds: applied at the FETCH in #connectedRunIdsOn,
// not just at display time.
export const CONNECTED_RUNS_DISPLAY_LIMIT = 5;

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
  // read the join on each client and resolve the run's friendlyId on that same client, then union.
  // We never relation-select `connectedRuns`: it is not a field on the dedicated subset `Waitpoint`.
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
      const runIds = await this.#connectedRunIdsOn(client, waitpointId);
      if (runIds.length === 0) {
        continue;
      }
      const runs = await client.taskRun.findMany({
        where: { id: { in: runIds } },
        select: { friendlyId: true },
        take: CONNECTED_RUNS_DISPLAY_LIMIT,
      });
      for (const run of runs) {
        friendlyIds.add(run.friendlyId);
      }
      if (friendlyIds.size >= CONNECTED_RUNS_DISPLAY_LIMIT) {
        break;
      }
    }
    return Array.from(friendlyIds).slice(0, CONNECTED_RUNS_DISPLAY_LIMIT);
  }

  // Schema-aware read of the run ids linked to a waitpoint: the dedicated subset uses the explicit
  // `WaitpointRunConnection` model (scalar `taskRunId`, no FK -- a row can dangle after its run is
  // deleted), the control-plane full schema the implicit `_WaitpointRunConnections` M2M
  // (A = TaskRun.id, B = Waitpoint.id). Both branches existence-filter AT THE QUERY via a JOIN to
  // TaskRun, so a dangling connection row can never occupy a LIMIT slot ahead of a real one.
  // Tables are schema-qualified with DATABASE_SCHEMA (trusted boot constant) so a non-`public`
  // schema= deployment resolves the right tables instead of leaning on search_path. $queryRawUnsafe,
  // not a `sqlDatabaseSchema` Prisma.Sql fragment: `client` may be the dedicated run-ops client (a
  // different Prisma runtime) which would bind a foreign runtime's Sql fragment as a param instead
  // of inlining it. waitpointId and the constant limit stay bound params ($1/$2).
  async #connectedRunIdsOn(client: PrismaReplicaClient, waitpointId: string): Promise<string[]> {
    const isDedicated = Boolean(
      (client as unknown as { waitpointRunConnection?: unknown }).waitpointRunConnection
    );

    if (isDedicated) {
      const rows = await client.$queryRawUnsafe<{ taskRunId: string }[]>(
        `SELECT c."taskRunId" AS "taskRunId"
        FROM ${DATABASE_SCHEMA}."WaitpointRunConnection" c
        JOIN ${DATABASE_SCHEMA}."TaskRun" t ON t."id" = c."taskRunId"
        WHERE c."waitpointId" = $1
        LIMIT $2`,
        waitpointId,
        CONNECTED_RUNS_DISPLAY_LIMIT
      );
      return rows.map((row) => row.taskRunId);
    }

    const rows = await client.$queryRawUnsafe<{ A: string }[]>(
      `SELECT c."A" AS "A"
      FROM ${DATABASE_SCHEMA}."_WaitpointRunConnections" c
      JOIN ${DATABASE_SCHEMA}."TaskRun" t ON t."id" = c."A"
      WHERE c."B" = $1
      LIMIT $2`,
      waitpointId,
      CONNECTED_RUNS_DISPLAY_LIMIT
    );
    return rows.map((row) => row.A);
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
