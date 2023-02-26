import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { CreateNewWorkflow } from "~/components/CreateNewWorkflow";
import { Container } from "~/components/layout/Container";
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
          <Title>Workflows</Title>
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
