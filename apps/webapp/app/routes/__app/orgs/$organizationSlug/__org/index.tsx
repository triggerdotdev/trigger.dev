import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { CopyTextPanel } from "~/components/CopyTextButton";
import { CreateNewWorkflow } from "~/components/CreateNewWorkflow";
import { Container } from "~/components/layout/Container";
import { Panel } from "~/components/layout/Panel";
import { ToxicA } from "~/components/primitives/Buttons";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { TemplatesGrid } from "~/components/templates/TemplatesGrid";
import { WorkflowList } from "~/components/workflows/workflowList";
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
          <div className="max-w-5xl">
            <SubTitle className="">
              Add Trigger.dev to an existing Node.js repo
            </SubTitle>
            <div>
              <ToxicA
                href="https://docs.trigger.dev/getting-started#manual-setup"
                target="_blank"
              >
                Manual Setup docs
                <ArrowTopRightOnSquareIcon className="ml-1 h-4 w-4" />
              </ToxicA>
            </div>
            <SubTitle className="mt-6">
              Or set up a Node.js project ready for Trigger.dev by running one
              command
            </SubTitle>
            <Panel className="mb-4">
              <CopyTextPanel
                value={`npm create trigger@latest -k ${currentEnv.apiKey}`}
              />
            </Panel>
            <SubTitle className="">Or start from a template</SubTitle>
            <div>
              <TemplatesGrid
                openInNewPage={false}
                templates={templates}
                commandFlags={`-k ${currentEnv.apiKey}`}
              />
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
