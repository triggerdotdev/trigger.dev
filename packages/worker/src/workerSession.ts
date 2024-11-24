import { HeartbeatService } from "@trigger.dev/core/v3";
import { WorkerHttpClient } from "./client/http.js";
import { WorkerClientCommonOptions } from "./client/types.js";
import { WorkerWebsocketClient } from "./client/websocket.js";
import { WorkerApiDequeueResponseBody, WorkerApiHeartbeatRequestBody } from "./schemas.js";
import { RunQueueConsumer } from "./queueConsumer.js";
import { WorkerEventArgs, WorkerEvents } from "./events.js";
import EventEmitter from "events";
import { VERSION } from "./version.js";

type WorkerSessionOptions = WorkerClientCommonOptions & {
  heartbeatIntervalSeconds?: number;
  dequeueIntervalMs?: number;
};

export class WorkerSession extends EventEmitter<WorkerEvents> {
  private readonly httpClient: WorkerHttpClient;
  private readonly websocketClient: WorkerWebsocketClient;
  private readonly queueConsumer: RunQueueConsumer;
  private readonly heartbeatService: HeartbeatService;
  private readonly heartbeatIntervalSeconds: number;

  constructor(private opts: WorkerSessionOptions) {
    super();

    this.httpClient = new WorkerHttpClient(opts);
    this.websocketClient = new WorkerWebsocketClient(opts);
    this.queueConsumer = new RunQueueConsumer({
      client: this.httpClient,
      onDequeue: this.onDequeue.bind(this),
      intervalMs: opts.dequeueIntervalMs,
    });

    // TODO: This should be dynamic and set by (or at least overridden by) the platform
    this.heartbeatIntervalSeconds = opts.heartbeatIntervalSeconds || 30;
    this.heartbeatService = new HeartbeatService({
      heartbeat: async () => {
        console.debug("[WorkerSession] Sending heartbeat");

        const body = this.getHeartbeatBody();
        const response = await this.httpClient.heartbeat(body);

        if (!response.success) {
          console.error("[WorkerSession] Heartbeat failed", { error: response.error });
        }
      },
      intervalMs: this.heartbeatIntervalSeconds * 1000,
      leadingEdge: false,
      onError: async (error) => {
        console.error("[WorkerSession] Failed to send heartbeat", { error });
      },
    });

    this.on("requestRunAttemptStart", this.onRequestRunAttemptStart.bind(this));
    this.on("runAttemptCompleted", this.onRunAttemptCompleted.bind(this));
  }

  private async onDequeue(messages: WorkerApiDequeueResponseBody): Promise<void> {
    console.log("[WorkerSession] Dequeued messages", { count: messages.length });
    console.debug("[WorkerSession] Dequeued messages with contents", messages);

    for (const message of messages) {
      console.log("[WorkerSession] Emitting message", { message });
      this.emit("runQueueMessage", {
        time: new Date(),
        message,
      });
    }
  }

  private async onRequestRunAttemptStart(
    ...[{ time, run, snapshot }]: WorkerEventArgs<"requestRunAttemptStart">
  ): Promise<void> {
    console.log("[WorkerSession] onRequestRunAttemptStart", { time, run, snapshot });

    const start = await this.httpClient.startRun(run.id, snapshot.id);

    if (!start.success) {
      console.error("[WorkerSession] Failed to start run", { error: start.error });
      return;
    }

    console.log("[WorkerSession] Started run", {
      runId: start.data.run.id,
      snapshot: start.data.snapshot.id,
    });

    this.emit("runAttemptStarted", {
      time: new Date(),
      ...start.data,
    });
  }

  private async onRunAttemptCompleted(
    ...[{ time, run, snapshot, completion }]: WorkerEventArgs<"runAttemptCompleted">
  ): Promise<void> {
    console.log("[WorkerSession] onRunAttemptCompleted", { time, run, snapshot, completion });

    const complete = await this.httpClient.completeRun(run.id, snapshot.id, {
      completion: completion,
    });

    if (!complete.success) {
      console.error("[WorkerSession] Failed to complete run", { error: complete.error });
      return;
    }

    console.log("[WorkerSession] Completed run", {
      runId: run.id,
      result: complete.data.result,
    });
  }

  async start() {
    const connect = await this.httpClient.connect({
      metadata: {
        workerVersion: VERSION,
      },
    });

    if (!connect.success) {
      console.error("[WorkerSession] Failed to connect via HTTP client", { error: connect.error });
      throw new Error("[WorkerSession] Failed to connect via HTTP client");
    }

    this.queueConsumer.start();
    this.heartbeatService.start();
    this.websocketClient.start();
  }

  async stop() {
    this.heartbeatService.stop();
    this.websocketClient.stop();
  }

  private getHeartbeatBody(): WorkerApiHeartbeatRequestBody {
    return {
      cpu: {
        used: 0.5,
        available: 0.5,
      },
      memory: {
        used: 0.5,
        available: 0.5,
      },
      tasks: [],
    };
  }
}
