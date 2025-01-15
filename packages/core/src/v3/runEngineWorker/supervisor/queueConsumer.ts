import { SupervisorHttpClient } from "./http.js";
import { WorkerApiDequeueResponseBody } from "./schemas.js";
import { PreDequeueFn } from "./types.js";

type RunQueueConsumerOptions = {
  client: SupervisorHttpClient;
  intervalMs?: number;
  preDequeue?: PreDequeueFn;
  onDequeue: (messages: WorkerApiDequeueResponseBody) => Promise<void>;
};

export class RunQueueConsumer {
  private readonly client: SupervisorHttpClient;
  private readonly preDequeue?: PreDequeueFn;
  private readonly onDequeue: (messages: WorkerApiDequeueResponseBody) => Promise<void>;

  private intervalMs: number;
  private isEnabled: boolean;

  constructor(opts: RunQueueConsumerOptions) {
    this.isEnabled = false;
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.preDequeue = opts.preDequeue;
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
      try {
        preDequeueResult = await this.preDequeue();
      } catch (preDequeueError) {
        console.error("[RunQueueConsumer] preDequeue error", { error: preDequeueError });
      }
    }

    if (
      preDequeueResult?.skipDequeue ||
      preDequeueResult?.maxResources?.cpu === 0 ||
      preDequeueResult?.maxResources?.memory === 0
    ) {
      return this.scheduleNextDequeue();
    }

    try {
      const response = await this.client.dequeue({
        maxResources: preDequeueResult?.maxResources,
      });

      if (!response.success) {
        console.error("[RunQueueConsumer] Failed to dequeue", { error: response.error });
      } else {
        try {
          await this.onDequeue(response.data);
        } catch (handlerError) {
          console.error("[RunQueueConsumer] onDequeue error", { error: handlerError });
        }
      }
    } catch (clientError) {
      console.error("[RunQueueConsumer] client.dequeue error", { error: clientError });
    }

    this.scheduleNextDequeue();
  }

  scheduleNextDequeue(delay: number = this.intervalMs) {
    setTimeout(this.dequeue.bind(this), delay);
  }
}
