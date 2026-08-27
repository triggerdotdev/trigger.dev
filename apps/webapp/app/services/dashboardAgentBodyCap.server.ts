import type { NextFunction, Request, Response } from "express";
import {
  MAX_MESSAGE_BODY_BYTES,
  MESSAGE_TOO_LARGE_CODE,
  MESSAGE_TOO_LARGE_ERROR,
} from "~/components/dashboard-agent/message-limits";
import { MAX_AVATAR_SIZE_IN_BYTES } from "~/utils/avatarLimits";

/**
 * The ingress cap for the agent's chat paths. A route can only refuse a body after it has read
 * it, and `content-length` is optional, so a chunked upload would be buffered whole before the
 * route ever saw its size. This counts the bytes as they arrive and refuses mid-stream.
 */

/** Headroom over the message cap for multipart framing and the per-turn metadata. */
const INGRESS_SLACK_BYTES = 8 * 1024;

export const DASHBOARD_AGENT_MAX_INGRESS_BYTES = MAX_MESSAGE_BODY_BYTES + INGRESS_SLACK_BYTES;

// The agent's own routes only: the `/api/v1/dashboard-agent/…` endpoints and the
// `/resources/orgs/…/env/<env>/dashboard-agent…` chat resources. Both alternatives are
// anchored, so neither a task named `dashboard-agent`
// (`/api/v1/tasks/dashboard-agent/trigger`) nor a lookalike mid-path segment is capped.
const AGENT_PATH =
  /^(?:\/api\/v1\/dashboard-agent|\/resources\/orgs\/[^/]+\/projects\/[^/]+\/env\/[^/]+\/dashboard-agent)(\/|$)/;

/** Headroom over the avatar cap: multipart framing, part headers and the crop metadata. */
const AVATAR_INGRESS_SLACK_BYTES = 64 * 1024;

export const AVATAR_MAX_INGRESS_BYTES = MAX_AVATAR_SIZE_IN_BYTES + AVATAR_INGRESS_SLACK_BYTES;

/** The avatar upload only: the presigned-redirect routes below it take two more segments. */
const AVATAR_PATH = /^\/resources\/account\/avatar\/*$/;

/** Methods that can carry one. GET and HEAD cannot, and streaming them would be wasted work. */
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type Cap = {
  limit: number;
  body: { error: string; code?: string };
};

const AGENT_CAP: Cap = {
  limit: DASHBOARD_AGENT_MAX_INGRESS_BYTES,
  body: { error: MESSAGE_TOO_LARGE_ERROR, code: MESSAGE_TOO_LARGE_CODE },
};

const AVATAR_CAP: Cap = {
  limit: AVATAR_MAX_INGRESS_BYTES,
  body: { error: "Image is too large" },
};

/**
 * Matched against the path Remix will route, not the raw one: the express adapter rebuilds the
 * request as `new URL(origin + originalUrl)`, so `/…/avatar/.` reaches the action as `/…/avatar/`.
 * Built the same way here, or a protocol-relative path would normalize to a different one.
 */
function pathToMatch(req: Request): string {
  try {
    return new URL(`http://localhost${req.originalUrl || req.url}`).pathname.toLowerCase();
  } catch {
    return req.path.toLowerCase();
  }
}

function capForPath(path: string): Cap | undefined {
  if (AGENT_PATH.test(path)) return AGENT_CAP;
  if (AVATAR_PATH.test(path)) return AVATAR_CAP;
  return undefined;
}

function refuse(res: Response, cap: Cap): void {
  if (res.headersSent) return;
  res.status(413).json(cap.body);
}

/**
 * Attaches a counting listener and pauses the stream again immediately, so the route's own
 * reader still receives every chunk while nothing flows until it asks for it. Crossing the
 * limit ends the request: pausing alone wouldn't stop the route resuming the stream itself.
 */
function capRequestBody(req: Request, res: Response, cap: Cap): void {
  const { limit } = cap;
  const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > limit) {
    refuse(res, cap);
    return;
  }

  let received = 0;
  const onData = (chunk: Buffer | string) => {
    received += Buffer.byteLength(chunk);
    if (received <= limit) return;
    req.off("data", onData);
    req.pause();
    refuse(res, cap);
    // Torn down only once the refusal is on the wire, or the client never reads it.
    res.once("finish", () => req.destroy());
  };

  req.on("data", onData);
  req.pause();
  req.once("end", () => req.off("data", onData));
}

/**
 * Only the capped paths: every other route keeps the body handling it had. Matched
 * case-insensitively because Remix routes are, and on every method — a DELETE reads a body too.
 */
export function dashboardAgentBodyCap(req: Request, res: Response, next: NextFunction): void {
  const cap = BODY_METHODS.has(req.method) ? capForPath(pathToMatch(req)) : undefined;

  if (!cap) {
    next();
    return;
  }

  capRequestBody(req, res, cap);
  if (res.headersSent) return;
  next();
}
