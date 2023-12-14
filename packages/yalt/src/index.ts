import { z } from "zod";
import { WebSocket } from "partysocket";

export const RequestMesssage = z.object({
  type: z.literal("request"),
  id: z.string(),
  headers: z.record(z.string()),
  method: z.string(),
  url: z.string(),
  body: z.string(),
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

export async function createRequestMessage(id: string, request: Request): Promise<RequestMessage> {
  const { headers, method, url } = request;

  const body = await request.text();

  return {
    type: "request",
    id,
    headers: Object.fromEntries(headers),
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

    const body = await response.json();

    return body.id;
  }

  connectUrl(id: string): string {
    return `${id}.${this.host}`;
  }
}

export type YaltTunnelOptions = {
  WebSocket?: any;
  connectionTimeout?: number;
  maxRetries?: number;
};
export class YaltTunnel {
  socket?: WebSocket;

  constructor(
    private url: string,
    private address: string,
    private options: YaltTunnelOptions = {}
  ) {}

  async connect() {
    this.socket = new WebSocket(`wss://${this.url}/connect`, [], this.options);

    this.socket.addEventListener("open", () => {});

    this.socket.addEventListener("close", (event) => {});

    this.socket.addEventListener("message", async (event) => {
      const data = JSON.parse(
        typeof event.data === "string" ? event.data : new TextDecoder("utf-8").decode(event.data)
      );

      const message = ServerMessages.safeParse(data);

      if (!message.success) {
        console.error(message.error);
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
      console.error(event);
    });
  }

  private async handleRequest(request: RequestMessage) {
    if (!this.socket) {
      throw new Error("Socket is not connected");
    }

    const url = new URL(request.url);
    // Construct the original url to be the same as the request URL but with a different hostname and using http instead of https
    const originalUrl = new URL(`http://${this.address}${url.pathname}${url.search}${url.hash}`);

    let response: Response | null = null;

    try {
      response = await fetch(originalUrl.href, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    } catch (error) {
      // Return a 502 response
      response = new Response(
        JSON.stringify({
          message: `Could not connect to ${originalUrl.href}. Make sure you are running your local app server`,
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      await sendResponse(request.id, response, this.socket);
    } catch (error) {
      console.error(error);
    }
  }
}

async function sendResponse(id: string, response: Response, socket: WebSocket) {
  const message = await createResponseMessage(id, response);

  return socket.send(JSON.stringify(message));
}
