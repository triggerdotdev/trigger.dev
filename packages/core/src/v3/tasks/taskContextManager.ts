import { Attributes } from "@opentelemetry/api";
import { TaskRunContext } from "../schemas";
import { SafeAsyncLocalStorage } from "../utils/safeAsyncLocalStorage";

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
      return { ...flattenAttributes("__trigger", this.ctx), "service.name": this.ctx.task.id };
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

function flattenAttributes(
  prefix: string,
  obj: Record<string, any> | null | undefined
): Record<string, any> {
  const result: Record<string, string | number> = {};

  // Check if obj is null or undefined
  if (obj == null) {
    return result;
  }

  for (const [key, value] of Object.entries(obj)) {
    const newPrefix = `${prefix}.${key}`;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === "object" && value[i] !== null) {
          // update null check here as well
          Object.assign(result, flattenAttributes(`${newPrefix}.${i}`, value[i]));
        } else {
          result[`${newPrefix}.${i}`] = value[i];
        }
      }
    } else if (typeof value === "object" && value !== null) {
      // update null check here
      Object.assign(result, flattenAttributes(newPrefix, value));
    } else {
      result[newPrefix] = value;
    }
  }

  return result;
}
