import { queueEvent } from "./queueEvent";

export interface Env {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_SQS_QUEUE_URL: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/v1/events" && request.method === "POST") {
      if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_SQS_QUEUE_URL) {
        return queueEvent(request);
      } else {
        console.log("/api/v1/events. Missing AWS credentials", request);
      }
    }

    return fetch(request);
  },
};
