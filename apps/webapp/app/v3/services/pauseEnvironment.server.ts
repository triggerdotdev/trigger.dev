import { AuthenticatedEnvironment } from "@internal/testcontainers";
import { BatchTriggerTaskV3RequestBody, BatchTriggerTaskV3Response } from "@trigger.dev/core/v3";
import { PrismaClientOrTransaction } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { WithRunEngine } from "./baseService.server";
import { BatchProcessingStrategy, BatchTriggerTaskServiceOptions } from "./batchTriggerV3.server";
import { determineEngineVersion } from "../engineVersion.server";

export type PauseStatus = "paused" | "resumed";

export type PauseEnvironmentResult =
  | {
      success: true;
      state: PauseStatus;
    }
  | {
      success: false;
      error: string;
    };

export class PauseEnvironmentService extends WithRunEngine {
  constructor(protected readonly _prisma: PrismaClientOrTransaction = prisma) {
    super({ prisma });
  }

  public async call(
    environment: AuthenticatedEnvironment,
    action: "pause" | "resume"
  ): Promise<PauseEnvironmentResult> {
    const version = await determineEngineVersion({
      environment,
    });

    if (version === "V1") {
      return {
        success: false,
        error: "You need to be on Run Engine v2+ to pause an environment",
      };
    }

    if (action === "pause") {
      await this._prisma.runtimeEnvironment.update({});
    }
  }
}
