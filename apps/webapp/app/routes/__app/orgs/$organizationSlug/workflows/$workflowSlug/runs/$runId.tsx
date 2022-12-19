import {
  ClockIcon,
  PlayCircleIcon,
  XCircleIcon,
} from "@heroicons/react/24/solid";
import {
  ArrowPathRoundedSquareIcon,
  BeakerIcon,
} from "@heroicons/react/24/solid";
import { Panel } from "~/components/layout/Panel";
import { PrimaryButton } from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";
import { Select } from "~/components/primitives/Select";
import { Body } from "~/components/primitives/text/Body";
import {
  Header1,
  Header2,
  Header3,
} from "~/components/primitives/text/Headers";
import CodeBlock from "~/components/code/CodeBlock";
import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { WorkflowNodeArrow } from "~/components/WorkflowNodeArrow";
import type { FC } from "react";

export default function Page() {
  return (
    <>
      <div className="flex sticky -top-12 py-4 bg-slate-850 justify-between items-center z-10">
        <Header1 className="">Run #1</Header1>
        <div className="flex gap-2">
          <Body
            size="extra-small"
            className="flex items-center pl-2 pr-3 py-0.5 rounded uppercase tracking-wide text-slate-500"
          >
            <BeakerIcon className="h-4 w-4 mr-1" />
            Test Run
          </Body>
          <PrimaryButton>
            <ArrowPathRoundedSquareIcon className="h-5 w-5 -ml-1" />
            Rerun
          </PrimaryButton>
        </div>
      </div>

      <ul className="flex gap-6 mb-4">
        <li className="flex gap-2 items-center">
          <Spinner />
          <Header2 size="small" className="text-slate-400">
            In progress
          </Header2>
        </li>
        <li className="flex gap-1 items-center">
          <PlayCircleIcon className="h-5 w-5 text-slate-400" />
          <Header2 size="small" className="text-slate-400">
            Started: 12:34:56pm Dec 13, 2022
          </Header2>
        </li>
        <li className="flex gap-1 items-center">
          <ClockIcon className="h-5 w-5 text-slate-400" />
          <Header2 size="small" className="text-slate-400">
            Duration: 1m 23s
          </Header2>
        </li>
      </ul>

      <WorkflowStep status={"complete"} />
      <WorkflowNodeArrow />
      <WorkflowStep status={"error"} />
      <WorkflowNodeArrow />
      <WorkflowStep status={"inProgress"} />
      <WorkflowNodeArrow />
      <WorkflowStep status={"notStarted"} />
    </>
  );
}

type WorkflowStepProps = {
  status: "error" | "inProgress" | "complete" | "notStarted";
};

const WorkflowStep: FC<WorkflowStepProps> = (props) => {
  const workflowNodeFlexClasses = "flex gap-1 items-baseline";
  const workflowNodeUppercaseClasses = "uppercase text-slate-400";
  const workflowNode1code = `{ 
  "assignee": "samejr",
  "issueId": "uiydfgydfg7yt34"
}`;

  let icon;
  let statusText;
  let borderColor;

  switch (props.status) {
    case "error":
      icon = (
        <XCircleIcon className="relative top-[3px] h-4 w-4 text-red-500" />
      );
      statusText = "Error";
      borderColor = "border-red-700";
      break;
    case "inProgress":
      icon = <Spinner className="relative top-[3px] h-4 w-4 text-blue-500" />;
      statusText = "In progress";
      borderColor = "border-blue-700";
      break;
    case "complete":
      icon = (
        <CheckCircleIcon className="relative top-[3px] h-4 w-4 text-green-500" />
      );
      statusText = "Complete";
      borderColor = "border-slate-800";
      break;
    default:
      icon = (
        <ClockIcon className="relative top-[3px] h-4 w-4 text-slate-500" />
      );
      statusText = "Not started";
      borderColor = "border-slate-800";
  }
  return (
    <Panel className={`border ${borderColor}`}>
      <div className="flex mb-4 pb-3 justify-between items-center border-b border-slate-700">
        <ul className="flex gap-4 items-center">
          <li className={workflowNodeFlexClasses}>
            <Body size="extra-small" className={workflowNodeUppercaseClasses}>
              Type:
            </Body>
            <Body size="small">Trigger</Body>
          </li>
          <li className={workflowNodeFlexClasses}>
            <Body size="extra-small" className={workflowNodeUppercaseClasses}>
              Step:
            </Body>
            <div className="flex gap-0.5 items-baseline">
              {icon}
              <Body size="small">{statusText}</Body>
            </div>
          </li>
          <li className={workflowNodeFlexClasses}>
            <Body size="extra-small" className={workflowNodeUppercaseClasses}>
              Org:
            </Body>
            <Body size="small">apihero-run</Body>
          </li>
          <li className={workflowNodeFlexClasses}>
            <Body size="extra-small" className={workflowNodeUppercaseClasses}>
              Repo:
            </Body>
            <Body size="small">jsonhero-web</Body>
          </li>
        </ul>
        <Select>
          <option value="GitHub #1">GitHub #1</option>
          <option value="GitHub #2">GitHub #2</option>
          <option value="GitHub #3">GitHub #3</option>
        </Select>
      </div>
      <Header3 size="large" className="mb-4">
        GitHub new issue (Webhook)
      </Header3>
      <CodeBlock code={workflowNode1code} language="json" />
    </Panel>
  );
};
