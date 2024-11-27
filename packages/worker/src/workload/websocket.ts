import { ZodSocketConnection } from "@trigger.dev/core/v3/zodSocket";
import { PlatformToWorkerMessages, WorkerToPlatformMessages } from "../messages.js";
import { WorkloadClientCommonOptions } from "./types.js";
import { getDefaultWorkloadHeaders } from "./util.js";

type WorkerWebsocketClientOptions = WorkloadClientCommonOptions;

export class WorkerWebsocketClient {
  private readonly defaultHeaders: Record<string, string>;
  private platformSocket?: ZodSocketConnection<
    typeof WorkerToPlatformMessages,
    typeof PlatformToWorkerMessages
  >;

  constructor(private opts: WorkerWebsocketClientOptions) {
    this.defaultHeaders = getDefaultWorkloadHeaders(opts);
  }

  start() {
    const websocketPort = this.getPort(this.opts.workerApiUrl);
    this.platformSocket = new ZodSocketConnection({
      namespace: "worker",
      host: this.getHost(this.opts.workerApiUrl),
      port: websocketPort,
      secure: websocketPort === 443,
      extraHeaders: this.defaultHeaders,
      clientMessages: WorkerToPlatformMessages,
      serverMessages: PlatformToWorkerMessages,
      handlers: {},
    });
  }

  stop() {
    this.platformSocket?.close();
  }

  private getHost(apiUrl: string): string {
    const url = new URL(apiUrl);
    return url.hostname;
  }

  private getPort(apiUrl: string): number {
    const url = new URL(apiUrl);
    const port = Number(url.port);

    if (!isNaN(port) && port !== 0) {
      return port;
    }

    return url.protocol === "https" ? 443 : 80;
  }
}
