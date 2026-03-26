/**
 * ClickHouse Factory - Organization-Scoped ClickHouse Routing
 *
 * This module provides organization-scoped ClickHouse instance routing to support:
 * - HIPAA compliance (dedicated ClickHouse clusters)
 * - High-volume customer isolation
 * - Geographic data residency requirements
 * - Performance tier differentiation
 *
 * ## Architecture
 *
 * ### Credential Storage
 * - ClickHouse URLs stored encrypted in SecretStore (AES-256-GCM)
 * - Organization references secret via `featureFlags.clickhouse` JSON
 * - No plaintext credentials in database
 *
 * ### Caching Strategy
 * - **Org configs**: Unkey cache with LRU memory (5min fresh, 10min stale, SWR)
 * - **ClickHouse clients**: Cached by hostname hash (multiple orgs share same instance)
 * - **Event repositories**: Cached by hostname hash (stateful, must be reused)
 * - **Security**: Memory-only cache for org configs (no credentials in Redis)
 *
 * ## Usage in Presenters
 *
 * Presenters should fetch org-specific ClickHouse clients in their `call()` method:
 *
 * ```typescript
 * import { getClickhouseForOrganization } from "~/services/clickhouse/clickhouseFactory.server";
 *
 * export class MyPresenter extends BasePresenter {
 *   constructor(private options: PresenterOptions = {}) {
 *     super();
 *   }
 *
 *   async call({ organizationId, ... }) {
 *     const clickhouse = await getClickhouseForOrganization(organizationId, "standard");
 *     // Use clickhouse for queries...
 *   }
 * }
 * ```
 *
 * ## Usage in Services
 *
 * The replication service and OTLP exporter automatically route data by organization.
 * Other services should follow the same pattern when working with ClickHouse.
 *
 * @module clickhouseFactory
 */

import { ClickHouse } from "@internal/clickhouse";
import { createHash } from "crypto";
import { createCache, DefaultStatefulContext, Namespace } from "@unkey/cache";
import { createLRUMemoryStore } from "@internal/cache";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { prisma } from "~/db.server";
import {
  ClickhouseConnectionSchema,
  getClickhouseSecretKey,
} from "./clickhouseSecretSchemas.server";
import { ClickhouseEventRepository } from "~/v3/eventRepository/clickhouseEventRepository.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";

// Module-level caches for ClickHouse clients and event repositories
const clickhouseClientCache = new Map<string, ClickHouse>();
const eventRepositoryCache = new Map<string, ClickhouseEventRepository>();

// Default ClickHouse clients (not exported - internal use only)
const defaultClickhouseClient = singleton("clickhouseClient", initializeClickhouseClient);

function initializeClickhouseClient() {
  const url = new URL(env.CLICKHOUSE_URL);
  url.searchParams.delete("secure");

  console.log(`🗃️  Clickhouse service enabled to host ${url.host}`);

  return new ClickHouse({
    url: url.toString(),
    name: "clickhouse-instance",
    keepAlive: {
      enabled: env.CLICKHOUSE_KEEP_ALIVE_ENABLED === "1",
      idleSocketTtl: env.CLICKHOUSE_KEEP_ALIVE_IDLE_SOCKET_TTL_MS,
    },
    logLevel: env.CLICKHOUSE_LOG_LEVEL,
    compression: {
      request: true,
    },
    maxOpenConnections: env.CLICKHOUSE_MAX_OPEN_CONNECTIONS,
  });
}

const defaultLogsClickhouseClient = singleton(
  "logsClickhouseClient",
  initializeLogsClickhouseClient
);

