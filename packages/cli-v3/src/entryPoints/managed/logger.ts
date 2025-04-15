import {
  WorkloadDebugLogRequestBody,
  WorkloadHttpClient,
} from "@trigger.dev/core/v3/runEngineWorker";
import { RunnerEnv } from "./env.js";

export type SendDebugLogOptions = {
  runId?: string;
  message: string;
  date?: Date;
  properties?: WorkloadDebugLogRequestBody["properties"];
};

export type RunLoggerOptions = {
  httpClient: WorkloadHttpClient;
  env: RunnerEnv;
};

export class RunLogger {
  private readonly httpClient: WorkloadHttpClient;
  private readonly env: RunnerEnv;

  constructor(private readonly opts: RunLoggerOptions) {
    this.httpClient = opts.httpClient;
    this.env = opts.env;
  }

  sendDebugLog({ runId, message, date, properties }: SendDebugLogOptions) {
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

    console.log(message, mergedProperties);

    this.httpClient.sendDebugLog(runId, {
      message,
      time: date ?? new Date(),
      properties: mergedProperties,
    });
  }
}
