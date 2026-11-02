import { SupervisorHttpClient } from "./http.js";
import type { WeightedWorkerQueueSubscription } from "../workerQueue.js";
import type { PreDequeueFn, PreSkipFn, SupervisorClientCommonOptions } from "./types.js";
import type {
  WorkerApiDequeueResponseBody,
  WorkerApiHeartbeatRequestBody,
  WorkerQueueClass,
} from "./schemas.js";
import type { ScalingOptions } from "./consumerPool.js";
import { RunQueueConsumerPool } from "./consumerPool.js";
import type { WorkerEvents } from "./events.js";
import EventEmitter from "events";
import { VERSION } from "../../../version.js";
import type { Socket } from "socket.io-client";
import { io } from "socket.io-client";
import type { WorkerClientToServerEvents, WorkerServerToClientEvents } from "../types.js";
import { getDefaultWorkerHeaders } from "./util.js";
import { IntervalService } from "../../utils/interval.js";
import { SimpleStructuredLogger } from "../../utils/structuredLogger.js";
import type { Registry } from "prom-client";

type SupervisorSessionOptions = SupervisorClientCommonOptions & {
  queueConsumerEnabled?: boolean;
  runNotificationsEnabled?: boolean;
  heartbeatIntervalSeconds: number;
  dequeueIntervalMs: number;
  dequeueIdleIntervalMs: number;
  preDequeue?: PreDequeueFn;
  preSkip?: PreSkipFn;
  /** Which worker-queue class this supervisor's consumers pull from. Defaults to the region queue. */
  queueClass?: WorkerQueueClass;
  subscriptions?: WeightedWorkerQueueSubscription[];
  sendRunDebugLogs?: boolean;
  scaling: ScalingOptions;
  metricsRegistry?: Registry;
  /** Extra worker instance metadata sent on connect. */
  metadata?: Record<string, unknown>;
};

const RECONNECT_DELAY_MS = 1_000;
const RECONNECT_DELAY_MAX_MS = 30_000;

export class SupervisorSession extends EventEmitter<WorkerEvents> {
  public readonly httpClient: SupervisorHttpClient;

  private readonly logger = new SimpleStructuredLogger("supervisor-session");

  private readonly runNotificationsEnabled: boolean;
  private runNotificationsSocket?: Socket<WorkerServerToClientEvents, WorkerClientToServerEvents>;
  /** The runs subscribed to, asked for again on every connection: the platform keeps subscriptions per connection. */
  private readonly runSubscriptions = new Set<string>();
  private reconnectDelayMs = RECONNECT_DELAY_MS;

  private readonly queueConsumerEnabled: boolean;
  private readonly consumerPool: RunQueueConsumerPool;

  private readonly heartbeat: IntervalService;

  constructor(private opts: SupervisorSessionOptions) {
    super();

    this.runNotificationsEnabled = opts.runNotificationsEnabled ?? true;
    this.queueConsumerEnabled = opts.queueConsumerEnabled ?? true;

    this.httpClient = new SupervisorHttpClient(opts);

    this.consumerPool = new RunQueueConsumerPool({
      consumer: {
        client: this.httpClient,
        preDequeue: opts.preDequeue,
        preSkip: opts.preSkip,
        onDequeue: this.onDequeue.bind(this),
        intervalMs: opts.dequeueIntervalMs,
        idleIntervalMs: opts.dequeueIdleIntervalMs,
        queueClass: opts.queueClass,
        subscriptions: opts.subscriptions,
      },
      scaling: opts.scaling,
      metricsRegistry: opts.metricsRegistry,
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

  private async onDequeue(
    messages: WorkerApiDequeueResponseBody,
    timing?: { dequeueResponseMs: number; pollingIntervalMs: number }
  ): Promise<void> {
    this.logger.verbose("Dequeued messages with contents", { count: messages.length, messages });

    for (const message of messages) {
      this.emit("runQueueMessage", {
        time: new Date(),
        message,
        dequeueResponseMs: timing?.dequeueResponseMs,
        pollingIntervalMs: timing?.pollingIntervalMs,
      });
    }
  }

  subscribeToRunNotifications(runFriendlyIds: string[]) {
    this.logger.debug("Subscribing to run notifications", { runFriendlyIds });

    for (const runFriendlyId of runFriendlyIds) {
      this.runSubscriptions.add(runFriendlyId);
    }

    // Not connected, the connect handler asks for the whole set; asking here too would ask twice.
    if (!this.runNotificationsSocket?.connected) {
      return;
    }

    this.subscribe(this.runNotificationsSocket, runFriendlyIds);

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

    for (const runFriendlyId of runFriendlyIds) {
      this.runSubscriptions.delete(runFriendlyId);
    }

    if (!this.runNotificationsSocket?.connected) {
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

  private subscribe(
    socket: Socket<WorkerServerToClientEvents, WorkerClientToServerEvents>,
    runFriendlyIds: string[]
  ) {
    socket.emit("run:subscribe", { version: "1", runFriendlyIds });
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
      this.reconnectDelayMs = RECONNECT_DELAY_MS;
      if (this.runSubscriptions.size > 0) {
        this.logger.log("[WS] Subscribing to run notifications on connect", {
          runs: this.runSubscriptions.size,
        });
        this.subscribe(socket, [...this.runSubscriptions]);
      }
    });
    socket.on("connect_error", (error) => {
      this.logger.error("[WS] Connection error", { error });
      this.reconnectIfGivenUp(socket);
    });
    socket.on("disconnect", (reason, description) => {
      this.logger.log("[WS] Disconnected from platform", { reason, description });
      this.reconnectIfGivenUp(socket);
    });

    return socket;
  }

  /** socket.io stops after the platform rejects a handshake or disconnects the socket; the session does not. */
  private reconnectIfGivenUp(
    socket: Socket<WorkerServerToClientEvents, WorkerClientToServerEvents>
  ) {
    if (socket.active || this.runNotificationsSocket !== socket) {
      return;
    }
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delayMs * 2, RECONNECT_DELAY_MAX_MS);
    this.logger.log("[WS] Connecting to platform again", { delayMs });
    setTimeout(() => {
      if (this.runNotificationsSocket === socket) {
        socket.connect();
      }
    }, delayMs).unref();
  }

  async start() {
    const connect = await this.httpClient.connect({
      metadata: {
        ...this.opts.metadata,
        workerVersion: VERSION,
      },
    });

    if (!connect.success) {
      this.logger.error("Failed to connect", { error: connect.error });
      throw new Error("[SupervisorSession] Failed to connect");
    }

    const { workerGroup } = connect.data;

    this.logger.log("Connected to platform", {
      type: workerGroup.type,
      name: workerGroup.name,
    });

    if (this.queueConsumerEnabled) {
      this.logger.log("Queue consumer enabled", {
        scalingStrategy: this.consumerPool["scalingStrategy"],
        minConsumers: this.consumerPool["minConsumerCount"],
        maxConsumers: this.consumerPool["maxConsumerCount"],
      });

      await this.consumerPool.start();
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
    await this.consumerPool.stop();
    this.heartbeat.stop();
    const socket = this.runNotificationsSocket;
    this.runNotificationsSocket = undefined;
    socket?.disconnect();
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
