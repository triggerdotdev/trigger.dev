import { Attributes } from "@opentelemetry/api";
import { ServerBackgroundWorker, TaskRunContext } from "../schemas/index.js";
import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { TaskContext } from "./types.js";
import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";

const API_NAME = "task-context";

export class TaskContextAPI {
  private static _instance?: TaskContextAPI;

  private constructor() {}

  public static getInstance(): TaskContextAPI {
    if (!this._instance) {
      this._instance = new TaskContextAPI();
    }

    return this._instance;
  }

  get isInsideTask(): boolean {
    return this.#getTaskContext() !== undefined;
  }

  get ctx(): TaskRunContext | undefined {
    return this.#getTaskContext()?.ctx;
  }

  get worker(): ServerBackgroundWorker | undefined {
    return this.#getTaskContext()?.worker;
  }

  get attributes(): Attributes {
    if (this.ctx) {
      return {
        ...this.contextAttributes,
        ...this.workerAttributes,
      };
    }

    return {};
  }

  get workerAttributes(): Attributes {
    if (this.worker) {
      return {
        [SemanticInternalAttributes.WORKER_ID]: this.worker.id,
        [SemanticInternalAttributes.WORKER_VERSION]: this.worker.version,
      };
    }

    return {};
  }

  get contextAttributes(): Attributes {
    if (this.ctx) {
      return {
        [SemanticInternalAttributes.ATTEMPT_ID]: this.ctx.attempt.id,
        [SemanticInternalAttributes.ATTEMPT_NUMBER]: this.ctx.attempt.number,
        [SemanticInternalAttributes.TASK_SLUG]: this.ctx.task.id,
        [SemanticInternalAttributes.TASK_PATH]: this.ctx.task.filePath,
        [SemanticInternalAttributes.TASK_EXPORT_NAME]: this.ctx.task.exportName,
        [SemanticInternalAttributes.QUEUE_NAME]: this.ctx.queue.name,
        [SemanticInternalAttributes.QUEUE_ID]: this.ctx.queue.id,
        [SemanticInternalAttributes.ENVIRONMENT_ID]: this.ctx.environment.id,
        [SemanticInternalAttributes.ENVIRONMENT_TYPE]: this.ctx.environment.type,
        [SemanticInternalAttributes.ORGANIZATION_ID]: this.ctx.organization.id,
        [SemanticInternalAttributes.PROJECT_ID]: this.ctx.project.id,
        [SemanticInternalAttributes.PROJECT_REF]: this.ctx.project.ref,
        [SemanticInternalAttributes.PROJECT_NAME]: this.ctx.project.name,
        [SemanticInternalAttributes.RUN_ID]: this.ctx.run.id,
        [SemanticInternalAttributes.RUN_IS_TEST]: this.ctx.run.isTest,
        [SemanticInternalAttributes.ORGANIZATION_SLUG]: this.ctx.organization.slug,
        [SemanticInternalAttributes.ORGANIZATION_NAME]: this.ctx.organization.name,
        [SemanticInternalAttributes.BATCH_ID]: this.ctx.batch?.id,
        [SemanticInternalAttributes.IDEMPOTENCY_KEY]: this.ctx.run.idempotencyKey,
        [SemanticInternalAttributes.MACHINE_PRESET_NAME]: this.ctx.machine?.name,
        [SemanticInternalAttributes.MACHINE_PRESET_CPU]: this.ctx.machine?.cpu,
        [SemanticInternalAttributes.MACHINE_PRESET_MEMORY]: this.ctx.machine?.memory,
        [SemanticInternalAttributes.MACHINE_PRESET_CENTS_PER_MS]: this.ctx.machine?.centsPerMs,
      };
    }

    return {};
  }

  public disable() {
    unregisterGlobal(API_NAME);
  }

  public setGlobalTaskContext(taskContext: TaskContext): boolean {
    return registerGlobal(API_NAME, taskContext);
  }

  #getTaskContext(): TaskContext | undefined {
    return getGlobal(API_NAME);
  }
}
