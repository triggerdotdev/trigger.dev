import { z } from "zod";
import {
  WorkerApiConnectRequestBody,
  WorkerApiConnectResponseBody,
  WorkerApiContinueRunExecutionRequestBody,
  WorkerApiDequeueRequestBody,
  WorkerApiDequeueResponseBody,
  WorkerApiHeartbeatRequestBody,
  WorkerApiHeartbeatResponseBody,
  WorkerApiRunAttemptCompleteRequestBody,
  WorkerApiRunAttemptCompleteResponseBody,
  WorkerApiRunAttemptStartRequestBody,
  WorkerApiRunAttemptStartResponseBody,
  WorkerApiRunHeartbeatRequestBody,
  WorkerApiRunHeartbeatResponseBody,
  WorkerApiRunLatestSnapshotResponseBody,
  WorkerApiDebugLogBody,
  WorkerApiSuspendRunRequestBody,
  WorkerApiSuspendRunResponseBody,
  WorkerApiRunSnapshotsSinceResponseBody,
} from "./schemas.js";
import { SupervisorClientCommonOptions } from "./types.js";
import { getDefaultWorkerHeaders } from "./util.js";
import { wrapZodFetch } from "../../zodfetch.js";
import { createHeaders } from "../util.js";
import { WORKER_HEADERS } from "../consts.js";
import { SimpleStructuredLogger } from "../../utils/structuredLogger.js";

type SupervisorHttpClientOptions = SupervisorClientCommonOptions;

export class SupervisorHttpClient {
  private readonly apiUrl: string;
  private readonly workerToken: string;
  private readonly instanceName: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly sendRunDebugLogs: boolean;

  private readonly logger = new SimpleStructuredLogger("supervisor-http-client");

  constructor(opts: SupervisorHttpClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.workerToken = opts.workerToken;
    this.instanceName = opts.instanceName;
    this.defaultHeaders = getDefaultWorkerHeaders(opts);
    this.sendRunDebugLogs = opts.sendRunDebugLogs ?? false;

    if (!this.apiUrl) {
      throw new Error("apiURL is required and needs to be a non-empty string");
    }

    if (!this.workerToken) {
      throw new Error("workerToken is required and needs to be a non-empty string");
    }

    if (!this.instanceName) {
      throw new Error("instanceName is required and needs to be a non-empty string");
    }
  }

  async connect(body: WorkerApiConnectRequestBody) {
    return wrapZodFetch(
      WorkerApiConnectResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/connect`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
  }

  async dequeue(body: WorkerApiDequeueRequestBody) {
    return wrapZodFetch(
      WorkerApiDequeueResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/dequeue`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
  }

  /** @deprecated Not currently used */
  async dequeueFromVersion(deploymentId: string, maxRunCount = 1, runnerId?: string) {
    return wrapZodFetch(
      WorkerApiDequeueResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/deployments/${deploymentId}/dequeue?maxRunCount=${maxRunCount}`,
      {
        headers: {
          ...this.defaultHeaders,
          ...this.runnerIdHeader(runnerId),
        },
      }
    );
  }

  async heartbeatWorker(body: WorkerApiHeartbeatRequestBody) {
    return wrapZodFetch(
      WorkerApiHeartbeatResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/heartbeat`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
  }

  async heartbeatRun(
    runId: string,
    snapshotId: string,
    body: WorkerApiRunHeartbeatRequestBody,
    runnerId?: string
  ) {
    return wrapZodFetch(
      WorkerApiRunHeartbeatResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/heartbeat`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
          ...this.runnerIdHeader(runnerId),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
  }

  async startRunAttempt(
    runId: string,
    snapshotId: string,
    body: WorkerApiRunAttemptStartRequestBody,
    runnerId?: string
  ) {
    return wrapZodFetch(
      WorkerApiRunAttemptStartResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/attempts/start`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
          ...this.runnerIdHeader(runnerId),
        },
        body: JSON.stringify(body),
      }
    );
  }

  async completeRunAttempt(
    runId: string,
    snapshotId: string,
    body: WorkerApiRunAttemptCompleteRequestBody,
    runnerId?: string
  ) {
    return wrapZodFetch(
      WorkerApiRunAttemptCompleteResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/attempts/complete`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
          ...this.runnerIdHeader(runnerId),
        },
        body: JSON.stringify(body),
      }
    );
  }

  async getLatestSnapshot(runId: string, runnerId?: string) {
    return wrapZodFetch(
      WorkerApiRunLatestSnapshotResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/runs/${runId}/snapshots/latest`,
      {
        method: "GET",
        headers: {
          ...this.defaultHeaders,
          ...this.runnerIdHeader(runnerId),
        },
      }
    );
  }

  async getSnapshotsSince(runId: string, snapshotId: string, runnerId?: string) {
    return wrapZodFetch(
      WorkerApiRunSnapshotsSinceResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/runs/${runId}/snapshots/since/${snapshotId}`,
      {
        method: "GET",
        headers: {
          ...this.defaultHeaders,
          ...this.runnerIdHeader(runnerId),
        },
      }
    );
  }

  async sendDebugLog(runId: string, body: WorkerApiDebugLogBody, runnerId?: string): Promise<void> {
    if (!this.sendRunDebugLogs) {
      return;
    }

    try {
      const res = await wrapZodFetch(
        z.unknown(),
        `${this.apiUrl}/engine/v1/worker-actions/runs/${runId}/logs/debug`,
        {
          method: "POST",
          headers: {
            ...this.defaultHeaders,
            ...this.runnerIdHeader(runnerId),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );

      if (!res.success) {
        this.logger.error("Failed to send debug log", { error: res.error });
      }
    } catch (error) {
      this.logger.error("Failed to send debug log (caught error)", { error });
    }
  }

  async continueRunExecution(runId: string, snapshotId: string, runnerId?: string) {
    return wrapZodFetch(
      WorkerApiContinueRunExecutionRequestBody,
      `${this.apiUrl}/engine/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/continue`,
      {
        method: "GET",
        headers: {
          ...this.defaultHeaders,
          ...this.runnerIdHeader(runnerId),
        },
      }
    );
  }

  async submitSuspendCompletion({
    runId,
    snapshotId,
    runnerId,
    body,
  }: {
    runId: string;
    snapshotId: string;
    runnerId?: string;
    body: WorkerApiSuspendRunRequestBody;
  }) {
    return wrapZodFetch(
      WorkerApiSuspendRunResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/suspend`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
          ...this.runnerIdHeader(runnerId),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
  }

  private runnerIdHeader(runnerId?: string): Record<string, string> {
    return createHeaders({
      [WORKER_HEADERS.RUNNER_ID]: runnerId,
    });
  }
}
