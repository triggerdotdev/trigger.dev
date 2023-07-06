// Parses the body of a request

import { safeJsonParse } from "./json";

// If it's a Buffer, it will be parsed as JSON
export function safeParseBody(body: any) {
  if (Buffer.isBuffer(body)) {
    return safeJsonParse(body.toString());
  }

  if (typeof body === "string") {
    return safeJsonParse(body);
  }

  return body;
}
