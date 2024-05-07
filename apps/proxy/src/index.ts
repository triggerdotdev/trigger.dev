import { queueEvent } from "./events/queueEvent";
import { queueEvents } from "./events/queueEvents";

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
    console.log("url", request.url);

    if (!queueingIsEnabled(env)) {
      console.log("Missing AWS credentials. Passing through to the origin.");
      return redirectToOrigin(request, env);
    }

    const url = new URL(request.url);
    switch (url.pathname) {
      case "/api/v1/events": {
        if (request.method === "POST") {
          return queueEvent(request, env);
        }
        break;
      }
      case "/api/v1/events/bulk": {
        if (request.method === "POST") {
          return queueEvents(request, env);
        }
        break;
      }
    }

    //the same request but with the hostname (and port) changed
    return redirectToOrigin(request, env);
  },
};

function redirectToOrigin(request: Request, env: Env) {
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
}

function queueingIsEnabled(env: Env) {
  return (
    env.AWS_SQS_ACCESS_KEY_ID &&
    env.AWS_SQS_SECRET_ACCESS_KEY &&
    env.AWS_SQS_QUEUE_URL &&
    env.AWS_SQS_REGION
  );
}
