import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { Panel } from "./layout/Panel";
import { PrimaryA, SecondaryA, TertiaryA } from "./primitives/Buttons";
import { Body } from "./primitives/text/Body";
import onboarding from "../assets/images/onboarding-image.png";
import { SubTitle } from "./primitives/text/SubTitle";
import { Header3 } from "./primitives/text/Headers";

export default function CreateNewWorkflow() {
  return (
    <>
      <SubTitle>Create a new workflow</SubTitle>
      <div className="flex gap-2">
        <PrimaryA
          href="https://docs.trigger.dev"
          target="_blank"
          rel="noreferrer"
        >
          <ArrowTopRightOnSquareIcon className="w-4 h-4" />
          <span>Documentation</span>
        </PrimaryA>
        <SecondaryA
          href="https://docs.trigger.dev/examples/examples"
          target="_blank"
          rel="noreferrer"
        >
          <ArrowTopRightOnSquareIcon className="w-4 h-4" />
          <span>Example workflows</span>
        </SecondaryA>
      </div>
    </>
  );
}

export function CreateNewWorkflowNoWorkflows() {
  return (
    <>
      <Panel className="flex p-0 overflow-hidden">
        <div className="flex flex-col p-6 w-full xl:w-2/3 text-slate-300 ">
          <Body className="mb-5 px-3.5 py-2 bg-slate-700 rounded border border-slate-600">
            Trigger.dev workflows are written in your own codebase and run in
            your existing infrastructure.
          </Body>
          <Body
            size="small"
            className="mb-2 uppercase tracking-wide text-slate-400"
          >
            To get started
          </Body>
          <ol className="flex flex-col gap-2 list-decimal marker:text-slate-400 ml-5 mb-6">
            <li>
              Check out the Quick Start Guide to create your first workflow in
              your code.
            </li>
            <li>
              Trigger the workflow by writing a test on the Test page. The
              workflow run will then appear on the Runs page.
            </li>
            <li>
              If you need to authenticate with an API, the Runs page will
              display a prompt to connect.
            </li>
          </ol>
          <div className="flex gap-2">
            <PrimaryA
              href="https://docs.trigger.dev"
              target="_blank"
              rel="noreferrer"
            >
              <ArrowTopRightOnSquareIcon className="w-4 h-4" />
              <span>Quick Start Guide</span>
            </PrimaryA>
            <SecondaryA
              href="https://docs.trigger.dev/examples/examples"
              target="_blank"
              rel="noreferrer"
            >
              <ArrowTopRightOnSquareIcon className="w-4 h-4" />
              <span>Example workflows</span>
            </SecondaryA>
          </div>
        </div>
        <div className="hidden xl:flex flex-col w-1/3">
          <img
            src={onboarding}
            alt="Create a new Workflow"
            className="w-full h-full object-cover"
          />
        </div>
      </Panel>
    </>
  );
}
