import type { LogLevel } from "@trigger.dev/core/logger";
import { Logger } from "@trigger.dev/core/logger";
import { sensitiveDataReplacer } from "./sensitiveDataReplacer";
import { AsyncLocalStorage } from "async_hooks";
import { getHttpContext } from "./httpAsyncStorage.server";
import { captureException, captureMessage } from "@sentry/remix";

const currentFieldsStore = new AsyncLocalStorage<Record<string, unknown>>();

export function trace<T>(fields: Record<string, unknown>, fn: () => T): T {
  return currentFieldsStore.run(fields, fn);
}

Logger.onError = (message, ...args) => {
  const error = extractErrorFromArgs(args);

  if (error) {
    captureException(error, {
      extra: {
        message,
        ...flattenArgs(args),
      },
    });
  } else {
    captureMessage(message, {
      level: "error",
      extra: flattenArgs(args),
    });
  }
};

function extractErrorFromArgs(args: Array<Record<string, unknown> | undefined>) {
  for (const arg of args) {
    if (arg && "error" in arg && arg.error instanceof Error) {
      return arg.error;
    }
  }
  return;
}

function flattenArgs(args: Array<Record<string, unknown> | undefined>) {
  return args.reduce((acc, arg) => {
    if (arg) {
      return { ...acc, ...arg };
    }
    return acc;
  }, {});
}
export const logger = new Logger(
  "webapp",
  (process.env.APP_LOG_LEVEL ?? "debug") as LogLevel,
  ["examples", "output", "connectionString", "payload"],
  sensitiveDataReplacer,
  () => {
    const fields = currentFieldsStore.getStore();
    const httpContext = getHttpContext();
    return { ...fields, http: httpContext };
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

export const socketLogger = new Logger(
  "socket",
  (process.env.APP_LOG_LEVEL ?? "debug") as LogLevel,
  [],
  sensitiveDataReplacer,
  () => {
    const fields = currentFieldsStore.getStore();
    return fields ? { ...fields } : {};
  }
);
