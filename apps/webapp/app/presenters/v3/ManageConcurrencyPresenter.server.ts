import { type RuntimeEnvironmentType } from "@trigger.dev/database";
import { getCurrentPlan, getDefaultEnvironmentLimitFromPlan } from "~/services/platform.v3.server";
import { BasePresenter } from "./basePresenter.server";
import { sortEnvironments } from "~/utils/environmentSort";

export type ConcurrencyResult = {
  canAddConcurrency: boolean;
  environments: EnvironmentWithConcurrency[];
  extraConcurrency: number;
  extraAllocatedConcurrency: number;
};

export type EnvironmentWithConcurrency = {
  id: string;
  type: RuntimeEnvironmentType;
  isBranchableEnvironment: boolean;
  branchName: string | null;
  parentEnvironmentId: string | null;
  maximumConcurrencyLimit: number;
  planConcurrencyLimit: number;
};

export class ManageConcurrencyPresenter extends BasePresenter {
  public async call({
    userId,
    projectId,
    organizationId,
  }: {
    userId: string;
    projectId: string;
    organizationId: string;
  }): Promise<ConcurrencyResult> {
    // Get plan
    const currentPlan = await getCurrentPlan(organizationId);
    if (!currentPlan) {
      throw new Error("No plan found");
    }

    const canAddConcurrency =
      currentPlan.v3Subscription.plan?.limits.concurrentRuns.canExceed === true;

    const environments = await this._replica.runtimeEnvironment.findMany({
      select: {
        id: true,
        projectId: true,
        type: true,
        branchName: true,
        parentEnvironmentId: true,
        isBranchableEnvironment: true,
        maximumConcurrencyLimit: true,
      },
      where: {
        organizationId,
      },
    });

    const extraConcurrency = currentPlan?.v3Subscription.addOns?.concurrentRuns?.purchased ?? 0;

    // Go through all environments and add up extra concurrency above their allowed allocation
    let extraAllocatedConcurrency = 0;
    const projectEnvironments: EnvironmentWithConcurrency[] = [];
    for (const environment of environments) {
      // Don't count parent environments
      if (environment.isBranchableEnvironment) continue;

      const limit = currentPlan
        ? getDefaultEnvironmentLimitFromPlan(environment.type, currentPlan)
        : 0;
      if (!limit) continue;

      if (environment.maximumConcurrencyLimit > limit) {
        extraAllocatedConcurrency += environment.maximumConcurrencyLimit - limit;
      }

      if (environment.projectId === projectId) {
        projectEnvironments.push({
          id: environment.id,
          type: environment.type,
          isBranchableEnvironment: environment.isBranchableEnvironment,
          branchName: environment.branchName,
          parentEnvironmentId: environment.parentEnvironmentId,
          maximumConcurrencyLimit: environment.maximumConcurrencyLimit,
          planConcurrencyLimit: limit,
        });
      }
    }

    return {
      canAddConcurrency,
      extraConcurrency,
      extraAllocatedConcurrency,
      environments: sortEnvironments(projectEnvironments).reverse(),
    };
  }
}
