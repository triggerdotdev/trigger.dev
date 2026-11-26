import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { authenticateApiKeyWithScope } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import {
  getSkewProtectionThreshold,
  skewProtectionThresholdApiResponse,
} from "~/presenters/v3/SkewProtectionThresholdPresenter.server";
import {
  apiKeyActorName,
  clearSkewProtectionThreshold,
  MAX_THRESHOLD_TASK_LENGTH,
  MAX_THRESHOLD_VERSION_LENGTH,
  setSkewProtectionThreshold,
  SkewProtectionThresholdError,
  ThresholdTaskId as Task,
} from "~/v3/services/skewProtectionThreshold.server";

const PutBody = z.object({
  version: z.string().max(MAX_THRESHOLD_VERSION_LENGTH),
  /** Only this task's sessions. Absent: every session in the environment. */
  task: Task.optional(),
});

// Secret keys only: public keys always fail authenticateApiKeyWithScope, and JWTs are refused by
// leaving allowJWT unset. Each call names its action literally so the docs can read the route's access.
function authenticated(authResult: Awaited<ReturnType<typeof authenticateApiKeyWithScope>>) {
  if (!authResult.ok) {
    return { response: json({ error: authResult.error }, { status: authResult.status }) };
  }
  return {
    environment: authResult.authentication.environment,
    apiKey: authResult.authentication.apiKey,
  };
}

function errorResponse(error: unknown, message: string) {
  if (error instanceof Response) throw error;
  if (error instanceof SkewProtectionThresholdError) {
    return json({ error: error.message }, { status: error.status });
  }
  logger.error(message, { error });
  return json({ error: "Internal Server Error" }, { status: 500 });
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const auth = authenticated(
      await authenticateApiKeyWithScope(request, {
        action: "read",
        resource: { type: "deployments" },
      })
    );
    if (auth.response) return auth.response;

    return json(
      skewProtectionThresholdApiResponse(
        await getSkewProtectionThreshold($replica, auth.environment.id)
      )
    );
  } catch (error) {
    return errorResponse(error, "Failed to read the skew protection threshold");
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const method = request.method.toUpperCase();
  if (method !== "PUT" && method !== "DELETE") {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  try {
    const auth = authenticated(
      await authenticateApiKeyWithScope(request, {
        action: "write",
        resource: { type: "deployments" },
      })
    );
    if (auth.response) return auth.response;
    const { environment } = auth;
    const actor = {
      source: "api",
      apiKeyName: await apiKeyActorName($replica, auth.apiKey),
    } as const;

    if (method === "DELETE") {
      const task = Task.nullable().safeParse(new URL(request.url).searchParams.get("task"));
      if (!task.success) {
        return json(
          { error: `"task" is a task id of 1 to ${MAX_THRESHOLD_TASK_LENGTH} characters.` },
          { status: 400 }
        );
      }
      await clearSkewProtectionThreshold(prisma, environment, actor, task.data ?? undefined);
    } else {
      const [parseError, body] = await request.json().then(
        (value) => [undefined, PutBody.safeParse(value)] as const,
        (error) => [error, undefined] as const
      );
      if (parseError || !body?.success) {
        return json(
          {
            error:
              'Expected a JSON body like { "version": "20261108.5" }, or { "version": "20261108.5", "task": "my-task" } for one task',
          },
          { status: 400 }
        );
      }

      await setSkewProtectionThreshold(prisma, {
        environment,
        version: body.data.version,
        task: body.data.task,
        setBy: { type: "api" },
        actor,
      });
    }

    // On the writer: this reads back what the request just wrote.
    return json(
      skewProtectionThresholdApiResponse(await getSkewProtectionThreshold(prisma, environment.id))
    );
  } catch (error) {
    return errorResponse(error, "Failed to change the skew protection threshold");
  }
}
