import { queueEvent } from "./queueEvent";

export interface Env {
  /** The hostname needs to be changed to allow requests to pass to the Trigger.dev platform */
  REWRITE_HOSTNAME: string;
  REWRITE_PORT?: string;
  AWS_SQS_ACCESS_KEY_ID: string;
  AWS_SQS_SECRET_ACCESS_KEY: string;
  AWS_SQS_QUEUE_URL: string;
  AWS_SQS_REGION: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.REWRITE_HOSTNAME) throw new Error("Missing REWRITE_HOSTNAME");

    const url = new URL(request.url);
    console.log("url", url.toString());

    if (url.pathname === "/api/v1/events" && request.method === "POST") {
      if (env.AWS_SQS_ACCESS_KEY_ID && env.AWS_SQS_SECRET_ACCESS_KEY && env.AWS_SQS_QUEUE_URL) {
        return queueEvent(request, env);
      } else {
        console.log("/api/v1/events. Missing AWS credentials. Passing through to the origin.");
      }
    }

    //the same request but with the hostname (and port) changed
    const newUrl = new URL(request.url);
    newUrl.hostname = env.REWRITE_HOSTNAME;
    newUrl.port = env.REWRITE_PORT || newUrl.port;

    const requestInit: RequestInit = {
      method: request.method,
      headers: request.headers,
      body: request.body,
    };

    console.log("rewritten url", newUrl.toString());
    return fetch(newUrl.toString(), requestInit);
  },
};
