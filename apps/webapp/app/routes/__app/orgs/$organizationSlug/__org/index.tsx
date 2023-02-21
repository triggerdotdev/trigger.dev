import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { CreateNewWorkflow } from "~/components/CreateNewWorkflow";
import { Container } from "~/components/layout/Container";
import { PanelInfo } from "~/components/layout/PanelInfo";
import { PrimaryLink } from "~/components/primitives/Buttons";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { WorkflowList } from "~/components/workflows/workflowList";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { getRuntimeEnvironmentFromRequest } from "~/models/runtimeEnvironment.server";
import { WorkflowListPresenter } from "~/presenters/workflowListPresenter.server";
import { requireUserId } from "~/services/session.server";

export const loader = async ({ request, params }: LoaderArgs) => {
  await requireUserId(request);
  invariant(params.organizationSlug, "Organization slug is required");

  const currentEnv = await getRuntimeEnvironmentFromRequest(request);

  const presenter = new WorkflowListPresenter();

  try {
    const workflows = await presenter.data(params.organizationSlug, currentEnv);
    return typedjson({ workflows });
  } catch (error: any) {
    console.error(error);
    throw new Response("Error ", { status: 400 });
  }
};

export default function Page() {
  const { workflows } = useTypedLoaderData<typeof loader>();
  const currentOrganization = useCurrentOrganization();
  if (currentOrganization === undefined) {
    return <></>;
  }

  return (
    <Container>
      <Title>Workflows</Title>
      {workflows.length === 0 ? (
        <>
          <SubTitle>0 workflows</SubTitle>
          <PanelInfo
            message="You don't have any workflows yet. They will appear here once
              connected."
            className="mb-4 max-w-4xl p-4 pr-6"
          >
            <PrimaryLink to={`/orgs/${currentOrganization.slug}/workflows/new`}>
              Create first workflow
            </PrimaryLink>
          </PanelInfo>
        </>
      ) : (
        <>
          <SubTitle>
            {workflows.length} active workflow{workflows.length > 1 ? "s" : ""}
          </SubTitle>
          <WorkflowList
            workflows={workflows}
            currentOrganizationSlug={currentOrganization.slug}
          />
          <CreateNewWorkflow />
        </>
      )}
    </Container>
  );
}
