import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { Container } from "~/components/layout/Container";
import {
  WorkflowsSideMenu,
  SideMenuContainer,
} from "~/components/navigation/SideMenu";
import { Header1, Header2 } from "~/components/primitives/text/Headers";
import {
  commitSession,
  getRuntimeEnvironmentFromSession,
  getSession,
} from "~/models/runtimeEnvironment.server";
import { getWorkflowFromSlugs } from "~/models/workflow.server";
import { requireUserId } from "~/services/session.server";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, workflowSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");
  invariant(workflowSlug, "workflowSlug not found");

  const workflow = await getWorkflowFromSlugs({
    userId,
    organizationSlug,
    workflowSlug,
  });

  if (workflow === null) {
    throw new Response("Not Found", { status: 404 });
  }

  const environmentSession = await getSession(request.headers.get("cookie"));
  const currentEnvironmentSlug = await getRuntimeEnvironmentFromSession(
    environmentSession
  );

  return typedjson(
    { workflow, currentEnvironmentSlug },
    { headers: { "Set-Cookie": await commitSession(environmentSession) } }
  );
};

export default function Page() {
  return (
    <>
      <SideMenuContainer>
        <WorkflowsSideMenu />
        <Container>
          <Outlet />
        </Container>
      </SideMenuContainer>
    </>
  );
}
