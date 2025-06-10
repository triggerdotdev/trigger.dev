import { isWaitpointOutputTimeout, prettyPrintPacket } from "@trigger.dev/core/v3";
import { generateHttpCallbackUrl } from "~/services/httpCallback.server";
import { logger } from "~/services/logger.server";
import { BasePresenter } from "./basePresenter.server";
import { type RunListItem, RunListPresenter } from "./RunListPresenter.server";
import { waitpointStatusToApiStatus } from "./WaitpointListPresenter.server";

export type WaitpointDetail = NonNullable<Awaited<ReturnType<WaitpointPresenter["call"]>>>;

export class WaitpointPresenter extends BasePresenter {
  public async call({
    friendlyId,
    environmentId,
    projectId,
  }: {
    friendlyId: string;
    environmentId: string;
    projectId: string;
  }) {
    const waitpoint = await this._replica.waitpoint.findFirst({
      where: {
        friendlyId,
        environmentId,
      },
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
        connectedRuns: {
          select: {
            friendlyId: true,
          },
          take: 5,
        },
        tags: true,
        environment: {
          select: {
            apiKey: true,
          },
        },
      },
    });

    if (!waitpoint) {
      logger.error(`WaitpointPresenter: Waitpoint not found`, {
        friendlyId,
      });
      return null;
    }

    const output =
      waitpoint.outputType === "application/store"
        ? `/resources/packets/${environmentId}/${waitpoint.output}`
        : typeof waitpoint.output !== "undefined" && waitpoint.output !== null
        ? await prettyPrintPacket(waitpoint.output, waitpoint.outputType ?? undefined)
        : undefined;

    let isTimeout = false;
    if (waitpoint.outputIsError && output) {
      if (isWaitpointOutputTimeout(output)) {
        isTimeout = true;
      }
    }

    const connectedRunIds = waitpoint.connectedRuns.map((run) => run.friendlyId);
    const connectedRuns: RunListItem[] = [];

    if (connectedRunIds.length > 0) {
      const runPresenter = new RunListPresenter();
      const { runs } = await runPresenter.call(environmentId, {
        projectId: projectId,
        runIds: connectedRunIds,
        pageSize: 5,
      });
      connectedRuns.push(...runs);
    }

    return {
      id: waitpoint.friendlyId,
      type: waitpoint.type,
      url: generateHttpCallbackUrl(waitpoint.id, waitpoint.environment.apiKey),
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
