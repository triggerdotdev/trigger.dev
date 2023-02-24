import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import type { TemplateListItem } from "~/presenters/templateListPresenter.server";
import { obfuscateApiKey } from "~/utils";
import { CopyTextPanel } from "../CopyTextButton";
import { Panel } from "../layout/Panel";
import { ToxicA } from "../primitives/Buttons";
import { SubTitle } from "../primitives/text/SubTitle";
import { TemplatesGrid } from "../templates/TemplatesGrid";

export function WorkflowOnboarding({
  apiKey,
  templates,
}: {
  apiKey: string;
  templates: TemplateListItem[];
}) {
  return (
    <>
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
          value={`npm create trigger@latest -k ${apiKey}`}
          text={`npm create trigger@latest -k ${obfuscateApiKey(apiKey)}`}
        />
      </Panel>
      <SubTitle className="">Or start from a template</SubTitle>
      <div>
        <TemplatesGrid
          openInNewPage={false}
          templates={templates}
          commandFlags={`-k ${apiKey}`}
        />
      </div>
    </>
  );
}
