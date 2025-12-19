import { json } from "@remix-run/server-runtime";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ResetIdempotencyKeyService } from "~/v3/services/resetIdempotencyKey.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  key: z.string(),
});

const BodySchema = z.object({
  taskIdentifier: z.string().min(1, "Task identifier is required"),
});

export const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: BodySchema,
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "write",
      resource: () => ({}),
      superScopes: ["write:runs", "admin"],
    },
  },
  async ({ params, body, authentication }) => {
    const service = new ResetIdempotencyKeyService();

    try {
      const result = await service.call(
        params.key,
        body.taskIdentifier,
        authentication.environment
      );
      return json(result, { status: 200 });
    } catch (error) {
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: error.status ?? 400 });
      }

      logger.error("Failed to reset idempotency key via API", {
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      });

      return json({ error: "Internal Server Error" }, { status: 500 });
    }

  }
);
