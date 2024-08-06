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

export class HttpReply {
  constructor(private response: Parameters<RequestListener>[1]) {}

  empty(status?: number) {
    return this.response.writeHead(status ?? 200).end();
  }

  text(text: string, status?: number, contentType?: string) {
    return this.response
      .writeHead(status ?? 200, { "Content-Type": contentType || "text/plain" })
      .end(text.endsWith("\n") ? text : `${text}\n`);
  }

  json(value: any, pretty?: boolean) {
    return this.text(
      JSON.stringify(value, undefined, pretty ? 2 : undefined),
      200,
      "application/json"
    );
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
