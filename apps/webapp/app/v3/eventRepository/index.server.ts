import { env } from "~/env.server";
import { eventRepository } from "./eventRepository.server";
import { type IEventRepository, type TraceEventOptions } from "./eventRepository.types";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { FEATURE_FLAG } from "../featureFlags";
import { flag } from "../featureFlags.server";
import { getTaskEventStore } from "../taskEventStore.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";

export const EVENT_STORE_TYPES = {
  POSTGRES: "postgres",
  CLICKHOUSE: "clickhouse",
  CLICKHOUSE_V2: "clickhouse_v2",
} as const;

export type EventStoreType = (typeof EVENT_STORE_TYPES)[keyof typeof EVENT_STORE_TYPES];

/**
 * Resolve the event repository for a run's persisted `taskEventStore` value and org.
 * Postgres-backed runs use the Prisma `eventRepository`; ClickHouse-backed runs use
 * `clickhouseFactory.getEventRepositoryForOrganizationSync`.
 */
export function resolveEventRepositoryForStore(
  store: string,
  organizationId: string
): IEventRepository {
  if (store === EVENT_STORE_TYPES.CLICKHOUSE || store === EVENT_STORE_TYPES.CLICKHOUSE_V2) {
    return clickhouseFactory.getEventRepositoryForOrganizationSync(store, organizationId)
      .repository;
  }
  return eventRepository;
}

/**
 * Async variant of {@link resolveEventRepositoryForStore}. Awaits the factory's
 * registry readiness before returning the ClickHouse event repository; for
 * non-ClickHouse stores (e.g. the "taskEvent" DB default for Postgres-backed
 * runs) it returns the Prisma event repository without ever touching the
 * factory — so the factory never needs to know about Postgres.
 */
export async function getEventRepositoryForStore(
  store: string,
  organizationId: string
): Promise<IEventRepository> {
  if (store !== EVENT_STORE_TYPES.CLICKHOUSE && store !== EVENT_STORE_TYPES.CLICKHOUSE_V2) {
    return eventRepository;
  }
  const { repository } = await clickhouseFactory.getEventRepositoryForOrganization(
    store,
    organizationId
  );
  return repository;
}

export async function getConfiguredEventRepository(
  organizationId: string
): Promise<{ repository: IEventRepository; store: EventStoreType }> {
  const organization = await prisma.organization.findFirst({
    select: {
      id: true,
      featureFlags: true,
    },
    where: {
      id: organizationId,
    },
  });

  if (!organization) {
    throw new Error("Organization not found when configuring event repository");
  }

  // resolveTaskEventRepositoryFlag checks:
  // 1. organization.featureFlags (highest priority)
  // 2. global feature flags (via flags() function)
  // 3. env.EVENT_REPOSITORY_DEFAULT_STORE (fallback)
  const taskEventStore = await resolveTaskEventRepositoryFlag(
    (organization.featureFlags as Record<string, unknown> | null) ?? undefined
  );

  if (taskEventStore === EVENT_STORE_TYPES.CLICKHOUSE_V2) {
    const { repository: resolvedRepository } =
      await clickhouseFactory.getEventRepositoryForOrganization(taskEventStore, organizationId);
    return { repository: resolvedRepository, store: EVENT_STORE_TYPES.CLICKHOUSE_V2 };
  }

  if (taskEventStore === EVENT_STORE_TYPES.CLICKHOUSE) {
    const { repository: resolvedRepository } =
      await clickhouseFactory.getEventRepositoryForOrganization(taskEventStore, organizationId);
    return { repository: resolvedRepository, store: EVENT_STORE_TYPES.CLICKHOUSE };
  }

  return { repository: eventRepository, store: EVENT_STORE_TYPES.POSTGRES };
}

export async function getEventRepository(
  organizationId: string,
  featureFlags: Record<string, unknown> | undefined,
  parentStore: string | undefined
): Promise<{ repository: IEventRepository; store: string }> {
  const taskEventStore = parentStore ?? (await resolveTaskEventRepositoryFlag(featureFlags));

  // Non-ClickHouse stores (e.g. the "taskEvent" DB default for Postgres-backed
  // runs, or the legacy "postgres" value) resolve to the Prisma event repo.
  if (
    taskEventStore !== EVENT_STORE_TYPES.CLICKHOUSE &&
    taskEventStore !== EVENT_STORE_TYPES.CLICKHOUSE_V2
  ) {
    return { repository: eventRepository, store: getTaskEventStore() };
  }

  const { repository: resolvedRepository } =
    await clickhouseFactory.getEventRepositoryForOrganization(taskEventStore, organizationId);

  switch (taskEventStore) {
    case EVENT_STORE_TYPES.CLICKHOUSE_V2: {
      return { repository: resolvedRepository, store: EVENT_STORE_TYPES.CLICKHOUSE_V2 };
    }
    case EVENT_STORE_TYPES.CLICKHOUSE: {
      return { repository: resolvedRepository, store: EVENT_STORE_TYPES.CLICKHOUSE };
    }
    default: {
      return { repository: eventRepository, store: getTaskEventStore() };
    }
  }
}

