import { ManageConcurrencyPresenter } from "~/presenters/v3/ManageConcurrencyPresenter.server";
import { BaseService } from "./baseService.server";
import { tryCatch } from "@trigger.dev/core";
import { setConcurrencyAddOn } from "~/services/platform.v3.server";
import assertNever from "assert-never";

type Input = {
  userId: string;
  projectId: string;
  organizationId: string;
  action: "purchase" | "quota-increase";
  amount: number;
};

type Result =
  | {
      success: true;
    }
  | {
      success: false;
      error: string;
    };

export class SetConcurrencyAddOnService extends BaseService {
  async call({ userId, projectId, organizationId, action, amount }: Input): Promise<Result> {
    // fetch the current concurrency
    const presenter = new ManageConcurrencyPresenter(this._prisma, this._replica);
    const [error, result] = await tryCatch(
      presenter.call({
        userId,
        projectId,
        organizationId,
      })
    );

    if (error) {
      return {
        success: false,
        error: "Unknown error",
      };
    }

    const currentConcurrency = result.extraConcurrency;
    const totalExtraConcurrency = currentConcurrency + amount;

    switch (action) {
      case "purchase": {
        const updatedConcurrency = await setConcurrencyAddOn(organizationId, totalExtraConcurrency);
        if (!updatedConcurrency) {
          return {
            success: false,
            error: "Failed to update concurrency",
          };
        }

        switch (updatedConcurrency?.result) {
          case "success": {
            return {
              success: true,
            };
          }
          case "error": {
            return {
              success: false,
              error: updatedConcurrency.error,
            };
          }
          case "max_quota_reached": {
            return {
              success: false,
              error: `You can't purchase more than ${updatedConcurrency.maxQuota} concurrency without requesting an increase.`,
            };
          }
          default: {
            return {
              success: false,
              error: "Failed to update concurrency, unknown result.",
            };
          }
        }
      }
      case "quota-increase": {
        return {
          success: false,
          error: "Quota increase is not supported yet.",
        };
        break;
      }
      default: {
        assertNever(action);
      }
    }
  }
}
