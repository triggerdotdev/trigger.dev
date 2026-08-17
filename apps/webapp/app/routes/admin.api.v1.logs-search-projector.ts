import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { LogsSearchProjectorConflictError } from "~/services/logsSearchProjector.server";
import { getLogsSearchProjector } from "~/services/logsSearchProjectorInstance.server";
import { logger } from "~/services/logger.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
]);

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdminApiRequest(request);
  return json(await getLogsSearchProjector().status());
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireAdminApiRequest(request);

  try {
    const body = Body.parse(await request.json());
    const logsSearchProjector = getLogsSearchProjector();
    logger.info("Updating logs search projector", { userId: user.id, action: body.action });

    switch (body.action) {
      case "pause":
        return json(await logsSearchProjector.pause());
      case "resume":
        return json(await logsSearchProjector.resume());
    }
  } catch (error) {
    if (error instanceof LogsSearchProjectorConflictError) {
      return json({ error: error.message }, { status: 409 });
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 }
      );
    }
    throw error;
  }
}