function initializeLogsClickhouseClient() {
  if (!env.LOGS_CLICKHOUSE_URL) {
    throw new Error("LOGS_CLICKHOUSE_URL is not set");
  }

  const url = new URL(env.LOGS_CLICKHOUSE_URL);
  url.searchParams.delete("secure");

  return new ClickHouse({
    url: url.toString(),
    name: "logs-clickhouse",
    keepAlive: {
      enabled: env.CLICKHOUSE_KEEP_ALIVE_ENABLED === "1",
      idleSocketTtl: env.CLICKHOUSE_KEEP_ALIVE_IDLE_SOCKET_TTL_MS,
    },
    logLevel: env.CLICKHOUSE_LOG_LEVEL,
    compression: {
      request: true,
    },
    maxOpenConnections: env.CLICKHOUSE_MAX_OPEN_CONNECTIONS,
    clickhouseSettings: {
      max_memory_usage: env.CLICKHOUSE_LOGS_LIST_MAX_MEMORY_USAGE.toString(),
      max_bytes_before_external_sort:
        env.CLICKHOUSE_LOGS_LIST_MAX_BYTES_BEFORE_EXTERNAL_SORT.toString(),
      max_threads: env.CLICKHOUSE_LOGS_LIST_MAX_THREADS,
      ...(env.CLICKHOUSE_LOGS_LIST_MAX_ROWS_TO_READ && {
        max_rows_to_read: env.CLICKHOUSE_LOGS_LIST_MAX_ROWS_TO_READ.toString(),
      }),
      ...(env.CLICKHOUSE_LOGS_LIST_MAX_EXECUTION_TIME && {
        max_execution_time: env.CLICKHOUSE_LOGS_LIST_MAX_EXECUTION_TIME,
      }),
    },
  });
}

const defaultAdminClickhouseClient = singleton(
  "adminClickhouseClient",
  initializeAdminClickhouseClient
);

function initializeAdminClickhouseClient() {
  if (!env.ADMIN_CLICKHOUSE_URL) {
    throw new Error("ADMIN_CLICKHOUSE_URL is not set");
  }

  const url = new URL(env.ADMIN_CLICKHOUSE_URL);
  url.searchParams.delete("secure");

  return new ClickHouse({
    url: url.toString(),
    name: "admin-clickhouse",
    keepAlive: {
      enabled: env.CLICKHOUSE_KEEP_ALIVE_ENABLED === "1",
      idleSocketTtl: env.CLICKHOUSE_KEEP_ALIVE_IDLE_SOCKET_TTL_MS,
    },
    logLevel: env.CLICKHOUSE_LOG_LEVEL,
    compression: {
      request: true,
    },
    maxOpenConnections: env.CLICKHOUSE_MAX_OPEN_CONNECTIONS,
  });
}

const defaultQueryClickhouseClient = singleton(
  "queryClickhouseClient",
  initializeQueryClickhouseClient
);

function initializeQueryClickhouseClient() {
  if (!env.QUERY_CLICKHOUSE_URL) {
    throw new Error("QUERY_CLICKHOUSE_URL is not set");
  }

  const url = new URL(env.QUERY_CLICKHOUSE_URL);
  url.searchParams.delete("secure");

  return new ClickHouse({
    url: url.toString(),
    name: "query-clickhouse",
    keepAlive: {
      enabled: env.CLICKHOUSE_KEEP_ALIVE_ENABLED === "1",
      idleSocketTtl: env.CLICKHOUSE_KEEP_ALIVE_IDLE_SOCKET_TTL_MS,
    },
    logLevel: env.CLICKHOUSE_LOG_LEVEL,
    compression: {
      request: true,
    },
    maxOpenConnections: env.CLICKHOUSE_MAX_OPEN_CONNECTIONS,
  });
}

// Org config cache with Unkey (memory-only, no Redis for security)
type OrgClickhouseConfig = {
  organizationId: string;
  hostnameHash: string;
  url: string;
  clientType: string;
};

const ctx = new DefaultStatefulContext();
const memory = createLRUMemoryStore(1000);

const orgConfigCache = createCache({
  orgClickhouse: new Namespace<OrgClickhouseConfig | null>(ctx, {
    stores: [memory], // Memory-only, no Redis store for security
    fresh: 5 * 60 * 1000, // 5 minutes
    stale: 10 * 60 * 1000, // 10 minutes (SWR pattern)
  }),
});

function hashHostname(url: string): string {
  const parsed = new URL(url);
  return createHash("sha256").update(parsed.hostname).digest("hex");
}

async function getOrgClickhouseConfig(
  ctx: DefaultStatefulContext,
  orgId: string,
  clientType: string
): Promise<OrgClickhouseConfig | null> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { featureFlags: true },
  });

  if (!org?.featureFlags) {
    return null;
  }

  const clickhouseConfig = (org.featureFlags as any).clickhouse;
  if (!clickhouseConfig || typeof clickhouseConfig !== "object") {
    return null;
  }

  const secretKey = clickhouseConfig[clientType];
  if (!secretKey || typeof secretKey !== "string") {
    return null;
  }

  const secretStore = getSecretStore("DATABASE");
  const connection = await secretStore.getSecret(ClickhouseConnectionSchema, secretKey);

  if (!connection) {
    return null;
  }

  const hostnameHash = hashHostname(connection.url);

  return {
    organizationId: orgId,
    hostnameHash,
    url: connection.url,
    clientType,
  };
}

