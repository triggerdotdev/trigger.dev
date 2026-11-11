import { env } from "~/env.server";
import { withAdminAudit } from "~/services/adminAudit/adminAudit.server";
import { logger } from "~/services/logger.server";

/**
 * Wraps every admin API loader and action (`app/routes/admin.api.*`). With `ADMIN_API_ENABLED`
 * off the route answers 404 before any authentication runs, so no credential (admin PAT, billing
 * service secret or dashboard session) reaches it on that instance. The gate sits on the matched
 * route rather than on the URL, so every path spelling the router accepts is covered.
 */
export function withAdminApi<Args extends { request: Request }, Result>(
  handler: (args: Args) => Promise<Result>
): (args: Args) => Promise<Result> {
  const audited = withAdminAudit(handler);

  return async (args) => {
    if (!env.ADMIN_API_ENABLED) {
      logger.info("Refused admin API request: the admin API is disabled on this instance", {
        method: args.request.method,
        path: new URL(args.request.url).pathname,
      });

      throw new Response(JSON.stringify({ error: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return audited(args);
  };
}
