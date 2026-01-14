import { createHash } from "node:crypto";
import { env } from "~/env.server";
import { createRedisClient } from "~/redis.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import {
  RateLimiterConfig,
  type RateLimitTokenBucketConfig,
} from "~/services/authorizationRateLimitMiddleware.server";
import type { Duration } from "~/services/rateLimiter.server";
import { BasePresenter } from "./basePresenter.server";
import { singleton } from "~/utils/singleton";
import { logger } from "~/services/logger.server";

// Create a singleton Redis client for rate limit queries
const rateLimitRedis = singleton("rateLimitQueryRedis", () =>
  createRedisClient("trigger:rateLimitQuery", {
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
    devQueueSize: QuotaInfo;
    deployedQueueSize: QuotaInfo;
  };
  batchConcurrency: {
    limit: number;
    source: "default" | "override";
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
    userId,
    projectId,
    organizationId,
    environmentApiKey,
  }: {
    userId: string;
    projectId: string;
    organizationId: string;
    environmentApiKey: string;
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

    // Get alert channel count for this org
    const alertChannelCount = await this._replica.projectAlertChannel.count({
      where: {
        project: {
          organizationId,
        },
      },
    });

    // Get active branches count for this org
    const activeBranchCount = await this._replica.runtimeEnvironment.count({
      where: {
        project: {
          organizationId,
        },
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
    const batchRateLimitTokens = await getRateLimitRemainingTokens(
      "batch",
      environmentApiKey,
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
                description: "Maximum number of schedules across all projects",
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
                description: "Maximum number of alert channels across all projects",
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
                description: "Maximum number of active preview branches",
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
      batchConcurrency: {
        limit: batchConcurrencyConfig.processingConcurrency,
        source: batchConcurrencySource,
      },
      features: {
        hasStagingEnvironment: {
          name: "Staging environment",
          description: "Access to staging environment for testing before production",
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
 * Query Redis for the current remaining tokens for a rate limiter.
 * The @upstash/ratelimit library stores token bucket state in Redis.
 * Key format: ratelimit:{prefix}:{hashedIdentifier}
 *
 * For token bucket, the value is stored as: "tokens:lastRefillTime"
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

    const redis = rateLimitRedis;
    const redisKey = `ratelimit:${keyPrefix}:${hashedKey}`;

    // Get the stored value from Redis
    const value = await redis.get(redisKey);

    if (!value) {
      // No rate limit data yet - return max tokens (bucket is full)
      if (config.type === "tokenBucket") {
        return config.maxTokens;
      } else if (config.type === "fixedWindow" || config.type === "slidingWindow") {
        return config.tokens;
      }
      return null;
    }

    // For token bucket, the @upstash/ratelimit library stores: "tokens:timestamp"
    // Parse the value to get remaining tokens
    if (typeof value === "string") {
      const parts = value.split(":");
      if (parts.length >= 1) {
        const tokens = parseInt(parts[0], 10);
        if (!isNaN(tokens)) {
          // For token bucket, we need to calculate current tokens based on refill
          if (config.type === "tokenBucket" && parts.length >= 2) {
            const lastRefillTime = parseInt(parts[1], 10);
            if (!isNaN(lastRefillTime)) {
              const now = Date.now();
              const elapsed = now - lastRefillTime;
              const intervalMs = durationToMs(config.interval);
              const tokensToAdd = Math.floor(elapsed / intervalMs) * config.refillRate;
              const currentTokens = Math.min(tokens + tokensToAdd, config.maxTokens);
              return Math.max(0, currentTokens);
            }
          }
          return Math.max(0, tokens);
        }
      }
    }

    return null;
  } catch (error) {
    logger.warn("Failed to get rate limit remaining tokens", {
      keyPrefix,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Convert a duration string (e.g., "1s", "10s", "1m") to milliseconds
 */
function durationToMs(duration: Duration): number {
  const match = duration.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return 1000; // default to 1 second

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      return 1000;
  }
}
