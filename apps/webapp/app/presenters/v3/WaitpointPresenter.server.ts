import { isWaitpointOutputTimeout, prettyPrintPacket } from "@trigger.dev/core/v3";
import { logger } from "~/services/logger.server";
import { BasePresenter } from "./basePresenter.server";

export type WaitpointDetail = NonNullable<Awaited<ReturnType<WaitpointPresenter["call"]>>>;

export class WaitpointPresenter extends BasePresenter {
  public async call({ friendlyId, environmentId }: { friendlyId: string; environmentId: string }) {
    const waitpoint = await this._replica.waitpoint.findFirst({
      where: {
        friendlyId,
        environmentId,
      },
      select: {
        friendlyId: true,
        type: true,
        status: true,
        idempotencyKey: true,
        userProvidedIdempotencyKey: true,
        idempotencyKeyExpiresAt: true,
        output: true,
        outputType: true,
        outputIsError: true,
        completedAfter: true,
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

    return {
      friendlyId: waitpoint.friendlyId,
      type: waitpoint.type,
      status: waitpoint.status,
      idempotencyKey: waitpoint.idempotencyKey,
      userProvidedIdempotencyKey: waitpoint.userProvidedIdempotencyKey,
      idempotencyKeyExpiresAt: waitpoint.idempotencyKeyExpiresAt,
      output: output,
      outputType: waitpoint.outputType,
      outputIsError: waitpoint.outputIsError,
      completedAfter: waitpoint.completedAfter,
      isTimeout,
    };
  }
}
