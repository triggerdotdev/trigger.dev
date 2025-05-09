import { TriggerTaskRequestBody } from "@trigger.dev/core/v3";
import { RunEngineVersion, TaskRun } from "@trigger.dev/database";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultPayloadProcessor } from "~/runEngine/concerns/payloads.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import { DefaultRunNumberIncrementer } from "~/runEngine/concerns/runNumbers.server";
import { RunEngineTriggerTaskService } from "~/runEngine/services/triggerTask.server";
import { DefaultTriggerTaskValidator } from "~/runEngine/validators/triggerTaskValidator";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { determineEngineVersion } from "../engineVersion.server";
import { eventRepository } from "../eventRepository.server";
import { tracer } from "../tracer.server";
import { WithRunEngine } from "./baseService.server";
import { TriggerTaskServiceV1 } from "./triggerTaskV1.server";
import { DefaultTraceEventsConcern } from "~/runEngine/concerns/traceEvents.server";
import { DefaultRunChainStateManager } from "~/runEngine/concerns/runChainStates.server";
import { env } from "~/env.server";

export type TriggerTaskServiceOptions = {
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
  spanParentAsLink?: boolean;
  parentAsLinkType?: "replay" | "trigger";
  batchId?: string;
  batchIndex?: number;
  customIcon?: string;
  runFriendlyId?: string;
  skipChecks?: boolean;
  oneTimeUseToken?: string;
  scheduleId?: string;
  scheduleInstanceId?: string;
};

export class OutOfEntitlementError extends Error {
  constructor() {
    super("You can't trigger a task because you have run out of credits.");
  }
}

export type TriggerTaskServiceResult = {
  run: TaskRun;
  isCached: boolean;
};

export const MAX_ATTEMPTS = 2;

export class TriggerTaskService extends WithRunEngine {
  public async call(
    taskId: string,
    environment: AuthenticatedEnvironment,
    body: TriggerTaskRequestBody,
    options: TriggerTaskServiceOptions = {},
    version?: RunEngineVersion
  ): Promise<TriggerTaskServiceResult | undefined> {
    return await this.traceWithEnv("call()", environment, async (span) => {
      span.setAttribute("taskId", taskId);

      const v = await determineEngineVersion({
        environment,
        workerVersion: body.options?.lockToVersion,
        engineVersion: version,
      });

      switch (v) {
        case "V1": {
          return await this.callV1(taskId, environment, body, options);
        }
        case "V2": {
          return await this.callV2(taskId, environment, body, options);
        }
      }
    });
  }

  private async callV1(
    taskId: string,
    environment: AuthenticatedEnvironment,
    body: TriggerTaskRequestBody,
    options: TriggerTaskServiceOptions = {}
  ): Promise<TriggerTaskServiceResult | undefined> {
    const service = new TriggerTaskServiceV1(this._prisma);
    return await service.call(taskId, environment, body, options);
  }

  private async callV2(
    taskId: string,
    environment: AuthenticatedEnvironment,
    body: TriggerTaskRequestBody,
    options: TriggerTaskServiceOptions = {}
  ): Promise<TriggerTaskServiceResult | undefined> {
    const traceEventConcern = new DefaultTraceEventsConcern(eventRepository);

    const service = new RunEngineTriggerTaskService({
      prisma: this._prisma,
      engine: this._engine,
      queueConcern: new DefaultQueueManager(this._prisma, this._engine),
      validator: new DefaultTriggerTaskValidator(),
      payloadProcessor: new DefaultPayloadProcessor(),
      idempotencyKeyConcern: new IdempotencyKeyConcern(
        this._prisma,
        this._engine,
        traceEventConcern
      ),
      runNumberIncrementer: new DefaultRunNumberIncrementer(),
      traceEventConcern,
      runChainStateManager: new DefaultRunChainStateManager(
        this._prisma,
        env.RUN_ENGINE_RELEASE_CONCURRENCY_ENABLED === "1"
      ),
      tracer: tracer,
    });
    return await service.call({
      taskId,
      environment,
      body,
      options,
    });
  }
}
