import { Ratelimit } from "@upstash/ratelimit";
import { createHash } from "node:crypto";
import { env } from "~/env.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import {
  RateLimiterConfig,
  createLimiterFromConfig,
  type RateLimitTokenBucketConfig,
} from "~/services/authorizationRateLimitMiddleware.server";
import { createRedisRateLimitClient, type Duration } from "~/services/rateLimiter.server";
import { BasePresenter } from "./basePresenter.server";
import { singleton } from "~/utils/singleton";
import { logger } from "~/services/logger.server";
import { CheckScheduleService } from "~/v3/services/checkSchedule.server";

// Create a singleton Redis client for rate limit queries
const rateLimitRedisClient = singleton("rateLimitQueryRedisClient", () =>
  createRedisRateLimitClient({
    port: env.RATE_LIMIT_REDIS_PORT,
    host: env.RATE_LIMIT_REDIS_HOST,
    username: env.RATE_LIMIT_REDIS_USERNAME,
    password: env.RATE_LIMIT_REDIS_PASSWORD,
    tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
    clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
  })
);

// Types for rate limit display
export type RateLimitInfo = {
  name: string;
  description: string;
  config: RateLimiterConfig;
  currentTokens: number | null;
};

// Types for quota display
export type QuotaInfo = {
  name: string;
  description: string;
  limit: number | null;
  currentUsage: number;
  source: "default" | "plan" | "override";
  canExceed?: boolean;
  isUpgradable?: boolean;
};

// Types for feature flags
export type FeatureInfo = {
  name: string;
  description: string;
  enabled: boolean;
  value?: string | number;
};

export type LimitsResult = {
  rateLimits: {
    api: RateLimitInfo;
    batch: RateLimitInfo;
  };
  quotas: {
    projects: QuotaInfo;
    schedules: QuotaInfo | null;
    teamMembers: QuotaInfo | null;
    alerts: QuotaInfo | null;
    branches: QuotaInfo | null;
    logRetentionDays: QuotaInfo | null;
    realtimeConnections: QuotaInfo | null;
    batchProcessingConcurrency: QuotaInfo;
    devQueueSize: QuotaInfo;
    deployedQueueSize: QuotaInfo;
  };
  features: {
    hasStagingEnvironment: FeatureInfo;
    support: FeatureInfo;
    includedUsage: FeatureInfo;
  };
  planName: string | null;
  organizationId: string;
  isOnTopPlan: boolean;
};

