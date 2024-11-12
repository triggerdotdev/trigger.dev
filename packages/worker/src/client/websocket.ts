import { ZodSocketConnection } from "@trigger.dev/core/v3/zodSocket";
import { PlatformToWorkerMessages, WorkerToPlatformMessages } from "../messages.js";
import { WorkerClientCommonOptions } from "./types.js";
import { getDefaultHeaders } from "./util.js";

type WorkerWebsocketClientOptions = WorkerClientCommonOptions;

export class WorkerWebsocketClient {
  private readonly defaultHeaders: Record<string, string>;
  private platformSocket?: ZodSocketConnection<
    typeof WorkerToPlatformMessages,
    typeof PlatformToWorkerMessages
  >;

  constructor(private opts: WorkerWebsocketClientOptions) {
    this.defaultHeaders = getDefaultHeaders(opts);
  }

  start() {
    const websocketPort = this.getPort(this.opts.apiUrl);
    this.platformSocket = new ZodSocketConnection({
      namespace: "worker",
      host: this.getHost(this.opts.apiUrl),
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
