import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import type { UseDataFunctionReturn } from "remix-typedjson";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { Container } from "~/components/layout/Container";
import {
  ProjectSideMenu,
  SideMenuContainer,
} from "~/components/navigation/SideMenu";
import { prisma } from "~/db.server";
import { hydrateObject, useMatchesData } from "~/utils";

export async function loader({ params }: LoaderArgs) {
  const { organizationSlug, projectP } = params;
  invariant(organizationSlug, "organizationSlug not found");
  invariant(projectP, "projectP not found");

  const project = await prisma.repositoryProject.findFirstOrThrow({
    where: {
      id: projectP,
      organization: {
        slug: organizationSlug,
      },
    },
    include: {
      currentDeployment: true,
    },
  });

  return typedjson({
    project,
    organizationSlug,
  });
}

export default function ProjectLayout() {
  const { project, organizationSlug } = useTypedLoaderData<typeof loader>();

  return (
    <>
      <SideMenuContainer>
        <ProjectSideMenu
          project={project}
          backPath={`/orgs/${organizationSlug}`}
        />
        <Container>
          <Outlet />
        </Container>
      </SideMenuContainer>
    </>
  );
}

export function useCurrentProject() {
  const routeMatch = useMatchesData(
    "routes/__app/orgs/$organizationSlug/projects/$projectP"
  );

  if (!routeMatch || !routeMatch.data.project) {
    throw new Error("Calling useCurrentProject outside of a project route");
  }

  const result = hydrateObject<UseDataFunctionReturn<typeof loader>["project"]>(
    routeMatch.data.project
  );

  return result;
}

export type CurrentProject = ReturnType<typeof useCurrentProject>;
