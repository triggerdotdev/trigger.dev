import { env } from "~/env.server";
import { eventRepository } from "./eventRepository.server";
import { type IEventRepository, type TraceEventOptions } from "./eventRepository.types";
import { prisma } from "~/db.server";
import { runStore } from "../runStore.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { logger } from "~/services/logger.server";
import { flag } from "../featureFlags.server";
import { getTaskEventStore } from "../taskEventStore.server";
import { resolveEventStore } from "./resolveEventStore.server";
import { LEGACY_FLAG_STORE_WARNING } from "./effectiveEventStore";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";

export const EVENT_STORE_TYPES = {
  POSTGRES: "postgres",
  CLICKHOUSE: "clickhouse",
  CLICKHOUSE_V2: "clickhouse_v2",
} as const;

export type EventStoreType = (typeof EVENT_STORE_TYPES)[keyof typeof EVENT_STORE_TYPES];

let legacyFlagStoreWarned = false;

function warnLegacyFlagStore() {
  if (legacyFlagStoreWarned) {
    return;
  }

  legacyFlagStoreWarned = true;
  logger.warn(LEGACY_FLAG_STORE_WARNING);
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

  // Org override, then the global flag, then EVENT_REPOSITORY_DEFAULT_STORE
  const taskEventStore = await resolveEventStore({
    featureFlags: (organization.featureFlags as Record<string, unknown> | null) ?? undefined,
    flag,
    defaultStore: env.EVENT_REPOSITORY_DEFAULT_STORE,
    v1RerouteEnabled: env.EVENT_REPOSITORY_V1_REROUTE_ENABLED,
    onLegacyFlagStore: warnLegacyFlagStore,
  });

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
  // New runs store the effective value, so the legacy v1 store stops spreading through old trees
  const taskEventStore = await resolveEventStore({
    parentStore,
    featureFlags,
    flag,
    defaultStore: env.EVENT_REPOSITORY_DEFAULT_STORE,
    v1RerouteEnabled: env.EVENT_REPOSITORY_V1_REROUTE_ENABLED,
    onLegacyFlagStore: warnLegacyFlagStore,
  });

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
  const foundRun = await runStore.findRun(
    {
      id: runId,
    },
    {
      select: {
        friendlyId: true,
        taskIdentifier: true,
        traceContext: true,
        taskEventStore: true,
        runtimeEnvironmentId: true,
      },
    },
    prisma
  );

  if (!foundRun) {
    return null;
  }

  const environment = await controlPlaneResolver.resolveAuthenticatedEnv(
    foundRun.runtimeEnvironmentId
  );

  if (!environment) {
    // Run exists but its environment could not be resolved (e.g. a lagging replica
    // under split); distinguish this from a genuinely missing run.
    logger.warn("Run found but environment unresolved for event creation", {
      runId,
      runtimeEnvironmentId: foundRun.runtimeEnvironmentId,
    });
    return null;
  }

  return { ...foundRun, runtimeEnvironment: environment };
}
