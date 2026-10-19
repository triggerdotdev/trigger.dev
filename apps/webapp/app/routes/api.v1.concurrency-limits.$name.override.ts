import { json } from "@remix-run/server-runtime";
import { OverrideConcurrencyLimitRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { concurrencyLimitsSystem } from "~/v3/services/concurrencyLimitsSystemInstance.server";

const ParamsSchema = z.object({
  name: z.string(),
});

const route = createActionApiRoute(
  {
    params: ParamsSchema,
    body: OverrideConcurrencyLimitRequestBody,
    authorization: {
      action: "write",
      resource: () => ({ type: "queues" }),
    },
    corsStrategy: "all",
  },
  async ({ params, body, authentication }) => {
    const result =
      body.concurrencyKey !== undefined
        ? concurrencyLimitsSystem.limits.overrideKey(authentication.environment, params.name, {
            concurrencyKey: body.concurrencyKey,
            perKey: body.perKey,
            ttl: body.ttl,
          })
        : concurrencyLimitsSystem.limits.override(authentication.environment, params.name, {
            perKey: body.perKey,
            total: body.total,
          });
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
          case "invalid_override":
            return json({ error: error.message }, { status: 400 });
          case "feature_disabled":
            return json(
              { error: "Per-key concurrency overrides are not enabled on this server" },
              { status: 400 }
            );
          default:
            return json({ error: "Failed to override concurrency limit" }, { status: 500 });
        }
      }
    );
  }
);

export const action = route.action;
export const loader = route.loader;
