import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import {
  WorkflowsSideMenu,
  SideMenuContainer,
} from "~/components/navigation/SideMenu";
import { Header1 } from "~/components/primitives/text/Headers";
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

  return typedjson({ workflow });
};

export default function Organization() {
  const { workflow } = useTypedLoaderData<typeof loader>();

  return (
    <>
      <SideMenuContainer>
        <WorkflowsSideMenu />
        <Header1>{workflow.title}</Header1>

        <Outlet />
      </SideMenuContainer>
    </>
  );
}