export class LimitsPresenter extends BasePresenter {
  public async call({
    organizationId,
    projectId,
    environmentId,
    environmentApiKey,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    environmentApiKey: string;
  }): Promise<LimitsResult> {
    // Get organization with all limit-related fields
    const organization = await this._replica.organization.findFirstOrThrow({
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
            members: true,
          },
        },
      },
    });

    // Get current plan from billing service
    const currentPlan = await getCurrentPlan(organizationId);
    const limits = currentPlan?.v3Subscription?.plan?.limits;
    const isOnTopPlan = currentPlan?.v3Subscription?.plan?.code === "v3_pro_1";

    // Resolve rate limit configs (org override or default)
    const apiRateLimitConfig = resolveApiRateLimitConfig(organization.apiRateLimiterConfig);
    const batchRateLimitConfig = resolveBatchRateLimitConfig(organization.batchRateLimitConfig);

    // Resolve batch concurrency config
    const batchConcurrencyConfig = resolveBatchConcurrencyConfig(
      organization.batchQueueConcurrencyConfig
    );
    const batchConcurrencySource = organization.batchQueueConcurrencyConfig
      ? "override"
      : "default";

    // Get schedule count for this org
    const scheduleCount = await CheckScheduleService.getUsedSchedulesCount({
      prisma: this._replica,
      projectId,
    });

    // Get alert channel count for this org
    const alertChannelCount = await this._replica.projectAlertChannel.count({
      where: {
        projectId,
      },
    });

    // Get active branches count for this org (uses @@index([organizationId]))
    const activeBranchCount = await this._replica.runtimeEnvironment.count({
      where: {
        projectId,
        branchName: {
          not: null,
        },
        archivedAt: null,
      },
    });

    // Get current rate limit tokens for this environment's API key
    const apiRateLimitTokens = await getRateLimitRemainingTokens(
      "api",
      environmentApiKey,
      apiRateLimitConfig
    );
    // Batch rate limiter uses environment ID directly (not hashed) with a different key prefix
    const batchRateLimitTokens = await getBatchRateLimitRemainingTokens(
      environmentId,
      batchRateLimitConfig
    );

    // Get plan-level limits
    const schedulesLimit = limits?.schedules?.number ?? null;
    const teamMembersLimit = limits?.teamMembers?.number ?? null;
    const alertsLimit = limits?.alerts?.number ?? null;
    const branchesLimit = limits?.branches?.number ?? null;
    const logRetentionDaysLimit = limits?.logRetentionDays?.number ?? null;
    const realtimeConnectionsLimit = limits?.realtimeConcurrentConnections?.number ?? null;
    const includedUsage = limits?.includedUsage ?? null;
    const hasStagingEnvironment = limits?.hasStagingEnvironment ?? false;
    const supportLevel = limits?.support ?? "community";

    return {
      isOnTopPlan,
      rateLimits: {
        api: {
          name: "API rate limit",
          description: "Rate limit for API requests (trigger, batch, etc.)",
          config: apiRateLimitConfig,
          currentTokens: apiRateLimitTokens,
        },
        batch: {
          name: "Batch rate limit",
          description: "Rate limit for batch trigger operations",
          config: batchRateLimitConfig,
          currentTokens: batchRateLimitTokens,
        },
      },
      quotas: {
        projects: {
          name: "Projects",
          description: "Maximum number of projects in this organization",
          limit: organization.maximumProjectCount,
          currentUsage: organization._count.projects,
          source: "default",
          isUpgradable: true,
        },
        schedules:
          schedulesLimit !== null
            ? {
                name: "Schedules",
                description: "Maximum number of schedules per project",
                limit: schedulesLimit,
                currentUsage: scheduleCount,
                source: "plan",
                canExceed: limits?.schedules?.canExceed,
                isUpgradable: true,
              }
            : null,
        teamMembers:
          teamMembersLimit !== null
            ? {
                name: "Team members",
                description: "Maximum number of team members in this organization",
                limit: teamMembersLimit,
                currentUsage: organization._count.members,
                source: "plan",
                canExceed: limits?.teamMembers?.canExceed,
                isUpgradable: true,
              }
            : null,
        alerts:
          alertsLimit !== null
            ? {
                name: "Alert channels",
                description: "Maximum number of alert channels per project",
                limit: alertsLimit,
                currentUsage: alertChannelCount,
                source: "plan",
                canExceed: limits?.alerts?.canExceed,
                isUpgradable: true,
              }
            : null,
        branches:
          branchesLimit !== null
            ? {
                name: "Preview branches",
                description: "Maximum number of active preview branches per project",
                limit: branchesLimit,
                currentUsage: activeBranchCount,
                source: "plan",
                canExceed: limits?.branches?.canExceed,
                isUpgradable: true,
              }
            : null,
        logRetentionDays:
          logRetentionDaysLimit !== null
            ? {
                name: "Log retention",
                description: "Number of days logs are retained",
                limit: logRetentionDaysLimit,
                currentUsage: 0, // Not applicable - this is a duration, not a count
                source: "plan",
              }
            : null,
        realtimeConnections:
          realtimeConnectionsLimit !== null
            ? {
                name: "Realtime connections",
                description: "Maximum concurrent Realtime connections",
                limit: realtimeConnectionsLimit,
                currentUsage: 0, // Would need to query realtime service for this
                source: "plan",
                canExceed: limits?.realtimeConcurrentConnections?.canExceed,
                isUpgradable: true,
              }
            : null,
        batchProcessingConcurrency: {
          name: "Batch processing concurrency",
          description: "Controls how many batch items can be processed simultaneously.",
          limit: batchConcurrencyConfig.processingConcurrency,
          currentUsage: 0,
          source: batchConcurrencySource,
          canExceed: true,
          isUpgradable: true,
        },
        devQueueSize: {
          name: "Dev queue size",
          description: "Maximum pending runs in development environments",
          limit: organization.maximumDevQueueSize ?? null,
          currentUsage: 0, // Would need to query Redis for this
          source: organization.maximumDevQueueSize ? "override" : "default",
        },
        deployedQueueSize: {
          name: "Deployed queue size",
          description: "Maximum pending runs in deployed environments",
          limit: organization.maximumDeployedQueueSize ?? null,
          currentUsage: 0, // Would need to query Redis for this
          source: organization.maximumDeployedQueueSize ? "override" : "default",
        },
      },
      features: {
        hasStagingEnvironment: {
          name: "Staging/Preview environments",
          description: "Access to staging/preview environments for testing before production",
          enabled: hasStagingEnvironment,
        },
        support: {
          name: "Support level",
          description: "Type of support available for your plan",
          enabled: true,
          value: supportLevel === "slack" ? "Slack" : "Community",
        },
        includedUsage: {
          name: "Included compute",
          description: "Monthly included compute credits",
          enabled: includedUsage !== null && includedUsage > 0,
          value: includedUsage ?? 0,
        },
      },
      planName: currentPlan?.v3Subscription?.plan?.title ?? null,
      organizationId,
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

/**
 * Query the current remaining tokens for a rate limiter using the Upstash getRemaining method.
 * This uses the same configuration and hashing logic as the rate limit middleware.
 */
async function getRateLimitRemainingTokens(
  keyPrefix: string,
  apiKey: string,
  config: RateLimiterConfig
): Promise<number | null> {
  try {
    // Hash the authorization header the same way the rate limiter does
    const authorizationValue = `Bearer ${apiKey}`;
    const hash = createHash("sha256");
    hash.update(authorizationValue);
    const hashedKey = hash.digest("hex");

    // Create a Ratelimit instance with the same configuration
    const limiter = createLimiterFromConfig(config);
    const ratelimit = new Ratelimit({
      redis: rateLimitRedisClient,
      limiter,
      ephemeralCache: new Map(),
      analytics: false,
      prefix: `ratelimit:${keyPrefix}`,
    });

    // Use the getRemaining method to get the current remaining tokens
    // getRemaining returns a Promise<number>
    const remaining = await ratelimit.getRemaining(hashedKey);
    return remaining;
  } catch (error) {
    logger.warn("Failed to get rate limit remaining tokens", {
      keyPrefix,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Query the current remaining tokens for the batch rate limiter.
 * The batch rate limiter uses environment ID directly (not hashed) and has a different key prefix.
 */
async function getBatchRateLimitRemainingTokens(
  environmentId: string,
  config: RateLimiterConfig
): Promise<number | null> {
  try {
    // Create a Ratelimit instance with the same configuration as the batch rate limiter
    const limiter = createLimiterFromConfig(config);
    const ratelimit = new Ratelimit({
      redis: rateLimitRedisClient,
      limiter,
      ephemeralCache: new Map(),
      analytics: false,
      // The batch rate limiter uses "ratelimit:batch" as keyPrefix in RateLimiter,
      // which adds another "ratelimit:" prefix, resulting in "ratelimit:ratelimit:batch"
      prefix: `ratelimit:ratelimit:batch`,
    });

    // Batch rate limiter uses environment ID directly (not hashed)
    const remaining = await ratelimit.getRemaining(environmentId);
    return remaining;
  } catch (error) {
    logger.warn("Failed to get batch rate limit remaining tokens", {
      environmentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
