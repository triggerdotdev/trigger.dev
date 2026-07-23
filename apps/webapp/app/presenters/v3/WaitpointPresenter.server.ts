import { isWaitpointOutputTimeout, prettyPrintPacket } from "@trigger.dev/core/v3";
import { type PrismaClientOrTransaction } from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { generateHttpCallbackUrl } from "~/services/httpCallback.server";
import { logger } from "~/services/logger.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { runStore as defaultRunStore } from "~/v3/runStore.server";
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
      // Forwarded to the NextRunListPresenter that hydrates connected runs; this presenter's own
      // waitpoint + connected-run reads route through `runStore`. Omitted => single-DB passthrough.
      newClient?: PrismaClientOrTransaction;
      legacyReplica?: PrismaClientOrTransaction;
      splitEnabled?: boolean;
    },
    private readonly runStore = defaultRunStore
  ) {
    super(prisma, replica);
  }

  async #findWaitpoint(friendlyId: string, environmentId: string) {
    // Keyed by (friendlyId, environmentId) with no classifiable waitpoint id, so the run-store
    // probes NEW then LEGACY and reads each store's own replica — resolving the waitpoint whichever
    // run store owns it. When split is off it reads the single control-plane replica (passthrough).
    return this.runStore.findWaitpoint({
      where: { friendlyId, environmentId },
      select: {
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
      },
    });
  }

  // Connected-run friendlyIds gathered across BOTH stores. The run<->waitpoint join co-locates with
  // the RUN (written on the run's DB), so the waitpoint's own store misses a cross-DB connection.
  // The run-store fans the connection lookup out to both DBs (bounded there) and resolves each run
  // id on its owning DB (by id-shape residency), so we get the union without joining across the seam.
  async #connectedRunFriendlyIds(waitpointId: string): Promise<string[]> {
    const runIds = await this.runStore.findWaitpointConnectedRunIds(waitpointId);
    if (runIds.length === 0) {
      return [];
    }
    const runs = await this.runStore.findRuns({
      where: { id: { in: runIds } },
      select: { friendlyId: true },
      take: CONNECTED_RUNS_DISPLAY_LIMIT,
    });
    return runs.map((run) => run.friendlyId);
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
