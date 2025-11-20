import { type RuntimeEnvironmentType } from "@trigger.dev/database";
import {
  getCurrentPlan,
  getDefaultEnvironmentLimitFromPlan,
  getPlans,
} from "~/services/platform.v3.server";
import { BasePresenter } from "./basePresenter.server";
import { sortEnvironments } from "~/utils/environmentSort";

export type ConcurrencyResult = {
  canAddConcurrency: boolean;
  environments: EnvironmentWithConcurrency[];
  extraConcurrency: number;
  extraAllocatedConcurrency: number;
  extraUnallocatedConcurrency: number;
  maxQuota: number;
  concurrencyPricing: {
    stepSize: number;
    centsPerStep: number;
  };
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
        orgMember: {
          select: {
            userId: true,
          },
        },
        project: {
          select: {
            deletedAt: true,
          },
        },
      },
      where: {
        organizationId,
        archivedAt: null,
      },
    });

    const extraConcurrency = currentPlan?.v3Subscription.addOns?.concurrentRuns?.purchased ?? 0;

    // Go through all environments and add up extra concurrency above their allowed allocation
    let extraAllocatedConcurrency = 0;
    const projectEnvironments: EnvironmentWithConcurrency[] = [];
    for (const environment of environments) {
      // Don't count parent environments
      if (environment.isBranchableEnvironment) continue;

      // Don't count deleted projects
      if (environment.project.deletedAt) continue;

      const limit = currentPlan
        ? getDefaultEnvironmentLimitFromPlan(environment.type, currentPlan)
        : 0;
      if (!limit) continue;

      // If it's not DEV and they've increased, track that
      // You can't spend money to increase DEV concurrency
      if (environment.type !== "DEVELOPMENT" && environment.maximumConcurrencyLimit > limit) {
        extraAllocatedConcurrency += environment.maximumConcurrencyLimit - limit;
      }

      // We only want to show this project's environments
      if (environment.projectId === projectId) {
        if (environment.type === "DEVELOPMENT" && environment.orgMember?.userId !== userId) {
          continue;
        }

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

    const extraAllocated = Math.min(extraConcurrency, extraAllocatedConcurrency);

    const plans = await getPlans();
    if (!plans) {
      throw new Error("Couldn't retrieve add on pricing");
    }

    return {
      canAddConcurrency,
      extraConcurrency,
      extraAllocatedConcurrency: extraAllocated,
      extraUnallocatedConcurrency: extraConcurrency - extraAllocated,
      maxQuota: currentPlan.v3Subscription.addOns?.concurrentRuns?.quota ?? 0,
      environments: sortEnvironments(projectEnvironments, [
        "PRODUCTION",
        "STAGING",
        "PREVIEW",
        "DEVELOPMENT",
      ]),
      concurrencyPricing: plans.addOnPricing.concurrency,
    };
  }
}
