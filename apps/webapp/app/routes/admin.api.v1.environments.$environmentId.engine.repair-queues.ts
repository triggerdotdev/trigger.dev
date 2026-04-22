import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import pMap from "p-map";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { determineEngineVersion } from "~/v3/engineVersion.server";
import { engine } from "~/v3/runEngine.server";

const ParamsSchema = z.object({
  environmentId: z.string(),
});

const BodySchema = z.object({
  dryRun: z.boolean().default(true),
  queues: z.array(z.string()).default([]),
});

export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const parsedParams = ParamsSchema.parse(params);

  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      id: parsedParams.environmentId,
    },
    include: {
      organization: true,
      project: true,
      orgMember: true,
    },
  });

  if (!environment) {
    return json({ error: "Environment not found" }, { status: 404 });
  }

  const engineVersion = await determineEngineVersion({ environment });

  if (engineVersion === "V1") {
    return json({ error: "Engine version is V1" }, { status: 400 });
  }

  const body = await request.json();
  const parsedBody = BodySchema.parse(body);

  const queues = await $replica.taskQueue.findMany({
    where: {
      runtimeEnvironmentId: environment.id,
      version: "V2",
      name: parsedBody.queues.length > 0 ? { in: parsedBody.queues } : undefined,
    },
    select: {
      friendlyId: true,
      name: true,
      concurrencyLimit: true,
      type: true,
      paused: true,
    },
    orderBy: {
      orderableName: "asc",
    },
  });

  const repairEnvironmentResults = await engine.repairEnvironment(environment, parsedBody.dryRun);

  const repairResults = await pMap(
    queues,
    async (queue) => {
      const repair = await engine.repairQueue(
        environment,
        queue.name,
        parsedBody.dryRun,
        repairEnvironmentResults.runIds
      );

      return {
        queue: queue.name,
        ...repair,
      };
    },
    { concurrency: 5 }
  );

  return json({ environment: repairEnvironmentResults, queues: repairResults });
}
