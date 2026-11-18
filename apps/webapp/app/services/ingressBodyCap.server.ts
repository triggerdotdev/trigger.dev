import { matchRoutes, type AgnosticRouteObject } from "@remix-run/router";
import { OFFLOAD_IO_PACKET_LENGTH_LIMIT } from "@trigger.dev/core/v3";
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import {
  MAX_MESSAGE_BODY_BYTES,
  MESSAGE_TOO_LARGE_CODE,
  MESSAGE_TOO_LARGE_ERROR,
} from "~/components/dashboard-agent/message-limits";
import { getRouterPath } from "~/utils/sanitizeHttpUrl";

/**
 * Request body limits, applied before the Remix handler. A route can only refuse a body after it
 * has read it, and `content-length` is optional, so this counts the bytes as they arrive and
 * refuses mid-stream. Every request Remix reads a body from gets the default limit; a route that
 * takes more (or less) is listed with its own.
 */
export type IngressBodyCap = {
  /** Names the limit in logs and metrics. */
  name: string;
  path: RegExp;
  /** `Infinity` for a route that streams its body through and has no total. */
  limitBytes: number;
  refuse: (res: Response) => void;
  /** Refuses in `shadow` mode too. */
  alwaysEnforced?: boolean;
};

/**
 * `enforce` refuses a body over its limit with a 413. `shadow` counts the same bytes and reports
 * the same requests, then serves them.
 */
type IngressBodyCapMode = "shadow" | "enforce";

export type IngressBodyLimitEvent = {
  cap: string;
  /** The path as the router sees it. Carries ids, so resolve it to a route before logging. */
  routerPath: string;
  method: string;
  limitBytes: number;
  /** The declared `content-length`, or the bytes read when the request was refused or finished. */
  bytes: number;
  declared: boolean;
  hasAuthorization: boolean;
  hasCookie: boolean;
  /** The start of the `user-agent`, which tells an SDK from the CLI from a browser. */
  userAgent: string | undefined;
  enforced: boolean;
};

export type IngressBodyCapOptions<TContext = undefined> = {
  caps: IngressBodyCap[];
  defaultLimitBytes: number;
  mode: IngressBodyCapMode;
  /**
   * Called as each request arrives. Its result is handed back with that request's event, by
   * which time the handler may have filled it in.
   */
  capture?: () => TContext;
  /** A request whose body went over its limit. */
  onExceeded?: (event: IngressBodyLimitEvent, context: TContext | undefined) => void;
  /** The body size of every request measured, under the name of the limit that applied. */
  onMeasured?: (cap: string, bytes: number) => void;
};

const USER_AGENT_MAX_LENGTH = 120;

/** What a reader of a refused body gets in place of the rest of it. */
class RequestBodyLimitError extends Error {
  constructor() {
    super("Request body exceeded its size limit");
    // The request is over: handlers treat this like any other aborted read.
    this.name = "AbortError";
  }
}

const REFUSED = Symbol.for("trigger.bodyRefused");

/**
 * Mounted after the Remix handler. The handler of a request refused mid-body fails its read and
 * then has nothing to answer: the 413 is already sent.
 */
export const ignoreRefusedBodyErrors: ErrorRequestHandler = (error, _req, res, next) => {
  if ((res as { [REFUSED]?: boolean })[REFUSED]) return;
  next(error);
};

function refuseTooLarge(res: Response) {
  res.status(413).json({ error: "Request body too large" });
}

/** Headroom over the message cap for multipart framing and the per-turn metadata. */
const INGRESS_SLACK_BYTES = 8 * 1024;

export const DASHBOARD_AGENT_MAX_INGRESS_BYTES = MAX_MESSAGE_BODY_BYTES + INGRESS_SLACK_BYTES;

export const DASHBOARD_AGENT_INGRESS_CAP: IngressBodyCap = {
  name: "dashboard-agent",
  path: /^(?:\/api\/v1\/dashboard-agent|\/resources\/orgs\/[^/]+\/projects\/[^/]+\/env\/[^/]+\/dashboard-agent)(\/|$)/,
  limitBytes: DASHBOARD_AGENT_MAX_INGRESS_BYTES,
  refuse: (res) =>
    res.status(413).json({ error: MESSAGE_TOO_LARGE_ERROR, code: MESSAGE_TOO_LARGE_CODE }),
  alwaysEnforced: true,
};

