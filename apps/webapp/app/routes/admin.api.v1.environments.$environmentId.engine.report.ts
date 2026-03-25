import { json, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { determineEngineVersion } from "~/v3/engineVersion.server";
import { engine } from "~/v3/runEngine.server";

const ParamsSchema = z.object({
  environmentId: z.string(),
});

const SearchParamsSchema = z.object({
  verbose: z.string().default("0"),
  page: z.coerce.number().optional(),
  per_page: z.coerce.number().optional(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
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

  const url = new URL(request.url);
  const searchParams = SearchParamsSchema.parse(Object.fromEntries(url.searchParams));

  const page = searchParams.page ?? 1;
  const perPage = searchParams.per_page ?? 50;

  const queues = await $replica.taskQueue.findMany({
    where: {
      runtimeEnvironmentId: environment.id,
      version: "V2",
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
    skip: (page - 1) * perPage,
    take: perPage,
  });

  const report = await engine.generateEnvironmentReport(
    environment,
    queues,
    searchParams.verbose === "1"
  );

  return json(report);
}
