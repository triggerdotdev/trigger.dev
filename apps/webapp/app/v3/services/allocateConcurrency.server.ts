import { tryCatch } from "@trigger.dev/core";
import { ManageConcurrencyPresenter } from "~/presenters/v3/ManageConcurrencyPresenter.server";
import { BaseService } from "./baseService.server";
import { updateEnvConcurrencyLimits } from "../runQueue.server";

type Input = {
  userId: string;
  projectId: string;
  organizationId: string;
  environments: { id: string; amount: number }[];
};

type Result =
  | {
      success: true;
    }
  | {
      success: false;
      error: string;
    };

export class AllocateConcurrencyService extends BaseService {
  async call({ userId, projectId, organizationId, environments }: Input): Promise<Result> {
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

    const previousExtra = result.environments.reduce(
      (acc, e) => Math.max(0, e.maximumConcurrencyLimit - e.planConcurrencyLimit) + acc,
      0
    );
    const newExtra = environments.reduce((acc, e) => e.amount + acc, 0);
    const change = newExtra - previousExtra;

    const totalExtra = result.extraAllocatedConcurrency + change;

    if (change > result.extraUnallocatedConcurrency) {
      return {
        success: false,
        error: `You don't have enough unallocated concurrency available. You requested ${totalExtra} but only have ${result.extraUnallocatedConcurrency}.`,
      };
    }

    for (const environment of environments) {
      const existingEnvironment = result.environments.find((e) => e.id === environment.id);

      if (!existingEnvironment) {
        return {
          success: false,
          error: `Environment not found ${environment.id}`,
        };
      }

      const newConcurrency = existingEnvironment.planConcurrencyLimit + environment.amount;

      const updatedEnvironment = await this._prisma.runtimeEnvironment.update({
        where: {
          id: environment.id,
        },
        data: {
          maximumConcurrencyLimit: newConcurrency,
        },
        include: {
          project: true,
          organization: true,
        },
      });

      if (!updatedEnvironment.paused) {
        await updateEnvConcurrencyLimits(updatedEnvironment);
      }
    }

    return {
      success: true,
    };
  }
}
