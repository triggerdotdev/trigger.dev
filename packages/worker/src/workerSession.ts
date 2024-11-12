import { HeartbeatService } from "@trigger.dev/core/v3";
import { WorkerHttpClient } from "./client/http.js";
import { WorkerClientCommonOptions } from "./client/types.js";
import { WorkerWebsocketClient } from "./client/websocket.js";
import { WorkerApiDequeueResponseBody, WorkerApiHeartbeatRequestBody } from "./schemas.js";
import { RunQueueConsumer } from "./queueConsumer.js";

type WorkerSessionOptions = WorkerClientCommonOptions & {
  heartbeatIntervalSeconds?: number;
};

export class WorkerSession {
  private readonly httpClient: WorkerHttpClient;
  private readonly websocketClient: WorkerWebsocketClient;
  private readonly queueConsumer: RunQueueConsumer;
  private readonly heartbeatService: HeartbeatService;
  private readonly heartbeatIntervalSeconds: number;

  constructor(private opts: WorkerSessionOptions) {
    this.httpClient = new WorkerHttpClient(opts);
    this.websocketClient = new WorkerWebsocketClient(opts);
    this.queueConsumer = new RunQueueConsumer({
      client: this.httpClient,
      onDequeue: this.onDequeue.bind(this),
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
  }

  private async onDequeue(messages: WorkerApiDequeueResponseBody): Promise<void> {
    console.log("[WorkerSession] Dequeued messages", { count: messages.length });
    console.debug("[WorkerSession] Dequeued messages with contents", messages);

    for (const message of messages) {
      console.log("[WorkerSession] Processing message", { message });

      const start = await this.httpClient.startRun(message.run.id, message.snapshot.id);

      if (!start.success) {
        console.error("[WorkerSession] Failed to start run", { error: start.error });
        continue;
      }

      console.log("[WorkerSession] Started run", {
        runId: start.data.run.id,
        snapshot: start.data.snapshot.id,
      });

      const complete = await this.httpClient.completeRun(
        start.data.run.id,
        start.data.snapshot.id,
        {
          completion: {
            id: start.data.run.friendlyId,
            ok: true,
            outputType: "application/json",
          },
        }
      );

      if (!complete.success) {
        console.error("[WorkerSession] Failed to complete run", { error: complete.error });
        continue;
      }

      console.log("[WorkerSession] Completed run", {
        runId: start.data.run.id,
        result: complete.data.result,
      });
    }
  }

  async start() {
    const connect = await this.httpClient.connect();
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
