import { parsePacket, UpdateMetadataRequestBody } from "@trigger.dev/core/v3";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { handleMetadataPacket } from "~/utils/packets";
import { BaseService, ServiceValidationError } from "~/v3/services/baseService.server";
import { isFinalRunStatus } from "~/v3/taskStatus";

export class UpdateMetadataService extends BaseService {
  public async call(
    environment: AuthenticatedEnvironment,
    runId: string,
    body: UpdateMetadataRequestBody
  ) {
    const metadataPacket = handleMetadataPacket(
      body.metadata,
      body.metadataType ?? "application/json"
    );

    if (!metadataPacket) {
      throw new ServiceValidationError("Invalid metadata");
    }

    const taskRun = await this._prisma.taskRun.findFirst({
      where: {
        friendlyId: runId,
        runtimeEnvironmentId: environment.id,
      },
      select: {
        id: true,
        status: true,
        parentTaskRun: {
          select: {
            id: true,
            status: true,
          },
        },
        rootTaskRun: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });

    if (!taskRun) {
      return;
    }

    if (isFinalRunStatus(taskRun.status)) {
      throw new ServiceValidationError("Cannot update metadata for a completed run");
    }

    await this._prisma.taskRun.update({
      where: {
        id: taskRun.id,
      },
      data: {
        metadata: metadataPacket?.data,
        metadataType: metadataPacket?.dataType,
      },
    });

    const newMetadata = await parsePacket(metadataPacket);

    return {
      metadata: newMetadata,
    };
  }
}

export const updateMetadataService = new UpdateMetadataService();
