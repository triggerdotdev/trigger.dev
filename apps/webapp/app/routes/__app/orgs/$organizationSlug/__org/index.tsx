import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { CopyTextPanel } from "~/components/CopyTextButton";
import { CreateNewWorkflow } from "~/components/CreateNewWorkflow";
import { Container } from "~/components/layout/Container";
import { Panel } from "~/components/layout/Panel";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { TemplatesGrid } from "~/components/templates/TemplatesGrid";
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
    const { workflows, templates } = await presenter.data(
      params.organizationSlug,
      currentEnv
    );
    return typedjson({ workflows, templates });
  } catch (error: any) {
    console.error(error);
    throw new Response("Error ", { status: 400 });
  }
};

export default function Page() {
  const { workflows, templates } = useTypedLoaderData<typeof loader>();
  const currentOrganization = useCurrentOrganization();
  if (currentOrganization === undefined) {
    return <></>;
  }

  return (
    <Container>
      {workflows.length === 0 ? (
        <>
          <Title>Create your first workflow</Title>
          <div className="max-w-5xl">
            <SubTitle className="">Install the Trigger.dev package</SubTitle>
            <Panel className="mb-4">
              <CopyTextPanel value="npm create trigger@latest trigger_development_xxxxxxxxxxxxxxxxx" />
            </Panel>
            <SubTitle className="">Or clone a template</SubTitle>
            <div>
              <TemplatesGrid openInNewPage={false} templates={templates} />
            </div>
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
