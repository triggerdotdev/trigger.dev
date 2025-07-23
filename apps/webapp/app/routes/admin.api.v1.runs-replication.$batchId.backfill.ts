import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { adminWorker } from "~/v3/services/adminWorker.server";

const Body = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  batchSize: z.number().optional(),
});

const Params = z.object({
  batchId: z.string(),
});

const DEFAULT_BATCH_SIZE = 500;

export async function action({ request, params }: ActionFunctionArgs) {
  // Next authenticate the request
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: {
      id: authenticationResult.userId,
    },
  });

  if (!user) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  if (!user.admin) {
    return json({ error: "You must be an admin to perform this action" }, { status: 403 });
  }

  const { batchId } = Params.parse(params);

  try {
    const body = await request.json();

    const { from, to, batchSize } = Body.parse(body);

    await adminWorker.enqueue({
      job: "admin.backfillRunsToReplication",
      payload: {
        from,
        to,
        batchSize: batchSize ?? DEFAULT_BATCH_SIZE,
      },
      id: batchId,
    });

    return json({
      success: true,
      id: batchId,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : error }, { status: 400 });
  }
}