/**
 * The sign-in forms carry an email, a code and a redirect path; the invite forms an id and a slug.
 * Always enforced.
 */
export const SIGN_IN_FORM_INGRESS_CAP: IngressBodyCap = {
  name: "sign-in-form",
  path: /^\/(?:auth\/sso|login\/(?:magic|mfa)|invite-(?:resend|revoke))$/,
  limitBytes: 64 * 1024,
  refuse: refuseTooLarge,
  alwaysEnforced: true,
};

export const OAUTH_INGRESS_CAP: IngressBodyCap = {
  name: "oauth",
  path: /^\/oauth\/(token|register|revoke)$/,
  limitBytes: 64 * 1024,
  refuse: refuseTooLarge,
  alwaysEnforced: true,
};

export function otlpIngressCap(limitBytes: number): IngressBodyCap {
  return {
    name: "otlp",
    path: /^\/otel(\/|$)/,
    limitBytes,
    refuse: refuseTooLarge,
    alwaysEnforced: true,
  };
}

/** The limits the listed routes already apply to a body once they have read it. */
export type RouteBodyLimits = {
  taskPayloadBytes: number;
  batchPayloadBytes: number;
  streamingBatchItemBytes: number;
  streamingBatchMaxItems: number;
  webhookBodyBytes: number;
  runMetadataBytes: number;
};

export const RUN_METADATA_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Largest event batch the analytics proxy forwards upstream. */
const ANALYTICS_PROXY_MAX_BODY_BYTES = 20 * 1024 * 1024;

/** Largest worker manifest: it carries the source of every task file. */
const WORKER_MANIFEST_MAX_BODY_BYTES = 32 * 1024 * 1024;

/** A deployment failure report: it can carry everything the indexer wrote to stderr. */
const DEPLOYMENT_FAILURE_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** The other fields of a dashboard form that carries a payload. */
const FORM_FIELDS_SLACK_BYTES = 64 * 1024;

/** What the supervisor accepts for an attempt completion before forwarding it here. */
const ATTEMPT_COMPLETION_MIN_BODY_BYTES = 10 * 1024 * 1024;

/** The error, usage and remaining fields of an attempt completion. */
const ATTEMPT_COMPLETION_SLACK_BYTES = 1024 * 1024;

const ENV_PATH = "/orgs/[^/]+/projects/[^/]+/env/[^/]+";

/**
 * Routes whose bodies are larger than the default. Each limit is the one the route enforces
 * itself, so a deployment that raises a payload limit raises its ingress limit with it. Paths are
 * matched in the router's form (decoded, lowercase), so they are written in lowercase.
 */
