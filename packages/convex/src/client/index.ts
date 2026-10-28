import {
  createFunctionHandle,
  type FunctionReference,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type PaginationOptions,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import type { Config, Run, TriggerOptions } from "../component/shared.js";

export { vRun } from "../component/shared.js";
export type { Run, TriggerOptions, ComponentApi };
type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;
type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type TaskLike = { id: string; trigger: (...args: any[]) => any };

export type TriggerConfig = {
  secretKey?: string;
  baseUrl?: string;
  onComplete?: FunctionReference<"mutation", "internal", { run: Run }, any>;
};

export class Trigger {
  constructor(
    private component: ComponentApi,
    private config: TriggerConfig = {}
  ) {}

  private runtimeConfig(): Config {
    const secretKey = this.config.secretKey ?? process.env.TRIGGER_SECRET_KEY;
    if (!secretKey) throw new Error("Set TRIGGER_SECRET_KEY or pass secretKey");
    const url = new URL(this.config.baseUrl ?? "https://api.trigger.dev");
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    ) {
      throw new Error("baseUrl must use HTTPS, except for local development");
    }
    if (url.username || url.password || url.search || url.hash) throw new Error("Invalid baseUrl");
    return { secretKey, baseUrl: url.toString().replace(/\/$/, "") };
  }

  async trigger<TTask extends TaskLike = TaskLike>(
    ctx: MutationCtx,
    taskId: TTask["id"],
    payload: Parameters<TTask["trigger"]>[0],
    options: TriggerOptions & { idempotencyKey?: string } = {}
  ): Promise<string> {
    const { idempotencyKey, ...triggerOptions } = options;
    return ctx.runMutation(this.component.runs.trigger, {
      taskId,
      payload,
      options: triggerOptions,
      idempotencyKey,
      config: this.runtimeConfig(),
      callback: this.config.onComplete
        ? await createFunctionHandle(this.config.onComplete)
        : undefined,
    });
  }

  async getRun(ctx: QueryCtx, id: string): Promise<Run | null> {
    return ctx.runQuery(this.component.runs.get, { id });
  }

  async listRuns(
    ctx: QueryCtx,
    paginationOpts: PaginationOptions
  ): Promise<{
    page: Run[];
    isDone: boolean;
    continueCursor: string;
  }> {
    return ctx.runQuery(this.component.runs.list, { paginationOpts });
  }

  async resume(ctx: MutationCtx, id: string): Promise<null> {
    return ctx.runMutation(this.component.runs.resume, { id, config: this.runtimeConfig() });
  }
}
