import { env } from "~/env.server";
import { eventRepository } from "./eventRepository.server";
import { clickhouseEventRepository } from "./clickhouseEventRepositoryInstance.server";
import { IEventRepository, TraceEventOptions } from "./eventRepository.types";
import { $replica } from "~/db.server";
import { logger } from "~/services/logger.server";
import { FEATURE_FLAG, flags } from "../featureFlags.server";
import { getTaskEventStore } from "../taskEventStore.server";

export function resolveEventRepositoryForStore(store: string | undefined): IEventRepository {
  const taskEventStore = store ?? env.EVENT_REPOSITORY_DEFAULT_STORE;

  if (taskEventStore === "clickhouse") {
    return clickhouseEventRepository;
  }

  return eventRepository;
}

export async function getEventRepository(
  featureFlags: Record<string, unknown> | undefined,
  parentStore: string | undefined
): Promise<{ repository: IEventRepository; store: string }> {
  if (typeof parentStore === "string") {
    if (parentStore === "clickhouse") {
      return { repository: clickhouseEventRepository, store: "clickhouse" };
    } else {
      return { repository: eventRepository, store: getTaskEventStore() };
    }
  }

  const taskEventRepository = await resolveTaskEventRepositoryFlag(featureFlags);

  if (taskEventRepository === "clickhouse") {
    return { repository: clickhouseEventRepository, store: "clickhouse" };
  }

  return { repository: eventRepository, store: getTaskEventStore() };
}

async function resolveTaskEventRepositoryFlag(
  featureFlags: Record<string, unknown> | undefined
): Promise<"clickhouse" | "postgres"> {
  const flag = await flags({
    key: FEATURE_FLAG.taskEventRepository,
    defaultValue: env.EVENT_REPOSITORY_DEFAULT_STORE,
    overrides: featureFlags,
  });

  if (flag === "clickhouse") {
    return "clickhouse";
  }

  if (env.EVENT_REPOSITORY_CLICKHOUSE_ROLLOUT_PERCENT) {
    const rolloutPercent = env.EVENT_REPOSITORY_CLICKHOUSE_ROLLOUT_PERCENT;

    const randomNumber = Math.random();

    if (randomNumber < rolloutPercent) {
      return "clickhouse";
    }
  }

  return flag;
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
  return $replica.taskRun.findFirst({
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
