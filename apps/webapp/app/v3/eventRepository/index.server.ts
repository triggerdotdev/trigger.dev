import { env } from "~/env.server";
import { eventRepository } from "./eventRepository.server";
import {
  clickhouseEventRepository,
  clickhouseEventRepositoryV2,
} from "./clickhouseEventRepositoryInstance.server";
import { IEventRepository, TraceEventOptions } from "./eventRepository.types";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { FEATURE_FLAG, flag } from "../featureFlags.server";
import { getTaskEventStore } from "../taskEventStore.server";

export function resolveEventRepositoryForStore(store: string | undefined): IEventRepository {
  const taskEventStore = store ?? env.EVENT_REPOSITORY_DEFAULT_STORE;

  if (taskEventStore === "clickhouse_v2") {
    return clickhouseEventRepositoryV2;
  }

  if (taskEventStore === "clickhouse") {
    return clickhouseEventRepository;
  }

  return eventRepository;
}

export const EVENT_STORE_TYPES = {
  POSTGRES: "postgres",
  CLICKHOUSE: "clickhouse",
  CLICKHOUSE_V2: "clickhouse_v2",
} as const;

export type EventStoreType = (typeof EVENT_STORE_TYPES)[keyof typeof EVENT_STORE_TYPES];

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
    return { repository: clickhouseEventRepositoryV2, store: EVENT_STORE_TYPES.CLICKHOUSE_V2 };
  }

  if (taskEventStore === EVENT_STORE_TYPES.CLICKHOUSE) {
    return { repository: clickhouseEventRepository, store: EVENT_STORE_TYPES.CLICKHOUSE };
  }

  return { repository: eventRepository, store: EVENT_STORE_TYPES.POSTGRES };
}

export async function getEventRepository(
  featureFlags: Record<string, unknown> | undefined,
  parentStore: string | undefined
): Promise<{ repository: IEventRepository; store: string }> {
  if (typeof parentStore === "string") {
    if (parentStore === "clickhouse_v2") {
      return { repository: clickhouseEventRepositoryV2, store: "clickhouse_v2" };
    }
    if (parentStore === "clickhouse") {
      return { repository: clickhouseEventRepository, store: "clickhouse" };
    } else {
      return { repository: eventRepository, store: getTaskEventStore() };
    }
  }

  const taskEventRepository = await resolveTaskEventRepositoryFlag(featureFlags);

  if (taskEventRepository === "clickhouse_v2") {
    return { repository: clickhouseEventRepositoryV2, store: "clickhouse_v2" };
  }

  if (taskEventRepository === "clickhouse") {
    return { repository: clickhouseEventRepository, store: "clickhouse" };
  }

  return { repository: eventRepository, store: getTaskEventStore() };
}

export async function getV3EventRepository(
  parentStore: string | undefined
): Promise<{ repository: IEventRepository; store: string }> {
  if (typeof parentStore === "string") {
    if (parentStore === "clickhouse_v2") {
      return { repository: clickhouseEventRepositoryV2, store: "clickhouse_v2" };
    }
    if (parentStore === "clickhouse") {
      return { repository: clickhouseEventRepository, store: "clickhouse" };
    } else {
      return { repository: eventRepository, store: getTaskEventStore() };
    }
  }

  if (env.EVENT_REPOSITORY_DEFAULT_STORE === "clickhouse_v2") {
    return { repository: clickhouseEventRepositoryV2, store: "clickhouse_v2" };
  } else if (env.EVENT_REPOSITORY_DEFAULT_STORE === "clickhouse") {
    return { repository: clickhouseEventRepository, store: "clickhouse" };
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

    const $eventRepository = resolveEventRepositoryForStore(foundRun.taskEventStore);

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
