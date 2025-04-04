import { TriggerTaskRequestBody } from "@trigger.dev/core/v3";
import { RunEngineVersion, TaskRun } from "@trigger.dev/database";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { determineEngineVersion } from "../engineVersion.server";
import { WithRunEngine } from "./baseService.server";
import { TriggerTaskServiceV1 } from "./triggerTaskV1.server";
import { RunEngineTriggerTaskService } from "~/runEngine/services/triggerTask.server";

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
    const service = new RunEngineTriggerTaskService({
      prisma: this._prisma,
      engine: this._engine,
    });
    return await service.call({
      taskId,
      environment,
      body,
      options,
    });
  }
}
