import { PlusIcon } from "@heroicons/react/24/outline";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { CreateNewWorkflow } from "~/components/CreateNewWorkflow";
import { AppBody, AppLayoutTwoCol } from "~/components/layout/AppLayout";
import { Container } from "~/components/layout/Container";
import { Header } from "~/components/layout/Header";
import { OrganizationsSideMenu } from "~/components/navigation/SideMenu";
import { PrimaryLink } from "~/components/primitives/Buttons";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { WorkflowList } from "~/components/workflows/workflowList";
import { WorkflowOnboarding } from "~/components/workflows/WorkflowOnboarding";
import { useDevEnvironment } from "~/hooks/useEnvironments";
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
    return typedjson(await presenter.data(params.organizationSlug, currentEnv));
  } catch (error: any) {
    console.error(error);
    throw new Response("Error ", { status: 400 });
  }
};

export default function Page() {
  const { workflows, templates } = useTypedLoaderData<typeof loader>();
  const currentOrganization = useCurrentOrganization();
  const currentEnv = useDevEnvironment();

  if (currentOrganization === undefined) {
    return <></>;
  }

  if (currentEnv === undefined) {
    return <></>;
  }

  return (
    <AppLayoutTwoCol>
      <OrganizationsSideMenu />
      <AppBody>
        <Header context="workflows" />
        <Container>
          {workflows.length === 0 ? (
            <>
              <Title>Create your first workflow</Title>
              <div className="max-w-6xl">
                <WorkflowOnboarding
                  templates={templates}
                  apiKey={currentEnv.apiKey}
                />
              </div>
            </>
          ) : (
            <>
              <div className="flex items-start justify-between">
                <Title>Workflows</Title>
                <PrimaryLink
                  to={`/orgs/${currentOrganization.slug}/workflows/new`}
                  rel="noreferrer"
                >
                  <PlusIcon className="-ml-1 h-4 w-4" />
                  New Workflow
                </PrimaryLink>
              </div>
              <SubTitle>
                {workflows.length} active workflow
                {workflows.length > 1 ? "s" : ""}
              </SubTitle>
              <WorkflowList
                workflows={workflows}
                currentOrganizationSlug={currentOrganization.slug}
              />
            </>
          )}
        </Container>
      </AppBody>
    </AppLayoutTwoCol>
  );
}
