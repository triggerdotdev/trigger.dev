import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { updateEnvConcurrencyLimits } from "../runQueue.server";
import { WithRunEngine } from "./baseService.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";

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
    action: PauseStatus
  ): Promise<PauseEnvironmentResult> {
    try {
      await this._prisma.runtimeEnvironment.update({
        where: {
          id: environment.id,
        },
        data: {
          paused: action === "paused",
        },
      });

      if (action === "paused") {
        logger.debug("PauseEnvironmentService: pausing environment", {
          environmentId: environment.id,
        });
        await updateEnvConcurrencyLimits(environment, 0);
      } else {
        logger.debug("PauseEnvironmentService: resuming environment", {
          environmentId: environment.id,
        });
        await updateEnvConcurrencyLimits(environment);
      }

      return {
        success: true,
        state: action,
      };
    } catch (error) {
      logger.error("PauseEnvironmentService: error pausing environment", {
        action,
        environmentId: environment.id,
        error,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
