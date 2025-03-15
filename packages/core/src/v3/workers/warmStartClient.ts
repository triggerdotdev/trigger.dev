import { DequeuedMessage } from "../schemas/runEngine.js";
import { SimpleStructuredLogger } from "../utils/structuredLogger.js";
import { WarmStartConnectResponse } from "../schemas/warmStart.js";
import { ApiResult, wrapZodFetch } from "../zodfetch.js";
import { ExponentialBackoff } from "../apps/backoff.js";

export type WarmStartClientOptions = {
  apiUrl: URL;
  controllerId: string;
  deploymentId: string;
  deploymentVersion: string;
  machineCpu: string;
  machineMemory: string;
};

export class WarmStartClient {
  private readonly logger = new SimpleStructuredLogger("warm-start-client");
  private readonly apiUrl: URL;
  private backoff = new ExponentialBackoff("FullJitter");

  private get connectUrl() {
    return new URL("/connect", this.apiUrl);
  }

  private get warmStartUrl() {
    return new URL("/warm-start", this.apiUrl);
  }

  constructor(private opts: WarmStartClientOptions) {
    this.apiUrl = opts.apiUrl;
  }

  async connect(): Promise<ApiResult<WarmStartConnectResponse>> {
    return wrapZodFetch(
      WarmStartConnectResponse,
      this.connectUrl.href,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      },
      {
        retry: {
          minTimeoutInMs: 200,
          maxTimeoutInMs: 2000,
          maxAttempts: 3,
          factor: 2,
          randomize: false,
        },
      }
    );
  }

  async warmStart({
    workerInstanceName,
    connectionTimeoutMs,
    keepaliveMs,
  }: {
    workerInstanceName: string;
    connectionTimeoutMs: number;
    keepaliveMs: number;
  }): Promise<DequeuedMessage | null> {
    const res = await this.longPoll<unknown>(
      this.warmStartUrl.href,
      {
        method: "GET",
        headers: {
          "x-trigger-workload-controller-id": this.opts.controllerId,
          "x-trigger-deployment-id": this.opts.deploymentId,
          "x-trigger-deployment-version": this.opts.deploymentVersion,
          "x-trigger-machine-cpu": this.opts.machineCpu,
          "x-trigger-machine-memory": this.opts.machineMemory,
          "x-trigger-worker-instance-name": workerInstanceName,
        },
      },
      {
        timeoutMs: connectionTimeoutMs,
        totalDurationMs: keepaliveMs,
      }
    );

    if (!res.ok) {
      this.logger.error("warmStart: failed", {
        error: res.error,
        connectionTimeoutMs,
        keepaliveMs,
      });
      return null;
    }

    const nextRun = DequeuedMessage.parse(res.data);

    this.logger.debug("warmStart: got next run", { nextRun });

    return nextRun;
  }

  private async longPoll<T = any>(
    url: string,
    requestInit: Omit<RequestInit, "signal">,
    {
      timeoutMs,
      totalDurationMs,
    }: {
      timeoutMs: number;
      totalDurationMs: number;
    }
  ): Promise<
    | {
        ok: true;
        data: T;
      }
    | {
        ok: false;
        error: string;
      }
  > {
    this.logger.debug("Long polling", { url, requestInit, timeoutMs, totalDurationMs });

    const endTime = Date.now() + totalDurationMs;

    let retries = 0;

    while (Date.now() < endTime) {
      try {
        const controller = new AbortController();
        const signal = controller.signal;

        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(url, { ...requestInit, signal });

        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();

          return {
            ok: true,
            data,
          };
        } else {
          return {
            ok: false,
            error: `Server error: ${response.status}`,
          };
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          this.logger.log("Long poll request timed out, retrying...");
          continue;
        } else {
          this.logger.error("Error during fetch, retrying...", { error });

          // Wait with exponential backoff
          await this.backoff.wait(retries++);

          continue;
        }
      }
    }

    return {
      ok: false,
      error: "TotalDurationExceeded",
    };
  }
}
