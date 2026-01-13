import { type RuntimeEnvironmentType } from "@trigger.dev/database";
import { env } from "~/env.server";
import { getCurrentPlan, getDefaultEnvironmentLimitFromPlan } from "~/services/platform.v3.server";
import {
  RateLimiterConfig,
  type RateLimitTokenBucketConfig,
} from "~/services/authorizationRateLimitMiddleware.server";
import type { Duration } from "~/services/rateLimiter.server";
import { BasePresenter } from "./basePresenter.server";
import { sortEnvironments } from "~/utils/environmentSort";
import { engine } from "~/v3/runEngine.server";

// Types for rate limit display
export type RateLimitInfo = {
  name: string;
  description: string;
  config: RateLimiterConfig;
  source: "default" | "plan" | "override";
};

// Types for concurrency limit display
export type ConcurrencyLimitInfo = {
  environmentId: string;
  environmentType: RuntimeEnvironmentType;
  branchName: string | null;
  limit: number;
  currentUsage: number;
  planLimit: number;
  source: "default" | "plan" | "override";
};

// Types for quota display
export type QuotaInfo = {
  name: string;
  description: string;
  limit: number | null;
  currentUsage: number;
  source: "default" | "plan" | "override";
};

export type LimitsResult = {
  rateLimits: {
    api: RateLimitInfo;
    batch: RateLimitInfo;
  };
  concurrencyLimits: ConcurrencyLimitInfo[];
  quotas: {
    projects: QuotaInfo;
    schedules: QuotaInfo | null;
    devQueueSize: QuotaInfo;
    deployedQueueSize: QuotaInfo;
  };
  batchConcurrency: {
    limit: number;
    source: "default" | "override";
  };
  planName: string | null;
};

export class LimitsPresenter extends BasePresenter {
  public async call({
    userId,
    projectId,
    organizationId,
  }: {
    userId: string;
    projectId: string;
    organizationId: string;
  }): Promise<LimitsResult> {
    // Get organization with all limit-related fields
    const organization = await this._replica.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: {
        id: true,
        maximumConcurrencyLimit: true,
        maximumProjectCount: true,
        maximumDevQueueSize: true,
        maximumDeployedQueueSize: true,
        apiRateLimiterConfig: true,
        batchRateLimitConfig: true,
        batchQueueConcurrencyConfig: true,
        _count: {
          select: {
            projects: {
              where: { deletedAt: null },
            },
          },
        },
      },
    });

    // Get current plan from billing service
    const currentPlan = await getCurrentPlan(organizationId);

    // Get environments for this project
    const environments = await this._replica.runtimeEnvironment.findMany({
      select: {
        id: true,
        type: true,
        branchName: true,
        maximumConcurrencyLimit: true,
        orgMember: {
          select: {
            userId: true,
          },
        },
      },
      where: {
        projectId,
        archivedAt: null,
      },
    });

    // Get current concurrency for each environment
    const concurrencyLimits: ConcurrencyLimitInfo[] = [];
    for (const environment of environments) {
      // Skip dev environments that belong to other users
      if (environment.type === "DEVELOPMENT" && environment.orgMember?.userId !== userId) {
        continue;
      }

      const planLimit = currentPlan
        ? getDefaultEnvironmentLimitFromPlan(environment.type, currentPlan) ??
          env.DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT
        : env.DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT;

      // Get current concurrency from Redis
      let currentUsage = 0;
      try {
        currentUsage = await engine.runQueue.currentConcurrencyOfEnvironment({
          id: environment.id,
          type: environment.type,
          organizationId,
          projectId,
        });
      } catch (e) {
        // Redis might not be available, default to 0
      }

      // Determine source
      let source: "default" | "plan" | "override" = "default";
      if (environment.maximumConcurrencyLimit !== planLimit) {
        source = "override";
      } else if (currentPlan?.v3Subscription?.plan) {
        source = "plan";
      }

      concurrencyLimits.push({
        environmentId: environment.id,
        environmentType: environment.type,
        branchName: environment.branchName,
        limit: environment.maximumConcurrencyLimit,
        currentUsage,
        planLimit,
        source,
      });
    }

    // Sort environments
    const sortedConcurrencyLimits = sortEnvironments(concurrencyLimits, [
      "PRODUCTION",
      "STAGING",
      "PREVIEW",
      "DEVELOPMENT",
    ]);

    // Resolve API rate limit config
    const apiRateLimitConfig = resolveApiRateLimitConfig(organization.apiRateLimiterConfig);
    const apiRateLimitSource = organization.apiRateLimiterConfig ? "override" : "default";

    // Resolve batch rate limit config
    const batchRateLimitConfig = resolveBatchRateLimitConfig(organization.batchRateLimitConfig);
    const batchRateLimitSource = organization.batchRateLimitConfig ? "override" : "default";

    // Resolve batch concurrency config
    const batchConcurrencyConfig = resolveBatchConcurrencyConfig(
      organization.batchQueueConcurrencyConfig
    );
    const batchConcurrencySource = organization.batchQueueConcurrencyConfig
      ? "override"
      : "default";

    // Get schedule count for this org
    const scheduleCount = await this._replica.taskSchedule.count({
      where: {
        instances: {
          some: {
            environment: {
              organizationId,
            },
          },
        },
      },
    });

    // Get plan-level schedule limit
    const schedulesLimit = currentPlan?.v3Subscription?.plan?.limits?.schedules?.number ?? null;

    return {
      rateLimits: {
        api: {
          name: "API Rate Limit",
          description: "Rate limit for API requests (trigger, batch, etc.)",
          config: apiRateLimitConfig,
          source: apiRateLimitSource,
        },
        batch: {
          name: "Batch Rate Limit",
          description: "Rate limit for batch trigger operations",
          config: batchRateLimitConfig,
          source: batchRateLimitSource,
        },
      },
      concurrencyLimits: sortedConcurrencyLimits,
      quotas: {
        projects: {
          name: "Projects",
          description: "Maximum number of projects in this organization",
          limit: organization.maximumProjectCount,
          currentUsage: organization._count.projects,
          source: "default",
        },
        schedules:
          schedulesLimit !== null
            ? {
                name: "Schedules",
                description: "Maximum number of schedules across all projects",
                limit: schedulesLimit,
                currentUsage: scheduleCount,
                source: "plan",
              }
            : null,
        devQueueSize: {
          name: "Dev Queue Size",
          description: "Maximum pending runs in development environments",
          limit: organization.maximumDevQueueSize ?? null,
          currentUsage: 0, // Would need to query Redis for this
          source: organization.maximumDevQueueSize ? "override" : "default",
        },
        deployedQueueSize: {
          name: "Deployed Queue Size",
          description: "Maximum pending runs in deployed environments",
          limit: organization.maximumDeployedQueueSize ?? null,
          currentUsage: 0, // Would need to query Redis for this
          source: organization.maximumDeployedQueueSize ? "override" : "default",
        },
      },
      batchConcurrency: {
        limit: batchConcurrencyConfig.processingConcurrency,
        source: batchConcurrencySource,
      },
      planName: currentPlan?.v3Subscription?.plan?.title ?? null,
    };
  }
}

