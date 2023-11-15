import type { LogLevel } from "@trigger.dev/core";
import { Logger } from "@trigger.dev/core";
import { sensitiveDataReplacer } from "./sensitiveDataReplacer";
import { AsyncLocalStorage } from "async_hooks";

const currentFieldsStore = new AsyncLocalStorage<Record<string, unknown>>();

export function trace<T>(fields: Record<string, unknown>, fn: () => T): T {
  return currentFieldsStore.run(fields, fn);
}

export const logger = new Logger(
  "webapp",
  (process.env.APP_LOG_LEVEL ?? "debug") as LogLevel,
  ["examples", "output", "connectionString", "payload"],
  sensitiveDataReplacer,
  () => {
    const fields = currentFieldsStore.getStore();
    return fields ? { ...fields } : {};
  }
);

export const workerLogger = new Logger(
  "worker",
  (process.env.APP_LOG_LEVEL ?? "debug") as LogLevel,
  ["examples", "output", "connectionString"],
  sensitiveDataReplacer,
  () => {
    const fields = currentFieldsStore.getStore();
    return fields ? { ...fields } : {};
  }
);
