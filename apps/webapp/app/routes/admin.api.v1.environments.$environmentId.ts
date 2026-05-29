import { ActionFunctionArgs, json, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { engine } from "~/v3/runEngine.server";
import { updateEnvConcurrencyLimits } from "~/v3/runQueue.server";

const ParamsSchema = z.object({
  environmentId: z.string(),
});

const RequestBodySchema = z.object({
  envMaximumConcurrencyLimit: z.number(),
  orgMaximumConcurrencyLimit: z.number(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const parsedParams = ParamsSchema.parse(params);

  const rawBody = await request.json();
  const body = RequestBodySchema.parse(rawBody);

  const environment = await prisma.runtimeEnvironment.update({
    where: {
      id: parsedParams.environmentId,
    },
    data: {
      maximumConcurrencyLimit: body.envMaximumConcurrencyLimit,
      organization: {
        update: {
          data: {
            maximumConcurrencyLimit: body.orgMaximumConcurrencyLimit,
          },
        },
      },
    },
    include: {
      organization: true,
      project: true,
    },
  });

  await updateEnvConcurrencyLimits(environment);

  return json({ success: true });
}

const SearchParamsSchema = z.object({
  queue: z.string().optional(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireAdminApiRequest(request);

  const parsedParams = ParamsSchema.parse(params);

  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      id: parsedParams.environmentId,
    },
    include: {
      organization: true,
      project: true,
    },
  });

  if (!environment) {
    return json({ error: "Environment not found" }, { status: 404 });
  }

  const requestUrl = new URL(request.url);
  const searchParams = SearchParamsSchema.parse(
    Object.fromEntries(requestUrl.searchParams.entries())
  );

  const concurrencyLimit = await engine.runQueue.getEnvConcurrencyLimit(environment);
  const currentConcurrency = await engine.runQueue.currentConcurrencyOfEnvironment(environment);

  if (searchParams.queue) {
    const queueConcurrencyLimit = await engine.runQueue.getQueueConcurrencyLimit(
      environment,
      searchParams.queue
    );
    const queueCurrentConcurrency = await engine.runQueue.currentConcurrencyOfQueue(
      environment,
      searchParams.queue
    );

    return json({
      id: environment.id,
      concurrencyLimit,
      currentConcurrency,
      queueConcurrencyLimit,
      queueCurrentConcurrency,
    });
  }

  return json({ id: environment.id, concurrencyLimit, currentConcurrency });
}
