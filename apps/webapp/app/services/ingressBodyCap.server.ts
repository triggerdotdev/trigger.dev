import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  MAX_MESSAGE_BODY_BYTES,
  MESSAGE_TOO_LARGE_CODE,
  MESSAGE_TOO_LARGE_ERROR,
} from "~/components/dashboard-agent/message-limits";
import { getRouterPath } from "~/utils/sanitizeHttpUrl";

/**
 * Ingress body caps for paths whose routes buffer the whole body. A route can only refuse a body
 * after it has read it, and `content-length` is optional, so a chunked upload would be buffered
 * whole before the route ever saw its size. This counts the bytes as they arrive and refuses
 * mid-stream.
 */
export type IngressBodyCap = {
  path: RegExp;
  limitBytes: number;
  refuse: (res: Response) => void;
};

/** Headroom over the message cap for multipart framing and the per-turn metadata. */
const INGRESS_SLACK_BYTES = 8 * 1024;

export const DASHBOARD_AGENT_MAX_INGRESS_BYTES = MAX_MESSAGE_BODY_BYTES + INGRESS_SLACK_BYTES;

export const DASHBOARD_AGENT_INGRESS_CAP: IngressBodyCap = {
  path: /^(?:\/api\/v1\/dashboard-agent|\/resources\/orgs\/[^/]+\/projects\/[^/]+\/env\/[^/]+\/dashboard-agent)(\/|$)/,
  limitBytes: DASHBOARD_AGENT_MAX_INGRESS_BYTES,
  refuse: (res) =>
    res.status(413).json({ error: MESSAGE_TOO_LARGE_ERROR, code: MESSAGE_TOO_LARGE_CODE }),
};

export function otlpIngressCap(limitBytes: number): IngressBodyCap {
  return {
    path: /^\/otel(\/|$)/,
    limitBytes,
    refuse: (res) => res.status(413).json({ error: "Request body too large" }),
  };
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function capRequestBody(req: Request, res: Response, cap: IngressBodyCap): void {
  const refuse = () => {
    if (!res.headersSent) cap.refuse(res);
  };

  const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > cap.limitBytes) {
    refuse();
    return;
  }

  let received = 0;
  const onData = (chunk: Buffer | string) => {
    received += Buffer.byteLength(chunk);
    if (received <= cap.limitBytes) return;
    req.removeAllListeners("data");
    req.pause();
    refuse();
    if (res.writableFinished) req.destroy();
    else res.once("finish", () => req.destroy()); // after the 413 is sent, or the client never reads it
  };

  req.on("data", onData);
  req.pause();
  req.once("end", () => req.off("data", onData));
}

export function createIngressBodyCap(caps: IngressBodyCap[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!BODY_METHODS.has(req.method)) {
      next();
      return;
    }

    const routerPath = getRouterPath(req) ?? "";
    const cap = caps.find((c) => c.path.test(routerPath));
    if (!cap) {
      next();
      return;
    }

    capRequestBody(req, res, cap);
    if (res.headersSent) return;
    next();
  };
}
