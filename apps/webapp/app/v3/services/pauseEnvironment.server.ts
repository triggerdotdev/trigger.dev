import { EnvironmentPauseSource, type PrismaClientOrTransaction } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { getManualPauseEnvironmentResult } from "~/v3/services/billingLimit/manualPauseEnvironmentGuard.server";
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
      const org = await this._prisma.organization.findFirst({
        where: {
          id: environment.organizationId,
        },
        select: {
          runsEnabled: true,
        },
      });

      if (!org) {
        throw new Error("Organization not found");
      }

      const previousPauseState = await this._prisma.runtimeEnvironment.findFirst({
        where: { id: environment.id },
        select: {
          paused: true,
          pauseSource: true,
        },
      });

      const manualPauseGuard = getManualPauseEnvironmentResult(
        action,
        previousPauseState?.pauseSource
      );
      if (!manualPauseGuard.proceed) {
        if (manualPauseGuard.success) {
          return {
            success: true,
            state: manualPauseGuard.state,
          };
        }
        // Expected, user-actionable guard result, not an error: return it as a failure
        // result so it doesn't reach Sentry via the catch below.
        return {
          success: false,
          error: manualPauseGuard.error,
        };
      }

      if (!org.runsEnabled && action === "resumed") {
        throw new Error(
          "Runs are disabled for this organization. Your free plan has probably been exceeded. If not please contact support."
        );
      }

      if (action === "resumed") {
        const resumed = await this._prisma.runtimeEnvironment.updateMany({
          where: {
            id: environment.id,
            NOT: { pauseSource: EnvironmentPauseSource.BILLING_LIMIT },
          },
          data: {
            paused: false,
            pauseSource: null,
          },
        });

        if (resumed.count === 0) {
          // Raced into the paused state after the guard read above: expected,
          // return as a failure result rather than throwing to Sentry.
          return {
            success: false,
            error:
              "This environment is paused because your organization reached its billing limit. Resolve the limit on the billing limits settings page to resume.",
          };
        }
      } else {
        await this._prisma.runtimeEnvironment.update({
          where: { id: environment.id },
          data: { paused: true },
        });
      }

      try {
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
      } catch (error) {
        await this._prisma.runtimeEnvironment.update({
          where: { id: environment.id },
          data: {
            paused: previousPauseState?.paused ?? action === "resumed",
            pauseSource: previousPauseState?.pauseSource ?? null,
          },
        });
        throw error;
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
