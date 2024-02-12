import { Attributes } from "@opentelemetry/api";
import { TaskRunContext } from "../schemas";
import { SafeAsyncLocalStorage } from "../utils/safeAsyncLocalStorage";
import { flattenAttributes } from "../utils/flattenAttributes";

type TaskContext = {
  ctx: TaskRunContext;
  payload: any;
};

export class TaskContextManager {
  private _storage: SafeAsyncLocalStorage<TaskContext> = new SafeAsyncLocalStorage<TaskContext>();

  get ctx(): TaskRunContext | undefined {
    const store = this.#getStore();
    return store?.ctx;
  }

  get payload(): any | undefined {
    const store = this.#getStore();
    return store?.payload;
  }

  get attributes(): Attributes {
    if (this.ctx) {
      return {
        ...flattenAttributes(this.ctx, "ctx"),
        ...flattenAttributes(this.payload, "payload"),
        "service.name": this.ctx.task.id,
      };
    }

    return {};
  }

  runWith<R extends (...args: any[]) => Promise<any>>(
    context: TaskContext,
    fn: R
  ): Promise<ReturnType<R>> {
    return this._storage.runWith(context, fn);
  }

  #getStore(): TaskContext | undefined {
    return this._storage.getStore();
  }
}

export const taskContextManager = new TaskContextManager();
