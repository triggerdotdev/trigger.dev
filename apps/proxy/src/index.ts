import { queueEvent } from "./events/queueEvent";
import { queueEvents } from "./events/queueEvents";
import { applyRateLimit } from "./rateLimit";
import { Ratelimit } from "./rateLimiter";

export interface Env {
  /** The hostname needs to be changed to allow requests to pass to the Trigger.dev platform */
  REWRITE_HOSTNAME: string;
  REWRITE_PORT?: string;
  AWS_SQS_ACCESS_KEY_ID: string;
  AWS_SQS_SECRET_ACCESS_KEY: string;
  AWS_SQS_QUEUE_URL: string;
  AWS_SQS_REGION: string;
  //rate limiter
  API_RATE_LIMITER: Ratelimit;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!queueingIsEnabled(env)) {
      console.log("Missing AWS credentials. Passing through to the origin.");
      return fetch(request);
    }

    const url = new URL(request.url);
    switch (url.pathname) {
      case "/api/v1/events": {
        if (request.method === "POST") {
          return applyRateLimit(request, env, () => queueEvent(request, env));
        }
        break;
      }
      case "/api/v1/events/bulk": {
        if (request.method === "POST") {
          return applyRateLimit(request, env, () => queueEvents(request, env));
        }
        break;
      }
    }

    //the same request but with the hostname (and port) changed
    return fetch(request);
  },
};

function queueingIsEnabled(env: Env) {
  return (
    env.AWS_SQS_ACCESS_KEY_ID &&
    env.AWS_SQS_SECRET_ACCESS_KEY &&
    env.AWS_SQS_QUEUE_URL &&
    env.AWS_SQS_REGION
  );
}
