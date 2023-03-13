import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import type { UseDataFunctionReturn } from "remix-typedjson";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { Container } from "~/components/layout/Container";
import { Header } from "~/components/layout/Header";
import {
  ProjectSideMenu,
  SideMenuContainer,
} from "~/components/navigation/SideMenu";
import { prisma } from "~/db.server";
import { hydrateObject, useMatchesData } from "~/utils";
import { GitHubCommit } from "../../github/githubApp.server";
import {
  hasAllEnvVars,
  parseEnvVars,
} from "../../models/repositoryProject.server";

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

  const envVars = parseEnvVars(project);

  const needsEnvVars = !hasAllEnvVars(project);

  const latestCommit = project.latestCommit as GitHubCommit;

  return typedjson({
    project,
    organizationSlug,
    needsEnvVars,
    envVars,
    latestCommit,
  });
}

export default function ProjectLayout() {
  const { project, organizationSlug } = useTypedLoaderData<typeof loader>();

  return (
    <SideMenuContainer>
      <ProjectSideMenu
        project={project}
        backPath={`/orgs/${organizationSlug}`}
      />
      <div className="grid w-full grid-rows-[3.6rem_auto] overflow-y-auto bg-slate-850">
        <Header context="projects" />
        <Container>
          <Outlet />
        </Container>{" "}
      </div>
    </SideMenuContainer>
  );
}

export function useCurrentProject() {
  const routeMatch = useMatchesData(
    "routes/__app/orgs/$organizationSlug/__org/projects/$projectP"
  );

  if (!routeMatch || !routeMatch.data.project) {
    throw new Error("Calling useCurrentProject outside of a project route");
  }

  const result = hydrateObject<UseDataFunctionReturn<typeof loader>>(
    routeMatch.data
  );

  return result;
}

export type CurrentProjectLoaderData = ReturnType<typeof useCurrentProject>;
export type CurrentProject = CurrentProjectLoaderData["project"];
