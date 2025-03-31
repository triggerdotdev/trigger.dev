import { IncomingMessage, RequestListener } from "node:http";

export const getTextBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    req.on("readable", () => {
      const chunk = req.read();
      if (chunk) {
        body += chunk;
      }
    });
    req.on("end", () => {
      resolve(body);
    });
  });

export async function getJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      resolve(safeJsonParse(body));
    });
  });
}

function safeJsonParse(text: string) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    console.error("Failed to parse JSON", { error, text });
    return null;
  }
}

export class HttpReply {
  constructor(private response: Parameters<RequestListener>[1]) {}

  empty(status?: number) {
    if (this.hasReplied) {
      return;
    }

    return this.response.writeHead(status ?? 200).end();
  }

  text(text: string, status?: number, contentType?: string) {
    if (this.hasReplied) {
      return;
    }

    return this.response
      .writeHead(status ?? 200, { "Content-Type": contentType || "text/plain" })
      .end(text.endsWith("\n") ? text : `${text}\n`);
  }

  json(value: any, pretty?: boolean, status?: number) {
    if (this.hasReplied) {
      return;
    }

    return this.text(
      JSON.stringify(value, undefined, pretty ? 2 : undefined),
      status ?? 200,
      "application/json"
    );
  }

  get hasReplied() {
    return this.response.headersSent;
  }
}

function getRandomInteger(min: number, max: number) {
  const intMin = Math.ceil(min);
  const intMax = Math.floor(max);
  return Math.floor(Math.random() * (intMax - intMin + 1)) + intMin;
}

export function getRandomPortNumber() {
  return getRandomInteger(8000, 9999);
}
