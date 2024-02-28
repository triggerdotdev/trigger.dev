import { IncomingMessage, RequestListener } from "http";

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
}
