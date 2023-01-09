import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { Panel } from "./layout/Panel";
import { PrimaryA, SecondaryA } from "./primitives/Buttons";
import { Body } from "./primitives/text/Body";
import onboarding from "../assets/images/onboarding-image.png";
import { SubTitle } from "./primitives/text/SubTitle";

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
          href="https://docs.trigger.dev"
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
        <div className="flex flex-col p-6 w-2/3">
          <Body className="mb-4 text-slate-300">
            Create a workflow in your code then trigger it using a test to see
            the runs appear here. For a head start, you can view some example
            workflows in the documentation.
          </Body>
          <div className="flex gap-2 flex-wrap">
            <PrimaryA
              href="https://docs.trigger.dev"
              target="_blank"
              rel="noreferrer"
            >
              <ArrowTopRightOnSquareIcon className="w-4 h-4" />
              <span>Documentation</span>
            </PrimaryA>
            <SecondaryA
              href="https://docs.trigger.dev"
              target="_blank"
              rel="noreferrer"
            >
              <ArrowTopRightOnSquareIcon className="w-4 h-4" />
              <span>Example workflows</span>
            </SecondaryA>
          </div>
        </div>
        <div className="flex flex-col bg-indigo-600 w-1/3">
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
