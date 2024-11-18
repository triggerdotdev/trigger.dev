import { ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { realtimeStreams } from "~/services/realtimeStreamsGlobal.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  runId: z.string(),
  streamId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const $params = ParamsSchema.parse(params);

  if (!request.body) {
    return new Response("No body provided", { status: 400 });
  }

  return realtimeStreams.ingestData(request.body, $params.runId, $params.streamId);
}

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: (params) => ({ runs: params.runId }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
  },
  async ({ params, authentication, request }) => {
    const run = await $replica.taskRun.findFirst({
      where: {
        friendlyId: params.runId,
        runtimeEnvironmentId: authentication.environment.id,
      },
    });

    if (!run) {
      return new Response("Run not found", { status: 404 });
    }

    return realtimeStreams.streamResponse(run.friendlyId, params.streamId, request.signal);
  }
);