export async function getClickhouseForOrganization(
  organizationId: string,
  clientType: "standard" | "events" | "replication" | "logs" | "query" | "admin"
): Promise<ClickHouse> {
  // Try to get org-specific config
  const configResult = await orgConfigCache.orgClickhouse.swr(
    `org:${organizationId}:ch:${clientType}`,
    async () => getOrgClickhouseConfig(ctx, organizationId, clientType)
  );

  // Handle Result type - check for error or null value
  const config = configResult.err ? null : configResult.val;

  // If no custom config, return appropriate default client
  if (!config) {
    switch (clientType) {
      case "standard":
      case "events":
      case "replication":
        return defaultClickhouseClient;
      case "logs":
        return defaultLogsClickhouseClient;
      case "query":
        return defaultQueryClickhouseClient;
      case "admin":
        return defaultAdminClickhouseClient;
    }
  }

  // Check if client already exists for this hostname
  const cacheKey = `${config.hostnameHash}:${clientType}`;
  let client = clickhouseClientCache.get(cacheKey);

  if (!client) {
    const url = new URL(config.url);
    url.searchParams.delete("secure");

    client = new ClickHouse({
      url: url.toString(),
      name: `org-clickhouse-${clientType}`,
      keepAlive: {
        enabled: env.CLICKHOUSE_KEEP_ALIVE_ENABLED === "1",
        idleSocketTtl: env.CLICKHOUSE_KEEP_ALIVE_IDLE_SOCKET_TTL_MS,
      },
      logLevel: env.CLICKHOUSE_LOG_LEVEL,
      compression: {
        request: true,
      },
      maxOpenConnections: env.CLICKHOUSE_MAX_OPEN_CONNECTIONS,
    });
    clickhouseClientCache.set(cacheKey, client);
  }

  return client;
}

