import { SimpleStructuredLogger } from "../../utils/structuredLogger.js";
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
    // Incredibly verbose logging for debugging purposes
    // this.logger.debug("dequeue()", { enabled: this.isEnabled });

    if (!this.isEnabled) {
      return;
    }

    let preDequeueResult: Awaited<ReturnType<PreDequeueFn>> | undefined;
    if (this.preDequeue) {
      // this.logger.debug("preDequeue()");

      try {
        preDequeueResult = await this.preDequeue();
      } catch (preDequeueError) {
        this.logger.error("preDequeue error", { error: preDequeueError });
      }
    }

    // this.logger.debug("preDequeueResult", { preDequeueResult });

    if (
      preDequeueResult?.skipDequeue ||
      preDequeueResult?.maxResources?.cpu === 0 ||
      preDequeueResult?.maxResources?.memory === 0
    ) {
      if (this.preSkip) {
        this.logger.debug("preSkip()");

        try {
          await this.preSkip();
        } catch (preSkipError) {
          this.logger.error("preSkip error", { error: preSkipError });
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

  scheduleNextDequeue(delayMs: number) {
    setTimeout(this.dequeue.bind(this), delayMs);
  }
}
