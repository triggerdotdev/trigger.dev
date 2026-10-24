import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "content-encoding",
]);

type Fault = {
  match: string;
  afterBatches: number;
  message: string;
  remaining: number;
  status?: number;
};

/**
 * An HTTP proxy that sits between the webapp and s2-lite and can make one SSE
 * read fail the way S2 does when a read session breaks after the response has
 * started: forward `afterBatches` real `batch` events, then send
 * `event: error` and complete the response normally (no `[DONE]`).
 *
 * Every other request passes through untouched. Start it before the webapp
 * (so its URL can go into `REALTIME_STREAMS_S2_ENDPOINT`) and call
 * `setTarget` once s2-lite is up; requests that arrive earlier wait for it.
 */
export class S2FaultProxy {
  private server: Server | undefined;
  private faults: Fault[] = [];
  private resolveTarget!: (endpoint: string) => void;
  private readonly target = new Promise<string>((resolve) => (this.resolveTarget = resolve));

  /** Stream names whose read had an error injected, in order. */
  readonly injected: string[] = [];

  /** Starts listening and returns the base URL to use as the webapp's S2 endpoint. */
  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/v1`;
  }

  /** Points the proxy at s2-lite's base URL (without `/v1`). */
  setTarget(endpoint: string) {
    this.resolveTarget(endpoint.replace(/\/$/, ""));
  }

  /**
   * Fail the next `times` SSE reads (default one) of a stream whose name
   * contains `match`, each after `afterBatches` batch events have been
   * forwarded.
   */
  failNextRead(
    match: string,
    afterBatches: number,
    { times = 1, message = "Reconnection required" }: { times?: number; message?: string } = {}
  ) {
    this.faults.push({ match, afterBatches, message, remaining: times });
  }

  async stop() {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  /** Reject before SSE headers, as when concurrent first reads race to create a stream. */
  rejectNextRead(match: string, status: number, times = 1) {
    this.faults.push({ match, status, remaining: times, afterBatches: 0, message: "" });
  }

  private takeFault(req: IncomingMessage): Fault | undefined {
    const accept = String(req.headers.accept ?? "");
    if (req.method !== "GET" || !accept.includes("text/event-stream")) return undefined;
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://proxy").pathname);
    if (!path.endsWith("/records")) return undefined;
    const index = this.faults.findIndex((fault) => path.includes(fault.match));
    if (index === -1) return undefined;
    const fault = this.faults[index]!;
    fault.remaining--;
    if (fault.remaining <= 0) this.faults.splice(index, 1);
    this.injected.push(path);
    return fault;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const target = await this.target;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    const abort = new AbortController();
    res.on("close", () => abort.abort());

    const fault = this.takeFault(req);
    if (fault?.status) {
      res.writeHead(fault.status).end();
      return;
    }
    const upstream = await fetch(`${target}${req.url}`, {
      method: req.method,
      headers,
      body,
      signal: abort.signal,
    });

    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.has(name)) responseHeaders[name] = value;
    });
    res.writeHead(upstream.status, responseHeaders);

    if (!upstream.body) {
      res.end();
      return;
    }

    if (!fault || !upstream.ok) {
      await pipeline(Readable.fromWeb(upstream.body as never), res).catch(() => {});
      return;
    }

    await this.forwardUntilFault(upstream.body, res, fault);
    abort.abort();
  }

  private async forwardUntilFault(
    body: ReadableStream<Uint8Array>,
    res: ServerResponse,
    fault: Fault
  ) {
    const errorEvent = `event: error\ndata: ${fault.message}\n\n`;
    res.flushHeaders();
    if (fault.afterBatches === 0) {
      res.end(errorEvent);
      await body.cancel().catch(() => {});
      return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let batches = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          res.end(buffer);
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          res.write(`${event}\n\n`);
          if (/^event:\s*batch\s*$/m.test(event)) batches++;
          if (batches >= fault.afterBatches) {
            res.end(errorEvent);
            return;
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}