function resolveApiRateLimitConfig(apiRateLimiterConfig?: unknown): RateLimiterConfig {
  const defaultConfig: RateLimitTokenBucketConfig = {
    type: "tokenBucket",
    refillRate: env.API_RATE_LIMIT_REFILL_RATE,
    interval: env.API_RATE_LIMIT_REFILL_INTERVAL as Duration,
    maxTokens: env.API_RATE_LIMIT_MAX,
  };

  if (!apiRateLimiterConfig) {
    return defaultConfig;
  }

  const parsed = RateLimiterConfig.safeParse(apiRateLimiterConfig);
  if (!parsed.success) {
    return defaultConfig;
  }

  return parsed.data;
}

function resolveBatchRateLimitConfig(batchRateLimitConfig?: unknown): RateLimiterConfig {
  const defaultConfig: RateLimitTokenBucketConfig = {
    type: "tokenBucket",
    refillRate: env.BATCH_RATE_LIMIT_REFILL_RATE,
    interval: env.BATCH_RATE_LIMIT_REFILL_INTERVAL as Duration,
    maxTokens: env.BATCH_RATE_LIMIT_MAX,
  };

  if (!batchRateLimitConfig) {
    return defaultConfig;
  }

  const parsed = RateLimiterConfig.safeParse(batchRateLimitConfig);
  if (!parsed.success) {
    return defaultConfig;
  }

  return parsed.data;
}

function resolveBatchConcurrencyConfig(batchConcurrencyConfig?: unknown): {
  processingConcurrency: number;
} {
  const defaultConfig = {
    processingConcurrency: env.BATCH_CONCURRENCY_LIMIT_DEFAULT,
  };

  if (!batchConcurrencyConfig) {
    return defaultConfig;
  }

  if (typeof batchConcurrencyConfig === "object" && batchConcurrencyConfig !== null) {
    const config = batchConcurrencyConfig as Record<string, unknown>;
    if (typeof config.processingConcurrency === "number") {
      return { processingConcurrency: config.processingConcurrency };
    }
  }

  return defaultConfig;
}
