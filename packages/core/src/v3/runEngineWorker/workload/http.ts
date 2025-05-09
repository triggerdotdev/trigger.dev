import { z } from "zod";
import {
  WorkloadHeartbeatRequestBody,
  WorkloadHeartbeatResponseBody,
  WorkloadRunAttemptCompleteRequestBody,
  WorkloadRunAttemptCompleteResponseBody,
  WorkloadRunAttemptStartResponseBody,
  WorkloadRunLatestSnapshotResponseBody,
  WorkloadDequeueFromVersionResponseBody,
  WorkloadRunAttemptStartRequestBody,
  WorkloadSuspendRunResponseBody,
  WorkloadContinueRunExecutionResponseBody,
  WorkloadDebugLogRequestBody,
  WorkloadRunSnapshotsSinceResponseBody,
} from "./schemas.js";
import { WorkloadClientCommonOptions } from "./types.js";
import { getDefaultWorkloadHeaders } from "./util.js";
import { wrapZodFetch } from "../../zodfetch.js";

type WorkloadHttpClientOptions = WorkloadClientCommonOptions;

export class WorkloadHttpClient {
  private apiUrl: string;
  private runnerId: string;
  private readonly deploymentId: string;

  constructor(private opts: WorkloadHttpClientOptions) {
    this.apiUrl = opts.workerApiUrl.replace(/\/$/, "");
    this.deploymentId = opts.deploymentId;
    this.runnerId = opts.runnerId;

    if (!this.apiUrl) {
      throw new Error("apiURL is required and needs to be a non-empty string");
    }

    if (!this.deploymentId) {
      throw new Error("deploymentId is required and needs to be a non-empty string");
    }
  }

  updateApiUrl(apiUrl: string) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
  }

  updateRunnerId(runnerId: string) {
    this.runnerId = runnerId;
  }

  defaultHeaders(): Record<string, string> {
    return getDefaultWorkloadHeaders({
      ...this.opts,
      runnerId: this.runnerId,
    });
  }

  async heartbeatRun(runId: string, snapshotId: string, body?: WorkloadHeartbeatRequestBody) {
    return wrapZodFetch(
      WorkloadHeartbeatResponseBody,
      `${this.apiUrl}/api/v1/workload-actions/runs/${runId}/snapshots/${snapshotId}/heartbeat`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
      }
    );
  }

  async suspendRun(runId: string, snapshotId: string) {
    return wrapZodFetch(
      WorkloadSuspendRunResponseBody,
      `${this.apiUrl}/api/v1/workload-actions/runs/${runId}/snapshots/${snapshotId}/suspend`,
      {
        method: "GET",
        headers: {
          ...this.defaultHeaders(),
        },
      }
    );
  }

  async continueRunExecution(runId: string, snapshotId: string) {
    return wrapZodFetch(
      WorkloadContinueRunExecutionResponseBody,
      `${this.apiUrl}/api/v1/workload-actions/runs/${runId}/snapshots/${snapshotId}/continue`,
      {
        method: "GET",
        headers: {
          ...this.defaultHeaders(),
        },
      }
    );
  }

  async startRunAttempt(
    runId: string,
    snapshotId: string,
    body: WorkloadRunAttemptStartRequestBody
  ) {
    return wrapZodFetch(
      WorkloadRunAttemptStartResponseBody,
      `${this.apiUrl}/api/v1/workload-actions/runs/${runId}/snapshots/${snapshotId}/attempts/start`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders(),
        },
        body: JSON.stringify(body),
      }
    );
  }

  async completeRunAttempt(
    runId: string,
    snapshotId: string,
    body: WorkloadRunAttemptCompleteRequestBody
  ) {
    return wrapZodFetch(
      WorkloadRunAttemptCompleteResponseBody,
      `${this.apiUrl}/api/v1/workload-actions/runs/${runId}/snapshots/${snapshotId}/attempts/complete`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders(),
        },
        body: JSON.stringify(body),
      }
    );
  }

  async getRunExecutionData(runId: string) {
    return wrapZodFetch(
      WorkloadRunLatestSnapshotResponseBody,
      `${this.apiUrl}/api/v1/workload-actions/runs/${runId}/snapshots/latest`,
      {
        method: "GET",
        headers: {
          ...this.defaultHeaders(),
        },
      }
    );
  }

  async getSnapshotsSince(runId: string, snapshotId: string) {
    return wrapZodFetch(
      WorkloadRunSnapshotsSinceResponseBody,
      `${this.apiUrl}/api/v1/workload-actions/runs/${runId}/snapshots/since/${snapshotId}`,
      {
        method: "GET",
        headers: {
          ...this.defaultHeaders(),
        },
      }
    );
  }

  async sendDebugLog(runId: string, body: WorkloadDebugLogRequestBody): Promise<void> {
    try {
      const res = await wrapZodFetch(
        z.unknown(),
        `${this.apiUrl}/api/v1/workload-actions/runs/${runId}/logs/debug`,
        {
          method: "POST",
          headers: {
            ...this.defaultHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );

      if (!res.success) {
        console.error("Failed to send debug log", res);
      }
    } catch (error) {
      console.error("Failed to send debug log", { error });
    }
  }

  /** @deprecated Not currently used */
  async dequeue() {
    return wrapZodFetch(
      WorkloadDequeueFromVersionResponseBody,
      `${this.apiUrl}/api/v1/workload-actions/deployments/${this.deploymentId}/dequeue`,
      {
        method: "GET",
        headers: {
          ...this.defaultHeaders(),
        },
      }
    );
  }
}
