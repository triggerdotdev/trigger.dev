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
 * - Organization data store overrides live in the `OrganizationDataStore` table
 * - The config JSON stores a `secretKey` that references the SecretStore entry
 * - No plaintext credentials in database
 *
 * ### Caching Strategy
 * - **Org → data store mapping**: `OrganizationDataStoresRegistry` (in-memory Map, reloaded
 *   periodically via setInterval)
 * - **ClickHouse clients**: cached by hostname hash (multiple orgs share same instance)
 * - **Event repositories**: cached by hostname hash (stateful, must be reused)
 *
 * ## Usage in Presenters
 *
 * ```typescript
 * import { getClickhouseForOrganization } from "~/services/clickhouse/clickhouseFactory.server";
 *
 * export class MyPresenter extends BasePresenter {
 *   async call({ organizationId, ... }) {
 *     const clickhouse = await getClickhouseForOrganization(organizationId, "standard");
 *   }
 * }
 * ```
 *
 * @module clickhouseFactory
 */

import { ClickHouse } from "@internal/clickhouse";
import { createHash } from "crypto";
import { ClickhouseEventRepository } from "~/v3/eventRepository/clickhouseEventRepository.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { organizationDataStoresRegistry } from "~/services/dataStores/organizationDataStoresRegistryInstance.server";
import type { OrganizationDataStoresRegistry } from "~/services/dataStores/organizationDataStoresRegistry.server";

// ---------------------------------------------------------------------------
// Default clients (singleton per process)
// ---------------------------------------------------------------------------

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
    compression: { request: true },
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
    compression: { request: true },
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
    compression: { request: true },
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
    compression: { request: true },
    maxOpenConnections: env.CLICKHOUSE_MAX_OPEN_CONNECTIONS,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashHostname(url: string): string {
  const parsed = new URL(url);
  return createHash("sha256").update(parsed.hostname).digest("hex");
}

export type ClientType = "standard" | "events" | "replication" | "logs" | "query" | "admin";

function buildOrgClickhouseClient(url: string, clientType: ClientType): ClickHouse {
  const parsed = new URL(url);
  parsed.searchParams.delete("secure");

  return new ClickHouse({
    url: parsed.toString(),
    name: `org-clickhouse-${clientType}`,
    keepAlive: {
      enabled: env.CLICKHOUSE_KEEP_ALIVE_ENABLED === "1",
      idleSocketTtl: env.CLICKHOUSE_KEEP_ALIVE_IDLE_SOCKET_TTL_MS,
    },
    logLevel: env.CLICKHOUSE_LOG_LEVEL,
    compression: { request: true },
    maxOpenConnections: env.CLICKHOUSE_MAX_OPEN_CONNECTIONS,
  });
}

// ---------------------------------------------------------------------------
// Factory class (injectable for testing)
// ---------------------------------------------------------------------------

export class ClickhouseFactory {
  /** ClickHouse clients keyed by hostname hash + clientType. */
  private readonly _clientCache = new Map<string, ClickHouse>();
  /** Event repositories keyed by hostname hash (stateful, must be reused). */
  private readonly _eventRepositoryCache = new Map<string, ClickhouseEventRepository>();

  constructor(private readonly _registry: OrganizationDataStoresRegistry) {}

  async getClickhouseForOrganization(
    organizationId: string,
    clientType: ClientType
  ): Promise<ClickHouse> {
    if (!this._registry.isLoaded) {
      await this._registry.isReady;
    }

    const dataStore = this._registry.get(organizationId, "CLICKHOUSE");

    if (!dataStore) {
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

    const hostnameHash = hashHostname(dataStore.url);
    const cacheKey = `${hostnameHash}:${clientType}`;
    let client = this._clientCache.get(cacheKey);

    if (!client) {
      client = buildOrgClickhouseClient(dataStore.url, clientType);
      this._clientCache.set(cacheKey, client);
    }

    return client;
  }

  async getEventRepositoryForOrganization(
    organizationId: string
  ): Promise<ClickhouseEventRepository> {
    if (!this._registry.isLoaded) {
      await this._registry.isReady;
    }

    const dataStore = this._registry.get(organizationId, "CLICKHOUSE");

    if (!dataStore) {
      const defaultKey = "default:events";
      let defaultRepo = this._eventRepositoryCache.get(defaultKey);
      if (!defaultRepo) {
        const eventsClickhouse = await getEventsClickhouseClient();
        defaultRepo = buildEventRepository(eventsClickhouse);
        this._eventRepositoryCache.set(defaultKey, defaultRepo);
      }
      return defaultRepo;
    }

    const hostnameHash = hashHostname(dataStore.url);
    const cacheKey = `${hostnameHash}:events`;
    let repository = this._eventRepositoryCache.get(cacheKey);

    if (!repository) {
      const client = await this.getClickhouseForOrganization(organizationId, "events");
      repository = buildEventRepository(client);
      this._eventRepositoryCache.set(cacheKey, repository);
    }

    return repository;
  }
}

// ---------------------------------------------------------------------------
// Singleton factory instance
// ---------------------------------------------------------------------------

const clickhouseFactory = singleton(
  "clickhouseFactory",
  () => new ClickhouseFactory(organizationDataStoresRegistry)
);

// ---------------------------------------------------------------------------
// Public API (thin wrappers around the singleton)
// ---------------------------------------------------------------------------

export async function getClickhouseForOrganization(
  organizationId: string,
  clientType: ClientType
): Promise<ClickHouse> {
  return clickhouseFactory.getClickhouseForOrganization(organizationId, clientType);
}

export async function getEventRepositoryForOrganization(
  organizationId: string
): Promise<ClickhouseEventRepository> {
  return clickhouseFactory.getEventRepositoryForOrganization(organizationId);
}

/**
 * Get admin ClickHouse client for cross-organization queries.
 * Only use for admin tools and analytics that need to query across all orgs.
 */
export function getAdminClickhouse(): ClickHouse {
  return defaultAdminClickhouseClient;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

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
    compression: { request: env.EVENTS_CLICKHOUSE_COMPRESSION_REQUEST === "1" },
    maxOpenConnections: env.EVENTS_CLICKHOUSE_MAX_OPEN_CONNECTIONS,
  });
}

function buildEventRepository(clickhouse: ClickHouse): ClickhouseEventRepository {
  return new ClickhouseEventRepository({
    clickhouse,
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
}
