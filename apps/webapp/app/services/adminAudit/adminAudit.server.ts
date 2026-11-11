import type { AdminAuditActor, AdminAuditController } from "@trigger.dev/plugins";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import type { AuthUser } from "~/services/authUser";
import { getHttpContext } from "~/services/httpAsyncStorage.server";
import { getImpersonationId } from "~/services/impersonation.server";
import { logger } from "~/services/logger.server";
import { getIpLocation } from "~/services/platform.v3.server";
import { getUserSession } from "~/services/sessionStorage.server";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { singleton } from "~/utils/singleton";
import {
  type AdminAuditRequestState,
  getAdminAuditController,
  runWithAdminAuditState,
  setAdminAuditController,
} from "./adminAuditContext.server";

export { getAdminAuditController };
import { loadAdminAuditPlugin } from "./adminAuditPlugin.server";

function loadController(): Promise<AdminAuditController | null> {
  return singleton("adminAuditController", () =>
    loadAdminAuditPlugin(
      {
        lookupIpLocation: (ip) => getIpLocation(ip),
        appOrigin: env.APP_ORIGIN,
      },
      { requirePlugins: env.REQUIRE_PLUGINS === "1" }
    )
  );
}

if (env.ADMIN_AUDIT_ENABLED) {
  const controller = loadController();
  controller.catch((error) => {
    logger.error("Admin audit: plugin failed to load", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  setAdminAuditController(controller);
}

const MAX_PATH_LENGTH = 1024;

/** remix-auth's default key for the signed-in user in the session cookie. */
const AUTHENTICATOR_SESSION_KEY = "user";

/**
 * Wraps an admin route's loader or action so each call is recorded once it settles, with the
 * status of the returned or thrown Response. The auth helpers inside the handler fill in the actor
 * and body summary. When admin audit is off this returns the handler itself, so it costs nothing.
 */
export function withAdminAudit<Args extends { request: Request }, Result>(
  handler: (args: Args) => Promise<Result>
): (args: Args) => Promise<Result> {
  if (!env.ADMIN_AUDIT_ENABLED) return handler;

  return async (args) => {
    const state: AdminAuditRequestState = {};
    const time = new Date();
    const startedAt = performance.now();
    let status = 500;
    try {
      const result = await runWithAdminAuditState(state, () => handler(args));
      status = result instanceof Response ? result.status : 200;
      return result;
    } catch (thrown) {
      status = thrown instanceof Response ? thrown.status : 500;
      throw thrown;
    } finally {
      void recordRouteCall({ request: args.request, state, time, startedAt, status });
    }
  };
}

async function recordRouteCall(params: {
  request: Request;
  state: AdminAuditRequestState;
  time: Date;
  startedAt: number;
  status: number;
}): Promise<void> {
  const { request, state, time, startedAt, status } = params;
  try {
    const controller = await getAdminAuditController();
    if (!controller) return;

    const actor = state.actor ?? (await resolveSessionActor(request));
    const bodySummary = state.bodySummary ? await state.bodySummary : null;
    const path = decodeSafely(new URL(request.url).pathname).slice(0, MAX_PATH_LENGTH);

    controller.record({
      id: randomUUID(),
      time,
      activity: path.toLowerCase().startsWith("/admin/api/") ? "api_call" : "dashboard_action",
      actor,
      srcEndpoint: {
        ip: extractClientIp(request.headers.get("x-forwarded-for")),
        userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
      },
      http: {
        method: request.method,
        path,
        status,
        durationMs: Math.round(performance.now() - startedAt),
      },
      requestId: getHttpContext()?.requestId ?? null,
      bodySummary,
      pat: null,
    });
  } catch (error) {
    logger.warn("Admin audit: failed to record admin route call", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The real signed-in user, not the impersonation target. */
async function resolveSessionActor(request: Request): Promise<AdminAuditActor> {
  if (!request.headers.get("cookie")) return { kind: "unauthenticated" };

  const session = await getUserSession(request);
  const authUser = session.get(AUTHENTICATOR_SESSION_KEY) as AuthUser | undefined;
  if (!authUser?.userId) return { kind: "unauthenticated" };

  const [user, impersonatedUserId] = await Promise.all([
    prisma.user.findFirst({
      where: { id: authUser.userId },
      select: { email: true, admin: true },
    }),
    getImpersonationId(request),
  ]);

  return {
    kind: "user_session",
    userId: authUser.userId,
    email: user?.email,
    isAdmin: user?.admin ?? false,
    impersonatedUserId: impersonatedUserId ?? undefined,
  };
}

function decodeSafely(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
