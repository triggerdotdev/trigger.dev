import {
  DebugLogPropertiesInput,
  WorkloadDebugLogRequestBody,
  WorkloadHttpClient,
} from "@trigger.dev/core/v3/runEngineWorker";
import { RunnerEnv } from "./env.js";
import { flattenAttributes } from "@trigger.dev/core/v3";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";

export type SendDebugLogOptions = {
  runId?: string;
  message: string;
  date?: Date;
  properties?: DebugLogPropertiesInput;
  print?: boolean;
};

export interface RunLogger {
  sendDebugLog(options: SendDebugLogOptions): void;
}

export type RunLoggerOptions = {
  httpClient: WorkloadHttpClient;
  env: RunnerEnv;
};

export class ManagedRunLogger implements RunLogger {
  private readonly httpClient: WorkloadHttpClient;
  private readonly env: RunnerEnv;
  private readonly logger: SimpleStructuredLogger;

  constructor(opts: RunLoggerOptions) {
    this.httpClient = opts.httpClient;
    this.env = opts.env;
    this.logger = new SimpleStructuredLogger("managed-run-logger");
  }

  sendDebugLog({ runId, message, date, properties, print = true }: SendDebugLogOptions) {
    if (!runId) {
      runId = this.env.TRIGGER_RUN_ID;
    }

    if (!runId) {
      return;
    }

    const mergedProperties = {
      ...properties,
      runId,
      runnerId: this.env.TRIGGER_RUNNER_ID,
      workerName: this.env.TRIGGER_WORKER_INSTANCE_NAME,
    };

    if (print) {
      this.logger.log(message, mergedProperties);
    }

    const flattenedProperties = flattenAttributes(
      mergedProperties
    ) satisfies WorkloadDebugLogRequestBody["properties"];

    this.httpClient.sendDebugLog(runId, {
      message,
      time: date ?? new Date(),
      properties: flattenedProperties,
    });
  }
}

export class ConsoleRunLogger implements RunLogger {
  private readonly print: boolean;

  constructor(opts: { print?: boolean } = {}) {
    this.print = opts.print ?? true;
  }

  sendDebugLog({ message, properties }: SendDebugLogOptions): void {
    if (this.print) {
      console.log("[ConsoleLogger]", message, properties);
    }
  }
}