export async function getEventRepositoryForOrganization(
  organizationId: string
): Promise<ClickhouseEventRepository> {
  // Try to get org-specific config
  const configResult = await orgConfigCache.orgClickhouse.swr(
    `org:${organizationId}:ch:events`,
    async () => getOrgClickhouseConfig(ctx, organizationId, "events")
  );

  // Handle Result type - check for error or null value
  const config = configResult.err ? null : configResult.val;

  // If no custom config, return default repository (created on demand)
  if (!config) {
    const defaultKey = "default:events";
    let defaultRepo = eventRepositoryCache.get(defaultKey);
    if (!defaultRepo) {
      // Create default event repository using standard clickhouse client
      // This matches the existing pattern in clickhouseEventRepositoryInstance.server.ts
      const eventsClickhouse = await getEventsClickhouseClient();
      defaultRepo = new ClickhouseEventRepository({
        clickhouse: eventsClickhouse,
        batchSize: env.EVENTS_CLICKHOUSE_BATCH_SIZE,
        flushInterval: env.EVENTS_CLICKHOUSE_FLUSH_INTERVAL_MS,
        maximumTraceSummaryViewCount: env.EVENTS_CLICKHOUSE_MAX_TRACE_SUMMARY_VIEW_COUNT,
        maximumTraceDetailedSummaryViewCount:
          env.EVENTS_CLICKHOUSE_MAX_TRACE_DETAILED_SUMMARY_VIEW_COUNT,
        maximumLiveReloadingSetting: env.EVENTS_CLICKHOUSE_MAX_LIVE_RELOADING_SETTING,
        insertStrategy: env.EVENTS_CLICKHOUSE_INSERT_STRATEGY,
        waitForAsyncInsert: env.EVENTS_CLICKHOUSE_WAIT_FOR_ASYNC_INSERT === "1",
        asyncInsertMaxDataSize: env.EVENTS_CLICKHOUSE_ASYNC_INSERT_MAX_DATA_SIZE,
        asyncInsertBusyTimeoutMs: env.EVENTS_CLICKHOUSE_ASYNC_INSERT_BUSY_TIMEOUT_MS,
        startTimeMaxAgeMs: env.EVENTS_CLICKHOUSE_START_TIME_MAX_AGE_MS,
        llmMetricsBatchSize: env.LLM_METRICS_BATCH_SIZE,
        llmMetricsFlushInterval: env.LLM_METRICS_FLUSH_INTERVAL_MS,
        llmMetricsMaxBatchSize: env.LLM_METRICS_MAX_BATCH_SIZE,
        llmMetricsMaxConcurrency: env.LLM_METRICS_MAX_CONCURRENCY,
        version: "v2",
      });
      eventRepositoryCache.set(defaultKey, defaultRepo);
    }
    return defaultRepo;
  }

  // Check if repository already exists for this hostname
  const cacheKey = `${config.hostnameHash}:events`;
  let repository = eventRepositoryCache.get(cacheKey);

  if (!repository) {
    const client = await getClickhouseForOrganization(organizationId, "events");
    repository = new ClickhouseEventRepository({
      clickhouse: client,
      batchSize: env.EVENTS_CLICKHOUSE_BATCH_SIZE,
      flushInterval: env.EVENTS_CLICKHOUSE_FLUSH_INTERVAL_MS,
      maximumTraceSummaryViewCount: env.EVENTS_CLICKHOUSE_MAX_TRACE_SUMMARY_VIEW_COUNT,
      maximumTraceDetailedSummaryViewCount:
        env.EVENTS_CLICKHOUSE_MAX_TRACE_DETAILED_SUMMARY_VIEW_COUNT,
      maximumLiveReloadingSetting: env.EVENTS_CLICKHOUSE_MAX_LIVE_RELOADING_SETTING,
      insertStrategy: env.EVENTS_CLICKHOUSE_INSERT_STRATEGY,
      waitForAsyncInsert: env.EVENTS_CLICKHOUSE_WAIT_FOR_ASYNC_INSERT === "1",
      asyncInsertMaxDataSize: env.EVENTS_CLICKHOUSE_ASYNC_INSERT_MAX_DATA_SIZE,
      asyncInsertBusyTimeoutMs: env.EVENTS_CLICKHOUSE_ASYNC_INSERT_BUSY_TIMEOUT_MS,
      startTimeMaxAgeMs: env.EVENTS_CLICKHOUSE_START_TIME_MAX_AGE_MS,
      llmMetricsBatchSize: env.LLM_METRICS_BATCH_SIZE,
      llmMetricsFlushInterval: env.LLM_METRICS_FLUSH_INTERVAL_MS,
      llmMetricsMaxBatchSize: env.LLM_METRICS_MAX_BATCH_SIZE,
      llmMetricsMaxConcurrency: env.LLM_METRICS_MAX_CONCURRENCY,
      version: "v2",
    });
    eventRepositoryCache.set(cacheKey, repository);
  }

  return repository;
}

// Helper to create the default events ClickHouse client
async function getEventsClickhouseClient(): Promise<ClickHouse> {
  if (!env.EVENTS_CLICKHOUSE_URL) {
    throw new Error("EVENTS_CLICKHOUSE_URL is not set");
  }

  const url = new URL(env.EVENTS_CLICKHOUSE_URL);
  url.searchParams.delete("secure");

  return new ClickHouse({
    url: url.toString(),
    name: "task-events",
    keepAlive: {
      enabled: env.EVENTS_CLICKHOUSE_KEEP_ALIVE_ENABLED === "1",
      idleSocketTtl: env.EVENTS_CLICKHOUSE_KEEP_ALIVE_IDLE_SOCKET_TTL_MS,
    },
    logLevel: env.EVENTS_CLICKHOUSE_LOG_LEVEL,
    compression: {
      request: env.EVENTS_CLICKHOUSE_COMPRESSION_REQUEST === "1",
    },
    maxOpenConnections: env.EVENTS_CLICKHOUSE_MAX_OPEN_CONNECTIONS,
  });
}

/**
 * Get admin ClickHouse client for cross-organization queries
 * This should only be used for admin tools and analytics that need to query across all orgs
 */
export function getAdminClickhouse(): ClickHouse {
  return defaultAdminClickhouseClient;
}

// Clear caches when needed (e.g., when org config changes)
export function clearClickhouseCacheForOrganization(organizationId: string): void {
  // The Unkey cache will naturally expire based on TTL (5min fresh, 10min stale)
  // No explicit removal needed - cache entries will be refreshed on next access
  // Note: We don't clear client/repository caches as they're keyed by hostname
  // and may be shared by other orgs
}