export async function getV3EventRepository(
  organizationId: string,
  parentStore: string | undefined
): Promise<{ repository: IEventRepository; store: string }> {
  if (typeof parentStore === "string") {
    // Support legacy Postgres store for self-hosters and runs persisted with a
    // non-ClickHouse store — fall back to the Prisma-based event repository.
    if (
      parentStore !== EVENT_STORE_TYPES.CLICKHOUSE &&
      parentStore !== EVENT_STORE_TYPES.CLICKHOUSE_V2
    ) {
      return { repository: eventRepository, store: parentStore };
    }

    const { repository: resolvedRepository } =
      await clickhouseFactory.getEventRepositoryForOrganization(parentStore, organizationId);
    return { repository: resolvedRepository, store: parentStore };
  }

  if (env.EVENT_REPOSITORY_DEFAULT_STORE === "clickhouse_v2") {
    const { repository: resolvedRepository } =
      await clickhouseFactory.getEventRepositoryForOrganization("clickhouse_v2", organizationId);
    return { repository: resolvedRepository, store: "clickhouse_v2" };
  } else if (env.EVENT_REPOSITORY_DEFAULT_STORE === "clickhouse") {
    const { repository: resolvedRepository } =
      await clickhouseFactory.getEventRepositoryForOrganization("clickhouse", organizationId);
    return { repository: resolvedRepository, store: "clickhouse" };
  } else {
    return { repository: eventRepository, store: getTaskEventStore() };
  }
}

async function resolveTaskEventRepositoryFlag(
  featureFlags: Record<string, unknown> | undefined
): Promise<"clickhouse" | "clickhouse_v2" | "postgres"> {
  const flagResult = await flag({
    key: FEATURE_FLAG.taskEventRepository,
    defaultValue: env.EVENT_REPOSITORY_DEFAULT_STORE,
    overrides: featureFlags,
  });

  if (flagResult === "clickhouse_v2") {
    return "clickhouse_v2";
  }

  if (flagResult === "clickhouse") {
    return "clickhouse";
  }

  return flagResult;
}

export async function recordRunDebugLog(
  runId: string,
  message: string,
  options: Omit<TraceEventOptions, "environment" | "taskSlug" | "startTime"> & {
    duration?: number;
    parentId?: string;
    startTime?: Date;
  }
): Promise<
  | {
      success: true;
    }
  | {
      success: false;
      code: "RUN_NOT_FOUND" | "FAILED_TO_RECORD_EVENT";
      error?: unknown;
    }
> {
  if (env.EVENT_REPOSITORY_DEBUG_LOGS_DISABLED) {
    // drop debug events silently
    return {
      success: true,
    };
  }

  return recordRunEvent(runId, message, {
    ...options,
    attributes: {
      ...options?.attributes,
      isDebug: true,
    },
  });
}

async function recordRunEvent(
  runId: string,
  message: string,
  options: Omit<TraceEventOptions, "environment" | "taskSlug" | "startTime"> & {
    duration?: number;
    parentId?: string;
    startTime?: Date;
  }
): Promise<
  | {
      success: true;
    }
  | {
      success: false;
      code: "RUN_NOT_FOUND" | "FAILED_TO_RECORD_EVENT";
      error?: unknown;
    }
> {
  try {
    const foundRun = await findRunForEventCreation(runId);

    if (!foundRun) {
      logger.error("Failed to find run for event creation", { runId });
      return {
        success: false,
        code: "RUN_NOT_FOUND",
      };
    }

    const $eventRepository = await getEventRepositoryForStore(
      foundRun.taskEventStore,
      foundRun.runtimeEnvironment.organizationId
    );

    const { attributes, startTime, ...optionsRest } = options;

    await $eventRepository.recordEvent(message, {
      environment: foundRun.runtimeEnvironment,
      taskSlug: foundRun.taskIdentifier,
      context: foundRun.traceContext as Record<string, string | undefined>,
      attributes: {
        runId: foundRun.friendlyId,
        ...attributes,
      },
      startTime: BigInt((startTime?.getTime() ?? Date.now()) * 1_000_000),
      ...optionsRest,
    });

    return {
      success: true,
    };
  } catch (error) {
    logger.error("Failed to record event for run", {
      error: error instanceof Error ? error.message : error,
      runId,
    });

    return {
      success: false,
      code: "FAILED_TO_RECORD_EVENT",
      error,
    };
  }
}

async function findRunForEventCreation(runId: string) {
  return prisma.taskRun.findFirst({
    where: {
      id: runId,
    },
    select: {
      friendlyId: true,
      taskIdentifier: true,
      traceContext: true,
      taskEventStore: true,
      runtimeEnvironment: {
        select: {
          id: true,
          type: true,
          organizationId: true,
          projectId: true,
          project: {
            select: {
              externalRef: true,
            },
          },
        },
      },
    },
  });
}
