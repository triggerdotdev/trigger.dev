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
  private abortController: AbortController | null = null;

  private get connectUrl() {
    return new URL("/connect", this.apiUrl);
  }

  private get warmStartUrl() {
    return new URL("/warm-start", this.apiUrl);
  }

  constructor(private opts: WarmStartClientOptions) {
    this.apiUrl = opts.apiUrl;
  }

  abort() {
    if (!this.abortController) {
      this.logger.warn("Abort called but no abort controller exists");
      return;
    }

    this.abortController.abort();
    this.abortController = null;
  }

  private async withAbort<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.abortController) {
      throw new Error("A warm start is already in progress");
    }

    this.abortController = new AbortController();

    try {
      return await fn(this.abortController.signal);
    } finally {
      this.abortController = null;
    }
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
    return this.withAbort(async (abortSignal) => {
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
          abortSignal,
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
    });
  }

  private async longPoll<T = any>(
    url: string,
    requestInit: Omit<RequestInit, "signal">,
    {
      timeoutMs,
      totalDurationMs,
      abortSignal,
    }: {
      timeoutMs: number;
      totalDurationMs: number;
      abortSignal: AbortSignal;
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
      if (abortSignal.aborted) {
        return {
          ok: false,
          error: "Aborted - abort signal triggered before fetch",
        };
      }

      try {
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

        // Create compound signal that aborts on either timeout or parent abort
        const signals = [timeoutController.signal, abortSignal];
        const signal = AbortSignal.any(signals);

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
          // Check if this was a parent abort or just a timeout
          if (abortSignal.aborted) {
            return {
              ok: false,
              error: "Aborted - abort signal triggered during fetch",
            };
          }
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
