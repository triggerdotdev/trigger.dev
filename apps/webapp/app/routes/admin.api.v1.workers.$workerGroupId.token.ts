import { withAdminApi } from "~/services/adminApi.server";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { z } from "zod";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { WorkerGroupTokenService } from "~/v3/services/worker/workerGroupTokenService.server";

const DEFAULT_GRACE_SECONDS = 48 * 60 * 60;

const ParamsSchema = z.object({
  workerGroupId: z.string(),
});

const RequestBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("rotate"),
    graceSeconds: z.number().int().positive().default(DEFAULT_GRACE_SECONDS),
  }),
  z.object({
    action: z.literal("revoke-previous"),
  }),
]);

async function handleAction({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, { status: 405 });
  }

  const { workerGroupId } = ParamsSchema.parse(params);

  const [jsonError, rawBody] = await tryCatch(request.json());

  if (jsonError) {
    return json({ error: "invalid request body" }, { status: 400 });
  }

  const parsedBody = RequestBodySchema.safeParse(rawBody ?? {});

  if (!parsedBody.success) {
    return json(
      { error: "invalid request body", issues: parsedBody.error.issues },
      { status: 400 }
    );
  }

  const service = new WorkerGroupTokenService();

  switch (parsedBody.data.action) {
    case "rotate": {
      const result = await service.rotateToken({
        workerGroupId,
        graceMs: parsedBody.data.graceSeconds * 1000,
      });

      switch (result.outcome) {
        case "not_found":
          return json({ error: "worker group not found" }, { status: 404 });
        case "conflict":
          return json({ error: "worker group token changed concurrently" }, { status: 409 });
        case "grace_active":
          return json(
            {
              error:
                "previous worker group token is still within its grace period; revoke it first",
              previousTokenValidUntil: result.previousTokenValidUntil,
            },
            { status: 409 }
          );
        case "rotated":
          return json({
            outcome: "rotated worker group token",
            token: result.plaintext,
            previousTokenValidUntil: result.previousTokenValidUntil,
          });
      }
    }
    case "revoke-previous": {
      const result = await service.revokePreviousToken({ workerGroupId });

      if (!result) {
        return json({ error: "worker group not found" }, { status: 404 });
      }

      return json({ outcome: "revoked previous worker group token" });
    }
  }
}

export const action = withAdminApi(handleAction);
