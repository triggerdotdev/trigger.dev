import { HeartbeatService, MachineResources } from "@trigger.dev/core/v3";
import { SupervisorHttpClient } from "./http.js";
import { PreDequeueFn, SupervisorClientCommonOptions } from "./types.js";
import { WorkerApiDequeueResponseBody, WorkerApiHeartbeatRequestBody } from "./schemas.js";
import { RunQueueConsumer } from "./queueConsumer.js";
import { WorkerEvents } from "./events.js";
import EventEmitter from "events";
import { VERSION } from "../version.js";
import { io, Socket } from "socket.io-client";
import { WorkerClientToServerEvents, WorkerServerToClientEvents } from "../types.js";
import { getDefaultWorkerHeaders } from "./util.js";

type SupervisorSessionOptions = SupervisorClientCommonOptions & {
  heartbeatIntervalSeconds?: number;
  dequeueIntervalMs?: number;
  preDequeue?: PreDequeueFn;
};

export class SupervisorSession extends EventEmitter<WorkerEvents> {
  public readonly httpClient: SupervisorHttpClient;

  private socket?: Socket<WorkerServerToClientEvents, WorkerClientToServerEvents>;

  private readonly queueConsumer: RunQueueConsumer;
  private readonly heartbeatService: HeartbeatService;
  private readonly heartbeatIntervalSeconds: number;

  constructor(private opts: SupervisorSessionOptions) {
    super();

    this.httpClient = new SupervisorHttpClient(opts);
    this.queueConsumer = new RunQueueConsumer({
      client: this.httpClient,
      preDequeue: opts.preDequeue,
      onDequeue: this.onDequeue.bind(this),
      intervalMs: opts.dequeueIntervalMs,
    });

    // TODO: This should be dynamic and set by (or at least overridden by) the platform
    this.heartbeatIntervalSeconds = opts.heartbeatIntervalSeconds || 30;
    this.heartbeatService = new HeartbeatService({
      heartbeat: async () => {
        console.debug("[WorkerSession] Sending heartbeat");

        const body = this.getHeartbeatBody();
        const response = await this.httpClient.heartbeatWorker(body);

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
    // Incredibly verbose logging for debugging purposes
    // console.log("[WorkerSession] Dequeued messages", { count: messages.length });
    // console.debug("[WorkerSession] Dequeued messages with contents", messages);

    for (const message of messages) {
      console.log("[WorkerSession] Emitting message", { message });
      this.emit("runQueueMessage", {
        time: new Date(),
        message,
      });
    }
  }

  subscribeToRunNotifications(runFriendlyIds: string[]) {
    console.log("[WorkerSession] Subscribing to run notifications", { runFriendlyIds });

    if (!this.socket) {
      console.error("[WorkerSession] Socket not connected");
      return;
    }

    this.socket.emit("run:subscribe", { version: "1", runFriendlyIds });
  }

  unsubscribeFromRunNotifications(runFriendlyIds: string[]) {
    console.log("[WorkerSession] Unsubscribing from run notifications", { runFriendlyIds });

    if (!this.socket) {
      console.error("[WorkerSession] Socket not connected");
      return;
    }

    this.socket.emit("run:unsubscribe", { version: "1", runFriendlyIds });
  }

  private createSocket() {
    const wsUrl = new URL(this.opts.apiUrl);
    wsUrl.pathname = "/worker";

    this.socket = io(wsUrl.href, {
      transports: ["websocket"],
      extraHeaders: getDefaultWorkerHeaders(this.opts),
    });
    this.socket.on("run:notify", ({ version, run }) => {
      console.log("[WorkerSession][WS] Received run notification", { version, run });
      this.emit("runNotification", { time: new Date(), run });
    });
    this.socket.on("connect", () => {
      console.log("[WorkerSession][WS] Connected to platform");
    });
    this.socket.on("connect_error", (error) => {
      console.error("[WorkerSession][WS] Connection error", { error });
    });
    this.socket.on("disconnect", (reason, description) => {
      console.log("[WorkerSession][WS] Disconnected from platform", { reason, description });
    });
  }

  async start() {
    const connect = await this.httpClient.connect({
      metadata: {
        workerVersion: VERSION,
      },
    });

    if (!connect.success) {
      console.error("[WorkerSession][HTTP] Failed to connect", { error: connect.error });
      throw new Error("[WorkerSession][HTTP] Failed to connect");
    }

    const { workerGroup } = connect.data;

    console.log("[WorkerSession][HTTP] Connected to platform", {
      type: workerGroup.type,
      name: workerGroup.name,
    });

    this.queueConsumer.start();
    this.heartbeatService.start();
    this.createSocket();
  }

  async stop() {
    this.heartbeatService.stop();
    this.socket?.disconnect();
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
