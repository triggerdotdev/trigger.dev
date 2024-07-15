import { Outlet } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { prisma } from "~/db.server";
import { useTypedMatchData, useTypedMatchesData } from "~/hooks/useTypedMatchData";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      organization: {
        slug: organizationSlug,
      },
      project: {
        slug: projectParam,
      },
      orgMember: {
        userId,
      },
    },
  });

  if (!environment) {
    throw new Response("Not Found", { status: 404 });
  }

  return typedjson({
    apiKey: environment.apiKey,
  });
};

export function useV2OnboardingApiKey() {
  const routeMatch = useTypedMatchesData<typeof loader>({
    id: "routes/_app.orgs.$organizationSlug.projects.$projectParam.setup",
  });
  if (!routeMatch) {
    throw new Error("Route match not found");
  }

  return routeMatch;
}

export default function Page() {
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
      <Outlet />
    </div>
  );
}
