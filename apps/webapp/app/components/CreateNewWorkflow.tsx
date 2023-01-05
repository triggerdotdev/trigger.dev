import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { PrimaryA, SecondaryA } from "./primitives/Buttons";
import { Body } from "./primitives/text/Body";
import { Header2 } from "./primitives/text/Headers";

export default function CreateNewWorkflow() {
  return (
    <>
      <Header2 size="small" className="mb-2 text-slate-400">
        Create a new workflow
      </Header2>
      <Body className="mb-4 max-w-md text-slate-300">
        Create a workflow in your code then trigger it using a test to see the
        runs appear here. For a head start, you can view some example workflows
        in the documentation.
      </Body>
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
