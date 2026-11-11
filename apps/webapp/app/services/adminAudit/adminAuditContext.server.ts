import type {
  AdminAuditActor,
  AdminAuditController,
  AdminAuditSourceEndpoint,
} from "@trigger.dev/plugins";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { prisma } from "~/db.server";
import { getHttpContext } from "~/services/httpAsyncStorage.server";
import { logger } from "~/services/logger.server";
import { extractClientIp } from "~/utils/extractClientIp.server";

/** What the auth helpers learn about an audited admin route call while it runs. */
export type AdminAuditRequestState = {
  actor?: AdminAuditActor;
  bodySummary?: Promise<Record<string, unknown> | null>;
};

const adminAuditStorage = new AsyncLocalStorage<AdminAuditRequestState>();

/** Runs an audited admin route handler with its own state, so the auth helpers can fill it in. */
export function runWithAdminAuditState<T>(state: AdminAuditRequestState, fn: () => T): T {
  return adminAuditStorage.run(state, fn);
}

let controllerPromise: Promise<AdminAuditController | null> | undefined;

/** Called once at boot by the admin audit module when admin audit is enabled. */
export function setAdminAuditController(promise: Promise<AdminAuditController | null>): void {
  controllerPromise = promise;
}

export async function getAdminAuditController(): Promise<AdminAuditController | null> {
  if (!controllerPromise) return null;
  return controllerPromise;
}

/**
 * Tells the audited route call who is making it. Outside an audited admin route this does nothing.
 * Pass `captureBody` only once the caller is authenticated, so an anonymous request can't make us
 * read its body.
 */
export function noteAdminRequest(
  request: Request,
  options: { actor?: AdminAuditActor; captureBody: boolean }
): void {
  const state = adminAuditStorage.getStore();
  if (!state) return;

  if (options.actor) {
    state.actor = options.actor;
  }

  if (options.captureBody && !state.bodySummary && hasBody(request)) {
    state.bodySummary = summarizeRequestBody(request);
  }
}

/** Records a personal access token minted by an admin. Never throws. */
export async function recordAdminPatCreated(params: {
  userId: string;
  tokenId: string;
  name: string;
  source?: AdminAuditSourceEndpoint;
}): Promise<void> {
  try {
    const controller = await getAdminAuditController();
    if (!controller) return;

    const user = await prisma.user.findFirst({
      where: { id: params.userId },
      select: { email: true, admin: true },
    });
    if (!user?.admin) return;

    controller.record({
      id: randomUUID(),
      time: new Date(),
      activity: "pat_created",
      actor: { kind: "user_session", userId: params.userId, email: user.email, isAdmin: true },
      srcEndpoint: params.source ?? { ip: null, userAgent: null },
      http: null,
      requestId: getHttpContext()?.requestId ?? null,
      bodySummary: null,
      pat: { tokenId: params.tokenId, name: params.name },
    });
  } catch (error) {
    logger.warn("Admin audit: failed to record PAT creation", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Records an admin starting to impersonate a user. Called where every entry point converges
 * (`redirectWithImpersonation`), because some of them start on a GET that route wrappers don't
 * record. Never throws.
 */
export async function recordAdminImpersonationStarted(params: {
  request: Request;
  adminUserId: string;
  targetUserId: string;
  organizationSlug: string;
  /** "allow" for a full session, "scoped" for a customer-approved Support Access session. */
  access: string;
  supportAccessRequestId?: string;
}): Promise<void> {
  try {
    const controller = await getAdminAuditController();
    if (!controller) return;

    const admin = await prisma.user.findFirst({
      where: { id: params.adminUserId },
      select: { email: true, admin: true },
    });
    const { request } = params;

    controller.record({
      id: randomUUID(),
      time: new Date(),
      activity: "impersonation_started",
      actor: {
        kind: "user_session",
        userId: params.adminUserId,
        email: admin?.email,
        isAdmin: admin?.admin ?? false,
        impersonatedUserId: params.targetUserId,
      },
      srcEndpoint: {
        ip: extractClientIp(request.headers.get("x-forwarded-for")),
        userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
      },
      http: {
        method: request.method,
        path: new URL(request.url).pathname.slice(0, 1024),
        status: 302,
        durationMs: 0,
      },
      requestId: getHttpContext()?.requestId ?? null,
      bodySummary: {
        organizationSlug: params.organizationSlug,
        access: params.access,
        ...(params.supportAccessRequestId
          ? { supportAccessRequestId: params.supportAccessRequestId }
          : {}),
      },
      pat: null,
    });
  } catch (error) {
    logger.warn("Admin audit: failed to record impersonation start", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function hasBody(request: Request): boolean {
  return request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_KEYS = 40;
const MAX_STRING_LENGTH = 120;
const MAX_DEPTH = 2;
const SECRET_QUERY_PARAM =
  /([?&](?:password|passwd|pwd|sslpassword|token|secret|api[-_]?key|access[-_]?key|signature)=)[^&#\s]*/gi;
const SECRET_KEY =
  /secret|token|password|passwd|authorization|credential|cookie|private|api[-_]?key|signature/i;

/** Body fields with short scalar values, two levels deep. Secret-looking keys are redacted. */
async function summarizeRequestBody(request: Request): Promise<Record<string, unknown> | null> {
  if (request.bodyUsed) return null;

  let clone: Request;
  try {
    clone = request.clone();
  } catch {
    return null;
  }

  const contentType = request.headers.get("content-type") ?? "";

  try {
    const text = await readLimited(clone, MAX_BODY_BYTES);
    if (text === null) return { _omitted: `body over ${MAX_BODY_BYTES} bytes` };
    if (text.length === 0) return null;

    if (contentType.includes("application/json")) {
      const summary = summarizeValue(JSON.parse(text), 0);
      return isRecord(summary) ? summary : { _value: summary };
    }

    if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const form = await new Response(text, {
        headers: { "content-type": contentType },
      }).formData();
      const entries: Record<string, unknown> = {};
      let count = 0;
      for (const [key, value] of form.entries()) {
        if (count++ >= MAX_KEYS) {
          entries._truncated = true;
          break;
        }
        entries[key] = SECRET_KEY.test(key)
          ? "[redacted]"
          : typeof value === "string"
            ? truncate(value)
            : "[file]";
      }
      return entries;
    }

    return { _contentType: contentType.slice(0, 80) || null, _bytes: text.length };
  } catch {
    return { _unparseable: true };
  }
}

async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function summarizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return truncate(value);
  if (Array.isArray(value)) {
    return depth >= MAX_DEPTH
      ? `[array of ${value.length}]`
      : value.slice(0, 10).map((item) => summarizeValue(item, depth + 1));
  }
  if (isRecord(value)) {
    if (depth >= MAX_DEPTH) return "[object]";
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      if (count++ >= MAX_KEYS) {
        result._truncated = true;
        break;
      }
      result[key] = SECRET_KEY.test(key) ? "[redacted]" : summarizeValue(item, depth + 1);
    }
    return result;
  }
  return `[${typeof value}]`;
}

/**
 * Redacts values that could hold credentials, then shortens the rest. A string with both `:` and
 * `@` may carry `user:password@` in some URL form, so it is dropped whole; secret query parameters
 * such as `?password=` are blanked. Both checks are linear in the string length.
 */
function truncate(value: string): string {
  if (value.includes("@") && value.includes(":")) return "[redacted]";
  const scrubbed = value.replace(SECRET_QUERY_PARAM, "$1[redacted]");
  return scrubbed.length > MAX_STRING_LENGTH
    ? `${scrubbed.slice(0, MAX_STRING_LENGTH)}...`
    : scrubbed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
