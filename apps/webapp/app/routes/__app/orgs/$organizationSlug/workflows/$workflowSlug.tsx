import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import { integrations } from "~/components/integrations/ConnectButton";
import { Container } from "~/components/layout/Container";
import {
  WorkflowsSideMenu,
  SideMenuContainer,
} from "~/components/navigation/SideMenu";
import { getConnectedApiConnectionsForOrganizationSlug } from "~/models/apiConnection.server";
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

  const allConnections = await getConnectedApiConnectionsForOrganizationSlug({
    slug: organizationSlug,
  });

  const slots = workflow.externalSource ? [workflow.externalSource] : [];

  const connectionSlots = slots.map((c) => ({
    ...c,
    possibleConnections: allConnections.filter(
      (a) => a.apiIdentifier === c.service
    ),
    integration: integrations.find((i) => i.key === c.service),
  }));

  return typedjson(
    { workflow, currentEnvironmentSlug, connectionSlots },
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
