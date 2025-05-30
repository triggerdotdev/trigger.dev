import { SupervisorHttpClient } from "./http.js";
import { PreDequeueFn, PreSkipFn, SupervisorClientCommonOptions } from "./types.js";
import { WorkerApiDequeueResponseBody, WorkerApiHeartbeatRequestBody } from "./schemas.js";
import { RunQueueConsumer } from "./queueConsumer.js";
import { WorkerEvents } from "./events.js";
import EventEmitter from "events";
import { VERSION } from "../../../version.js";
import { io, Socket } from "socket.io-client";
import { WorkerClientToServerEvents, WorkerServerToClientEvents } from "../types.js";
import { getDefaultWorkerHeaders } from "./util.js";
import { IntervalService } from "../../utils/interval.js";
import { SimpleStructuredLogger } from "../../utils/structuredLogger.js";

type SupervisorSessionOptions = SupervisorClientCommonOptions & {
  queueConsumerEnabled?: boolean;
  runNotificationsEnabled?: boolean;
  heartbeatIntervalSeconds: number;
  dequeueIntervalMs: number;
  dequeueIdleIntervalMs: number;
  preDequeue?: PreDequeueFn;
  preSkip?: PreSkipFn;
  maxRunCount?: number;
  maxConsumerCount?: number;
  sendRunDebugLogs?: boolean;
};

export class SupervisorSession extends EventEmitter<WorkerEvents> {
  public readonly httpClient: SupervisorHttpClient;

  private readonly logger = new SimpleStructuredLogger("supervisor-session");

  private readonly runNotificationsEnabled: boolean;
  private runNotificationsSocket?: Socket<WorkerServerToClientEvents, WorkerClientToServerEvents>;

  private readonly queueConsumerEnabled: boolean;
  private readonly queueConsumers: RunQueueConsumer[];

  private readonly heartbeat: IntervalService;

  constructor(private opts: SupervisorSessionOptions) {
    super();

    this.runNotificationsEnabled = opts.runNotificationsEnabled ?? true;
    this.queueConsumerEnabled = opts.queueConsumerEnabled ?? true;

    this.httpClient = new SupervisorHttpClient(opts);
    this.queueConsumers = Array.from({ length: opts.maxConsumerCount ?? 1 }, () => {
      return new RunQueueConsumer({
        client: this.httpClient,
        preDequeue: opts.preDequeue,
        preSkip: opts.preSkip,
        onDequeue: this.onDequeue.bind(this),
        intervalMs: opts.dequeueIntervalMs,
        idleIntervalMs: opts.dequeueIdleIntervalMs,
        maxRunCount: opts.maxRunCount,
      });
    });

    this.heartbeat = new IntervalService({
      onInterval: async () => {
        this.logger.debug("Sending heartbeat");

        const body = this.getHeartbeatBody();
        const response = await this.httpClient.heartbeatWorker(body);

        if (!response.success) {
          this.logger.error("Heartbeat failed", { error: response.error });
        }
      },
      intervalMs: opts.heartbeatIntervalSeconds * 1000,
      leadingEdge: false,
      onError: async (error) => {
        this.logger.error("Failed to send heartbeat", { error });
      },
    });
  }

  private async onDequeue(messages: WorkerApiDequeueResponseBody): Promise<void> {
    this.logger.verbose("Dequeued messages with contents", { count: messages.length, messages });

    for (const message of messages) {
      this.emit("runQueueMessage", {
        time: new Date(),
        message,
      });
    }
  }

  subscribeToRunNotifications(runFriendlyIds: string[]) {
    this.logger.debug("Subscribing to run notifications", { runFriendlyIds });

    if (!this.runNotificationsSocket) {
      this.logger.error("Socket not connected");
      return;
    }

    this.runNotificationsSocket.emit("run:subscribe", { version: "1", runFriendlyIds });

    Promise.allSettled(
      runFriendlyIds.map((runFriendlyId) =>
        this.httpClient.sendDebugLog(runFriendlyId, {
          time: new Date(),
          message: "run:subscribe supervisor -> platform",
        })
      )
    );
  }

  unsubscribeFromRunNotifications(runFriendlyIds: string[]) {
    this.logger.debug("Unsubscribing from run notifications", { runFriendlyIds });

    if (!this.runNotificationsSocket) {
      this.logger.error("Socket not connected");
      return;
    }

    this.runNotificationsSocket.emit("run:unsubscribe", { version: "1", runFriendlyIds });

    Promise.allSettled(
      runFriendlyIds.map((runFriendlyId) =>
        this.httpClient.sendDebugLog(runFriendlyId, {
          time: new Date(),
          message: "run:unsubscribe supervisor -> platform",
          properties: {
            runFriendlyIds,
          },
        })
      )
    );
  }

  private createRunNotificationsSocket() {
    const wsUrl = new URL(this.opts.apiUrl);
    wsUrl.pathname = "/worker";

    const socket = io(wsUrl.href, {
      transports: ["websocket"],
      extraHeaders: getDefaultWorkerHeaders(this.opts),
    });
    socket.on("run:notify", ({ version, run }) => {
      this.logger.debug("[WS] Received run notification", { version, run });
      this.emit("runNotification", { time: new Date(), run });

      this.httpClient.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: "run:notify received by supervisor",
      });
    });
    socket.on("connect", () => {
      this.logger.log("[WS] Connected to platform");
    });
    socket.on("connect_error", (error) => {
      this.logger.error("[WS] Connection error", { error });
    });
    socket.on("disconnect", (reason, description) => {
      this.logger.log("[WS] Disconnected from platform", { reason, description });
    });

    return socket;
  }

  async start() {
    const connect = await this.httpClient.connect({
      metadata: {
        workerVersion: VERSION,
      },
    });

    if (!connect.success) {
      this.logger.error("Failed to connect", { error: connect.error });
      throw new Error("[SupervisorSession]Failed to connect");
    }

    const { workerGroup } = connect.data;

    this.logger.log("Connected to platform", {
      type: workerGroup.type,
      name: workerGroup.name,
    });

    if (this.queueConsumerEnabled) {
      this.logger.log("Queue consumer enabled");
      await Promise.allSettled(this.queueConsumers.map(async (q) => q.start()));
      this.heartbeat.start();
    } else {
      this.logger.warn("Queue consumer disabled");
    }

    if (this.runNotificationsEnabled) {
      this.logger.log("Run notifications enabled");
      this.runNotificationsSocket = this.createRunNotificationsSocket();
    } else {
      this.logger.warn("Run notifications disabled");
    }
  }

  async stop() {
    await Promise.allSettled(this.queueConsumers.map(async (q) => q.stop()));
    this.heartbeat.stop();
    this.runNotificationsSocket?.disconnect();
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