export function routeIngressCaps(limits: RouteBodyLimits): IngressBodyCap[] {
  const cap = (name: string, path: RegExp, limitBytes: number): IngressBodyCap => ({
    name,
    path,
    limitBytes,
    refuse: refuseTooLarge,
  });

  // A payload posted as a form field: every byte can percent-encode to three.
  const payloadFormBytes = limits.taskPayloadBytes * 3 + FORM_FIELDS_SLACK_BYTES;

  // A completion carries the inline output and the run's metadata (as data and again as
  // operations) as JSON strings, where a character can escape to six bytes.
  const attemptCompletionBytes = Math.max(
    ATTEMPT_COMPLETION_MIN_BODY_BYTES,
    6 * (OFFLOAD_IO_PACKET_LENGTH_LIMIT + 2 * limits.runMetadataBytes) +
      ATTEMPT_COMPLETION_SLACK_BYTES
  );

  return [
    cap(
      "trigger-payload",
      /^\/api\/v1\/(?:tasks\/[^/]+\/(?:trigger|batch)|runs\/[^/]+\/replay|waitpoints\/tokens\/[^/]+\/(?:complete|callback\/[^/]+))$/,
      limits.taskPayloadBytes
    ),
    cap("batch-payload", /^\/api\/v[12]\/tasks\/batch$/, limits.batchPayloadBytes),
    cap(
      "batch-items",
      /^\/api\/v3\/batches\/[^/]+\/items$/,
      // One line per item.
      limits.streamingBatchMaxItems * (limits.streamingBatchItemBytes + 1)
    ),
    cap("run-metadata", /^\/api\/v1\/runs\/[^/]+\/metadata$/, RUN_METADATA_MAX_BODY_BYTES),
    cap(
      "attempt-completion",
      /^\/engine\/v1\/(?:worker-actions|dev)\/runs\/[^/]+\/snapshots\/[^/]+\/attempts\/complete$/,
      attemptCompletionBytes
    ),
    cap(
      "worker-manifest",
      /^\/api\/v1\/(?:projects|deployments)\/[^/]+\/background-workers$/,
      WORKER_MANIFEST_MAX_BODY_BYTES
    ),
    cap(
      "deployment-failure",
      /^\/api\/v1\/deployments\/[^/]+\/fail$/,
      DEPLOYMENT_FAILURE_MAX_BODY_BYTES
    ),
    cap(
      "webhook-ingest",
      /^\/webhooks\/v1\/ingest\/[^/]+(?:\/w\/[^/]+)?$/,
      limits.webhookBodyBytes
    ),
    cap(
      "webhook-test-send",
      new RegExp(`^/resources${ENV_PATH}/webhooks/endpoints/[^/]+/send$`),
      // The body travels as a JSON string: a control character escapes to six bytes.
      limits.webhookBodyBytes * 6 + FORM_FIELDS_SLACK_BYTES
    ),
    cap(
      "payload-form",
      new RegExp(
        `^(?:${ENV_PATH}/test/tasks/[^/]+|/resources/taskruns/[^/]+/replay|/resources${ENV_PATH}/(?:waitpoints/[^/]+/complete|playground/action))$`
      ),
      payloadFormBytes
    ),
    cap("analytics-proxy", /^\/ph(\/|$)/, ANALYTICS_PROXY_MAX_BODY_BYTES),
    // Streamed to the stream store as it arrives, for as long as the run writes to it.
    cap(
      "realtime-stream",
      /^\/realtime\/v1\/streams\/[^/]+\/(?:self|parent|root)\/[^/]+$/,
      Infinity
    ),
  ];
}

function capRequestBody(
  req: Request,
  res: Response,
  cap: IngressBodyCap,
  enforced: boolean,
  report: {
    exceeded: (bytes: number, declared: boolean) => void;
    measured: (bytes: number) => void;
  }
): void {
  const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
  const hasDeclared = Number.isFinite(declared);

  // A body its handler never reads to the end doesn't close, so the response closing counts too.
  const whenOver = (settle: () => void) => {
    let settled = false;
    const once = () => {
      if (settled) return;
      settled = true;
      settle();
    };
    req.once("close", once);
    res.once("close", once);
  };

  if (hasDeclared && declared > cap.limitBytes) {
    if (enforced) {
      report.measured(declared);
      report.exceeded(declared, true);
      if (res.headersSent) return;
      // Nothing was read, so the connection can't carry another request: Node closes it once
      // the 413 is written, instead of reading the rest of the upload to discard it.
      res.setHeader("Connection", "close");
      cap.refuse(res);
      return;
    }
    whenOver(() => {
      report.measured(declared);
      report.exceeded(declared, true);
    });
    return;
  }

  let received = 0;
  let refused = false;
  const onData = (chunk: Buffer | string) => {
    received += Buffer.byteLength(chunk);
    if (received <= cap.limitBytes || !enforced) return;
    refused = true;
    req.removeAllListeners("data");
    req.pause();
    report.measured(received);
    report.exceeded(received, false);
    (res as { [REFUSED]?: boolean })[REFUSED] = true;
    if (!res.headersSent) cap.refuse(res);
    // The reader fails here, not when the request is torn down below.
    const failed = req.listenerCount("error") > 0 && req.emit("error", new RequestBodyLimitError());
    // A reader that fails can detach the socket from the request, so it is closed by name.
    const { socket } = req;
    const stop = () => {
      req.destroy(failed ? undefined : new RequestBodyLimitError());
      socket.destroy();
    };
    if (res.writableFinished) stop();
    else res.once("finish", stop); // after the 413 is sent, or the client never reads it
  };

  req.on("data", onData);
  req.pause();
  whenOver(() => {
    req.off("data", onData);
    if (refused) return;
    report.measured(hasDeclared ? declared : received);
    if (received > cap.limitBytes) report.exceeded(received, false);
  });
}

