import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { updateEnvConcurrencyLimits } from "~/v3/runQueue.server";

const ParamsSchema = z.object({
  environmentId: z.string(),
});

const RequestBodySchema = z.object({
  burstFactor: z.number().positive(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const { environmentId } = ParamsSchema.parse(params);
  const body = RequestBodySchema.parse(await request.json());

  const environment = await prisma.runtimeEnvironment.update({
    where: { id: environmentId },
    data: { concurrencyLimitBurstFactor: body.burstFactor },
    include: { organization: true, project: true },
  });

  await updateEnvConcurrencyLimits(environment);

  return json({ success: true });
}
