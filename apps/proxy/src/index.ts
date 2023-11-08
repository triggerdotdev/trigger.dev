import { queueEvent } from "./queueEvent";

export interface Env {}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/v1/events" && request.method === "POST") {
      return queueEvent(request);
    }

    return fetch(request);
  },
};