export function createIngressBodyCap<TContext = undefined>({
  caps,
  defaultLimitBytes,
  mode,
  capture,
  onExceeded,
  onMeasured,
}: IngressBodyCapOptions<TContext>): RequestHandler {
  const defaultCap: IngressBodyCap = {
    name: "default",
    path: /^/,
    limitBytes: defaultLimitBytes,
    refuse: refuseTooLarge,
  };

  return (req: Request, res: Response, next: NextFunction) => {
    // The only methods Remix never reads a body for.
    if (req.method === "GET" || req.method === "HEAD") {
      next();
      return;
    }

    // The router ignores trailing slashes, which a dot segment can leave behind.
    const routerPath = (getRouterPath(req) ?? "").replace(/\/+$/, "") || "/";
    const cap = caps.find((c) => c.path.test(routerPath)) ?? defaultCap;
    const enforced = cap.alwaysEnforced === true || mode === "enforce";
    const context = capture?.();

    capRequestBody(req, res, cap, enforced, {
      measured: (bytes) => onMeasured?.(cap.name, bytes),
      exceeded: (bytes, declared) =>
        onExceeded?.(
          {
            cap: cap.name,
            routerPath,
            method: req.method,
            limitBytes: cap.limitBytes,
            bytes,
            declared,
            hasAuthorization: req.headers.authorization !== undefined,
            hasCookie: req.headers.cookie !== undefined,
            userAgent: req.headers["user-agent"]?.slice(0, USER_AGENT_MAX_LENGTH),
            enforced,
          },
          context
        ),
    });
    if (res.headersSent) return;
    next();
  };
}

/**
 * Lets `limit` events through for each key in every window and counts the rest. The count of
 * those held back is returned with the next event let through for that key.
 */
export function createKeyedAllowance({
  limit,
  windowMs,
  now = Date.now,
}: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): (key: string) => { allowed: boolean; heldBack: number } {
  const windows = new Map<string, { start: number; allowed: number; heldBack: number }>();

  return (key) => {
    const at = now();
    let window = windows.get(key);
    if (!window || at - window.start >= windowMs) {
      window = { start: at, allowed: 0, heldBack: window?.heldBack ?? 0 };
      windows.set(key, window);
    }

    if (window.allowed >= limit) {
      window.heldBack += 1;
      return { allowed: false, heldBack: 0 };
    }

    window.allowed += 1;
    const heldBack = window.heldBack;
    window.heldBack = 0;
    return { allowed: true, heldBack };
  };
}

type RouteManifestEntry = {
  id: string;
  parentId?: string;
  path?: string;
  index?: boolean;
  caseSensitive?: boolean;
};

/**
 * Resolves a path to the id of the route that serves it (`routes/api.v1.runs.$runId.tags`), which
 * names the route without any of the ids in the path.
 */
export function createRouteIdMatcher(
  manifest: Record<string, RouteManifestEntry | undefined>
): (pathname: string) => string | undefined {
  const byParent = new Map<string, RouteManifestEntry[]>();
  for (const route of Object.values(manifest)) {
    if (!route) continue;
    const siblings = byParent.get(route.parentId ?? "") ?? [];
    siblings.push(route);
    byParent.set(route.parentId ?? "", siblings);
  }

  const childrenOf = (parentId: string): AgnosticRouteObject[] =>
    (byParent.get(parentId) ?? []).map((route) =>
      route.index
        ? { id: route.id, path: route.path, index: true, caseSensitive: route.caseSensitive }
        : {
            id: route.id,
            path: route.path,
            caseSensitive: route.caseSensitive,
            children: childrenOf(route.id),
          }
    );

  const tree = childrenOf("");

  return (pathname) => {
    try {
      return matchRoutes(tree, pathname)?.at(-1)?.route.id;
    } catch {
      return undefined;
    }
  };
}
