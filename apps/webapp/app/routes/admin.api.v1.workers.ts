import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { WorkerGroupService } from "~/v3/services/worker/workerGroupService.server";

const RequestBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  makeDefaultForProjectId: z.string().optional(),
});

export async function action({ request }: ActionFunctionArgs) {
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

  try {
    const rawBody = await request.json();
    const { name, description, makeDefaultForProjectId } = RequestBodySchema.parse(rawBody ?? {});

    const service = new WorkerGroupService();
    const { workerGroup, token } = await service.createWorkerGroup({
      name,
      description,
    });

    if (makeDefaultForProjectId) {
      await prisma.project.update({
        where: {
          id: makeDefaultForProjectId,
        },
        data: {
          defaultWorkerGroupId: workerGroup.id,
        },
      });
    }

    return json({
      token,
      workerGroup,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : error }, { status: 400 });
  }
}
