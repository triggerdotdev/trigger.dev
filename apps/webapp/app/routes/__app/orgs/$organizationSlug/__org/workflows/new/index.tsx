import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { CopyTextPanel } from "~/components/CopyTextButton";
import { Panel } from "~/components/layout/Panel";
import { ToxicA } from "~/components/primitives/Buttons";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { TemplatesGrid } from "~/components/templates/TemplatesGrid";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { TemplateListPresenter } from "~/presenters/templateListPresenter.server";

export const loader = async () => {
  const presenter = new TemplateListPresenter();
  return typedjson(await presenter.data());
};

export default function NewWorkflowStep1Page() {
  const { templates } = useTypedLoaderData<typeof loader>();
  const currentOrganization = useCurrentOrganization();
  const currentEnv = useDevEnvironment();

  if (currentOrganization === undefined) {
    return <></>;
  }

  if (currentEnv === undefined) {
    return <></>;
  }
  return (
    <div className="max-w-5xl">
      <>
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
            Or set up a new Node.js project ready for Trigger.dev by running one
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
    </div>
  );
}
