import { json } from "@remix-run/server-runtime";
import { ResetConcurrencyLimitRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { safeJsonParse } from "~/utils/json";
import { concurrencyLimitsSystem } from "~/v3/services/concurrencyLimitsSystemInstance.server";

const ParamsSchema = z.object({
  name: z.string(),
});

const route = createActionApiRoute(
  {
    params: ParamsSchema,
    authorization: {
      action: "write",
      resource: () => ({ type: "queues" }),
    },
    corsStrategy: "all",
  },
  async ({ params, request, authentication }) => {
    /** The body is optional: an empty POST resets the limit itself, as it always has. */
    const rawBody = await request.text();
    let concurrencyKey: string | undefined;
    if (rawBody.length > 0) {
      const parsed = ResetConcurrencyLimitRequestBody.safeParse(safeJsonParse(rawBody));
      if (!parsed.success) {
        return json(
          { error: "Invalid body: expected { concurrencyKey?: string }" },
          { status: 400 }
        );
      }
      concurrencyKey = parsed.data.concurrencyKey;
    }
    const result =
      concurrencyKey !== undefined
        ? concurrencyLimitsSystem.limits.resetKey(
            authentication.environment,
            params.name,
            concurrencyKey
          )
        : concurrencyLimitsSystem.limits.reset(authentication.environment, params.name);
    return result.match(
      (limit) => json(limit),
      (error) => {
        switch (error.type) {
          case "limit_not_found":
            return json({ error: "Concurrency limit not found" }, { status: 404 });
          case "conflict":
            return json(
              { error: "The limit changed concurrently; retry the request" },
              { status: 409 }
            );
          case "limit_not_overridden":
            return json({ error: "Concurrency limit has no override to reset" }, { status: 400 });
          default:
            return json({ error: "Failed to reset concurrency limit" }, { status: 500 });
        }
      }
    );
  }
);

export const action = route.action;
export const loader = route.loader;
