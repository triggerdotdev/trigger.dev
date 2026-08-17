import type { LogLevel } from "@trigger.dev/core/logger";
import { Logger, redact } from "@trigger.dev/core/logger";
import { patchConsoleToTelnet, startTelnetLogServer } from "@trigger.dev/core/v3/telnetLogServer";
import { sensitiveDataReplacer } from "./sensitiveDataReplacer";
import { AsyncLocalStorage } from "async_hooks";
import { getHttpContext } from "./httpAsyncStorage.server";
import { captureException, captureMessage } from "@sentry/remix";

const currentFieldsStore = new AsyncLocalStorage<Record<string, unknown>>();

function trace<T>(fields: Record<string, unknown>, fn: () => T): T {
  return currentFieldsStore.run(fields, fn);
}

// The keys below aren't already in the Logger's default deny-list. Passing them here means the
// extra data sent to Sentry gets the same redaction as the stdout line, instead of bypassing it.
const SENTRY_EXTRA_FILTERED_KEYS = ["examples", "connectionString"];

Logger.onError = (message, ...args) => {
  const error = extractErrorFromArgs(args);
  const extra = redact(flattenArgs(args), SENTRY_EXTRA_FILTERED_KEYS) as Record<string, unknown>;

  if (error) {
    captureException(redactError(error), {
      extra: {
        message,
        ...extra,
      },
    });
  } else {
    captureMessage(message, {
      level: "error",
      extra,
    });
  }
};

function redactError(error: Error): Error {
  const redactedError = new Error(redact(error.message) as string);
  redactedError.name = error.name;

  if (error.stack) {
    redactedError.stack = redact(error.stack) as string;
  }

  return redactedError;
}

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
  ["examples", "output", "connectionString", "payload", "metadata", "seedMetadata"],
  sensitiveDataReplacer,
  () => {
    const fields = currentFieldsStore.getStore();
    const httpContext = getHttpContext();
    return { ...fields, http: httpContext };
  }
);

const workerLogger = new Logger(
  "worker",
  (process.env.APP_LOG_LEVEL ?? "info") as LogLevel,
  ["examples", "output", "connectionString"],
  sensitiveDataReplacer,
  () => {
    const fields = currentFieldsStore.getStore();
    return fields ? { ...fields } : {};
  }
);

const socketLogger = new Logger(
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
