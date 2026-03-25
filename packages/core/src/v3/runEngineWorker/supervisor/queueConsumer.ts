import { SimpleStructuredLogger } from "../../utils/structuredLogger.js";
import { SupervisorHttpClient } from "./http.js";
import { WorkerApiDequeueResponseBody } from "./schemas.js";
import { PreDequeueFn, PreSkipFn } from "./types.js";

export interface QueueConsumer {
  start(): void;
  stop(): void;
}

export type RunQueueConsumerOptions = {
  client: SupervisorHttpClient;
  intervalMs: number;
  idleIntervalMs: number;
  preDequeue?: PreDequeueFn;
  preSkip?: PreSkipFn;
  maxRunCount?: number;
  onDequeue: (messages: WorkerApiDequeueResponseBody) => Promise<void>;
};

export class RunQueueConsumer implements QueueConsumer {
  private readonly client: SupervisorHttpClient;
  private readonly preDequeue?: PreDequeueFn;
  private readonly preSkip?: PreSkipFn;
  private readonly maxRunCount?: number;
  private readonly onDequeue: (messages: WorkerApiDequeueResponseBody) => Promise<void>;

  private readonly logger = new SimpleStructuredLogger("queue-consumer");

  private intervalMs: number;
  private idleIntervalMs: number;
  private isEnabled: boolean;

  constructor(opts: RunQueueConsumerOptions) {
    this.isEnabled = false;
    this.intervalMs = opts.intervalMs;
    this.idleIntervalMs = opts.idleIntervalMs;
    this.preDequeue = opts.preDequeue;
    this.preSkip = opts.preSkip;
    this.maxRunCount = opts.maxRunCount;
    this.onDequeue = opts.onDequeue;
    this.client = opts.client;
  }

  start() {
    if (this.isEnabled) {
      return;
    }

    this.isEnabled = true;
    this.dequeue();
  }

  stop() {
    if (!this.isEnabled) {
      return;
    }

    this.isEnabled = false;
  }

  private async dequeue() {
    this.logger.verbose("dequeue()", {
      enabled: this.isEnabled,
      intervalMs: this.intervalMs,
      idleIntervalMs: this.idleIntervalMs,
      maxRunCount: this.maxRunCount,
      preDequeue: !!this.preDequeue,
      preSkip: !!this.preSkip,
    });

    if (!this.isEnabled) {
      this.logger.warn("dequeue() - not enabled");
      return;
    }

    let preDequeueResult: Awaited<ReturnType<PreDequeueFn>> | undefined;
    if (this.preDequeue) {
      this.logger.verbose("preDequeue()");

      try {
        preDequeueResult = await this.preDequeue();
      } catch (preDequeueError) {
        this.logger.error("preDequeue error", { error: preDequeueError });
      }
    }

    this.logger.verbose("preDequeueResult", { preDequeueResult });

    if (
      preDequeueResult?.skipDequeue ||
      preDequeueResult?.maxResources?.cpu === 0 ||
      preDequeueResult?.maxResources?.memory === 0
    ) {
      this.logger.debug("skipping dequeue", { preDequeueResult });

      if (this.preSkip) {
        this.logger.debug("preSkip()");

        try {
          await this.preSkip();
        } catch (preSkipError) {
          this.logger.error("preSkip error", { error: preSkipError });
        }
      }

      this.scheduleNextDequeue(this.idleIntervalMs);
      return;
    }

    let nextIntervalMs = this.idleIntervalMs;

    try {
      const response = await this.client.dequeue({
        maxResources: preDequeueResult?.maxResources,
        maxRunCount: this.maxRunCount,
      });

      if (!response.success) {
        this.logger.error("Failed to dequeue", { error: response.error });
      } else {
        try {
          await this.onDequeue(response.data);

          if (response.data.length > 0) {
            nextIntervalMs = this.intervalMs;
          }
        } catch (handlerError) {
          this.logger.error("onDequeue error", { error: handlerError });
        }
      }
    } catch (clientError) {
      this.logger.error("client.dequeue error", { error: clientError });
    }

    this.scheduleNextDequeue(nextIntervalMs);
  }

  private scheduleNextDequeue(delayMs: number) {
    if (delayMs === this.idleIntervalMs && this.idleIntervalMs !== this.intervalMs) {
      this.logger.verbose("scheduled dequeue with idle interval", { delayMs });
    }

    setTimeout(this.dequeue.bind(this), delayMs);
  }
}
