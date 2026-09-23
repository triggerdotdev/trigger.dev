import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { concurrencyLimitsSystem } from "~/v3/services/concurrencyLimitsSystemInstance.server";

const ParamsSchema = z.object({
  name: z.string(),
});

const BodySchema = z.object({
  action: z.enum(["pause", "resume"]),
});

const route = createActionApiRoute(
  {
    params: ParamsSchema,
    body: BodySchema,
    authorization: {
      action: "write",
      resource: () => ({ type: "queues" }),
    },
    corsStrategy: "all",
  },
  async ({ params, body, authentication }) => {
    const result =
      body.action === "pause"
        ? concurrencyLimitsSystem.limits.pause(authentication.environment, params.name)
        : concurrencyLimitsSystem.limits.resume(authentication.environment, params.name);

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
          default:
            return json({ error: `Failed to ${body.action} concurrency limit` }, { status: 500 });
        }
      }
    );
  }
);

export const action = route.action;
export const loader = route.loader;
