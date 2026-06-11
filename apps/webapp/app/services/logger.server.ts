import type { LogLevel } from "@trigger.dev/core/logger";
import { Logger } from "@trigger.dev/core/logger";
import { patchConsoleToTelnet, startTelnetLogServer } from "@trigger.dev/core/v3/telnetLogServer";
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
  (process.env.APP_LOG_LEVEL ?? "info") as LogLevel,
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
  (process.env.APP_LOG_LEVEL ?? "info") as LogLevel,
  ["examples", "output", "connectionString"],
  sensitiveDataReplacer,
  () => {
    const fields = currentFieldsStore.getStore();
    return fields ? { ...fields } : {};
  }
);

export const socketLogger = new Logger(
  "socket",
  (process.env.APP_LOG_LEVEL ?? "info") as LogLevel,
  [],
  sensitiveDataReplacer,
  () => {
    const fields = currentFieldsStore.getStore();
    return fields ? { ...fields } : {};
  }
);

// Opt-in, dev-only: mirror this process's stdout to a local telnet/TCP stream.
// We patch console (rather than the static Logger.onLog sink) so the stream also captures logs
// from separate/bundled copies of the Logger — e.g. the enterprise SSO plugin, which bundles its
// own @trigger.dev/core and logs via its own console.log, invisible to the webapp's onLog hook.
const telnetLogsPort = process.env.WEBAPP_TELNET_LOGS_PORT
  ? Number(process.env.WEBAPP_TELNET_LOGS_PORT)
  : undefined;
if (telnetLogsPort && Number.isFinite(telnetLogsPort) && telnetLogsPort > 0) {
  const telnetGlobal = globalThis as typeof globalThis & { __webappTelnetLogs?: boolean };
  if (!telnetGlobal.__webappTelnetLogs) {
    telnetGlobal.__webappTelnetLogs = true;
    const telnetLogServer = startTelnetLogServer({ port: telnetLogsPort, name: "webapp" });
    patchConsoleToTelnet(telnetLogServer, { pretty: true });
  }
}
