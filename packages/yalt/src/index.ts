import { z } from "zod";
import { WebSocket } from "partysocket";
import node_fetch, {
  RequestInfo as _RequestInfo,
  RequestInit as _RequestInit,
  Response,
} from "node-fetch";
import { ProxyAgent } from "proxy-agent";
import https from "https";

export const RequestMesssage = z.object({
  type: z.literal("request"),
  id: z.string(),
  headers: z.record(z.string()),
  method: z.string(),
  url: z.string(),
  body: z.string(),
  https: z.boolean().default(false).optional(),
});

export type RequestMessage = z.infer<typeof RequestMesssage>;

export const ResponseMessage = z.object({
  type: z.literal("response"),
  id: z.string(),
  status: z.number(),
  headers: z.record(z.string()),
  body: z.string(),
});

export type ResponseMessage = z.infer<typeof ResponseMessage>;

export const ClientMessages = z.discriminatedUnion("type", [ResponseMessage]);
export const ServerMessages = z.discriminatedUnion("type", [RequestMesssage]);

export type ClientMessage = z.infer<typeof ClientMessages>;
export type ServerMessage = z.infer<typeof ServerMessages>;

export type RequestInfo = _RequestInfo;
export type RequestInit = _RequestInit;

export async function createRequestMessage(id: string, request: Request): Promise<RequestMessage> {
  const { headers, method, url } = request;

  const body = await request.text();

  return {
    type: "request",
    id,
    headers: stripHeaders(Object.fromEntries(headers)),
    method,
    url,
    body,
  };
}

async function createResponseMessage(id: string, response: Response): Promise<ResponseMessage> {
  const { headers, status } = response;

  const body = await response.text();

  return {
    type: "response",
    id,
    headers: Object.fromEntries(headers),
    status,
    body,
  };
}

export class YaltApiClient {
  constructor(
    private host: string,
    private apiKey: string
  ) {}

  async createTunnel(): Promise<string> {
    const response = await fetch(`https://admin.${this.host}/api/tunnels`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Could not create tunnel: ${response.status}`);
    }

    const body = (await response.json()) as any;

    return body.id;
  }

  connectUrl(id: string): string {
    return `${id}.${this.host}`;
  }
}

export type YaltTunnelSocketOptions = {
  WebSocket?: any;
  connectionTimeout?: number;
  maxRetries?: number;
};

export type YaltTunnelOptions = {
  verbose?: boolean;
};

export class YaltTunnel {
  socket?: WebSocket;

  constructor(
    private url: string,
    private address: string,
    private https: boolean,
    private socketOptions: YaltTunnelSocketOptions = {},
    private options: YaltTunnelOptions = {}
  ) {}

  private log(message: string, properties: Record<string, any> = {}) {
    if (this.options.verbose) {
      console.log(JSON.stringify({ message, ...properties }));
    }
  }

  async connect() {
    this.log("Connecting to tunnel", {
      url: this.url,
      address: this.address,
      socketOptions: this.socketOptions,
    });

    this.socket = new WebSocket(`wss://${this.url}/connect`, [], this.socketOptions);

    this.socket.addEventListener("open", (args) => {
      this.log("Connected to tunnel");
    });

    this.socket.addEventListener("close", (event) => {
      this.log("Disconnected from tunnel", { event: event.code, reason: event.reason });
    });

    this.socket.addEventListener("message", async (event) => {
      const data = JSON.parse(
        typeof event.data === "string" ? event.data : new TextDecoder("utf-8").decode(event.data)
      );

      const message = ServerMessages.safeParse(data);

      if (!message.success) {
        this.log("Received invalid message", { data });
        return;
      }

      switch (message.data.type) {
        case "request": {
          await this.handleRequest(message.data);

          break;
        }
        default: {
          console.error(`Unknown message type: ${message.data.type}`);
        }
      }
    });

    this.socket.addEventListener("error", (event) => {
      this.log("Socket error", { error: event.message });
    });
  }

  private async handleRequest(request: RequestMessage) {
    if (!this.socket) {
      throw new Error("Socket is not connected");
    }

    const url = new URL(request.url);
    // Construct the original url to be the same as the request URL but with a different hostname and using http instead of https
    const originalUrl = new URL(
      `${this.https ? "https" : "http"}://${this.address}${url.pathname}${url.search}${url.hash}`
    );

    let response: Response | null = null;

    this.log("Sending local request", {
      originalUrl: originalUrl.href,
      requestId: request.id,
      headers: request.headers,
    });

    try {
      const agent = new https.Agent({
        rejectUnauthorized: false, // Ignore self-signed certificates
      });
      response = await fetch(originalUrl.href, {
        method: request.method,
        headers: stripHeaders(request.headers),
        body: request.body,
        ...(this.https && { agent }),
      });
    } catch (error) {
      if (error instanceof Error) {
        this.log("Error sending local request", {
          error: error.message,
          name: error.name,
          stack: error.stack,
          requestId: request.id,
          cause: "cause" in error ? error.cause : undefined,
        });
      } else {
        this.log("Error sending local request", { error, requestId: request.id });
      }

      // Return a 502 response
      response = new Response(
        JSON.stringify({
          message: `Could not connect to ${originalUrl.href}. Make sure you are running your local app server`,
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      await this.sendResponse(request.id, response, this.socket);
    } catch (error) {
      console.error(error);
    }
  }

  private async sendResponse(id: string, response: Response, socket: WebSocket) {
    const message = await createResponseMessage(id, response);

    this.log("Sending response", { requestId: id, status: response.status });

    return socket.send(JSON.stringify(message));
  }
}

// Remove headers that should not be included like connection, host, etc
function stripHeaders(headers: Record<string, string>) {
  const blacklistHeaders = [
    "connection",
    "cf-ray",
    "cf-connecting-ip",
    "host",
    "cf-ipcountry",
    "content-length",
  ];

  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !blacklistHeaders.includes(key.toLowerCase()))
  );
}

function fetch(url: RequestInfo, init?: RequestInit) {
  const fetchInit: RequestInit = { ...init };

  // If agent is not specified, specify proxy-agent and use environment variables such as HTTPS_PROXY.
  if (!fetchInit.agent) {
    fetchInit.agent = new ProxyAgent();
  }

  return node_fetch(url, fetchInit);
}
