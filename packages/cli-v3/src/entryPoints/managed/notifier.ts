import type { SupervisorSocket } from "./controller.js";
import type { RunLogger, SendDebugLogOptions } from "./logger.js";

type OnNotify = (source: string) => Promise<void>;

type RunNotifierOptions = {
  runFriendlyId: string;
  supervisorSocket: SupervisorSocket;
  onNotify: OnNotify;
  logger: RunLogger;
};

export class RunNotifier {
  private runFriendlyId: string;
  private socket: SupervisorSocket;
  private onNotify: OnNotify;
  private logger: RunLogger;

  private lastNotificationAt: Date | null = null;
  private notificationCount = 0;

  private lastInvalidNotificationAt: Date | null = null;
  private invalidNotificationCount = 0;

  constructor(opts: RunNotifierOptions) {
    this.runFriendlyId = opts.runFriendlyId;
    this.socket = opts.supervisorSocket;
    this.onNotify = opts.onNotify;
    this.logger = opts.logger;
  }

  start(): RunNotifier {
    this.sendDebugLog("start");

    this.socket.on("run:notify", async ({ version, run }) => {
      // Generate a unique ID for the notification
      const notificationId = Math.random().toString(36).substring(2, 15);

      // Use this to track the notification incl. any processing
      const notification = {
        id: notificationId,
        runId: run.friendlyId,
        version,
      };

      if (run.friendlyId !== this.runFriendlyId) {
        this.sendDebugLog("run:notify received invalid notification", { notification });

        this.invalidNotificationCount++;
        this.lastInvalidNotificationAt = new Date();

        return;
      }

      this.sendDebugLog("run:notify received by runner", { notification });

      this.notificationCount++;
      this.lastNotificationAt = new Date();

      await this.onNotify(`notifier:${notificationId}`);
    });

    return this;
  }

  stop() {
    this.sendDebugLog("stop");
    this.socket.removeAllListeners("run:notify");
  }

  get metrics() {
    return {
      lastNotificationAt: this.lastNotificationAt,
      notificationCount: this.notificationCount,
      lastInvalidNotificationAt: this.lastInvalidNotificationAt,
      invalidNotificationCount: this.invalidNotificationCount,
    };
  }

  private sendDebugLog(message: string, properties?: SendDebugLogOptions["properties"]) {
    this.logger?.sendDebugLog({
      message: `[notifier] ${message}`,
      properties: {
        ...properties,
        ...this.metrics,
      },
    });
  }
}
