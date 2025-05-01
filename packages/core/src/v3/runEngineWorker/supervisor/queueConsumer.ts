import { SupervisorHttpClient } from "./http.js";
import { WorkerApiDequeueResponseBody } from "./schemas.js";
import { PreDequeueFn, PreSkipFn } from "./types.js";

type RunQueueConsumerOptions = {
  client: SupervisorHttpClient;
  intervalMs: number;
  idleIntervalMs: number;
  preDequeue?: PreDequeueFn;
  preSkip?: PreSkipFn;
  maxRunCount?: number;
  onDequeue: (messages: WorkerApiDequeueResponseBody) => Promise<void>;
};

export class RunQueueConsumer {
  private readonly client: SupervisorHttpClient;
  private readonly preDequeue?: PreDequeueFn;
  private readonly preSkip?: PreSkipFn;
  private readonly maxRunCount?: number;
  private readonly onDequeue: (messages: WorkerApiDequeueResponseBody) => Promise<void>;

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
    // Incredibly verbose logging for debugging purposes
    // console.debug("[RunQueueConsumer] dequeue()", { enabled: this.isEnabled });

    if (!this.isEnabled) {
      return;
    }

    let preDequeueResult: Awaited<ReturnType<PreDequeueFn>> | undefined;
    if (this.preDequeue) {
      // console.debug("[RunQueueConsumer] preDequeue()");

      try {
        preDequeueResult = await this.preDequeue();
      } catch (preDequeueError) {
        console.error("[RunQueueConsumer] preDequeue error", { error: preDequeueError });
      }
    }

    // console.debug("[RunQueueConsumer] preDequeueResult", { preDequeueResult });

    if (
      preDequeueResult?.skipDequeue ||
      preDequeueResult?.maxResources?.cpu === 0 ||
      preDequeueResult?.maxResources?.memory === 0
    ) {
      if (this.preSkip) {
        console.debug("[RunQueueConsumer] preSkip()");

        try {
          await this.preSkip();
        } catch (preSkipError) {
          console.error("[RunQueueConsumer] preSkip error", { error: preSkipError });
        }
      }

      return this.scheduleNextDequeue(this.idleIntervalMs);
    }

    let nextIntervalMs = this.idleIntervalMs;

    try {
      const response = await this.client.dequeue({
        maxResources: preDequeueResult?.maxResources,
        maxRunCount: this.maxRunCount,
      });

      if (!response.success) {
        console.error("[RunQueueConsumer] Failed to dequeue", { error: response.error });
      } else {
        try {
          await this.onDequeue(response.data);

          if (response.data.length > 0) {
            nextIntervalMs = this.intervalMs;
          }
        } catch (handlerError) {
          console.error("[RunQueueConsumer] onDequeue error", { error: handlerError });
        }
      }
    } catch (clientError) {
      console.error("[RunQueueConsumer] client.dequeue error", { error: clientError });
    }

    this.scheduleNextDequeue(nextIntervalMs);
  }

  scheduleNextDequeue(delayMs: number) {
    setTimeout(this.dequeue.bind(this), delayMs);
  }
}
