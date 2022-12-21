import {
  ClockIcon,
  DocumentTextIcon,
  XCircleIcon,
  ArrowPathRoundedSquareIcon,
  BeakerIcon,
  CheckCircleIcon,
} from "@heroicons/react/24/solid";
import { Panel } from "~/components/layout/Panel";
import { PrimaryButton } from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";
import { Body } from "~/components/primitives/text/Body";
import {
  Header1,
  Header2,
  Header3,
  Header4,
} from "~/components/primitives/text/Headers";
import CodeBlock from "~/components/code/CodeBlock";
import type { ReactNode } from "react";
import { formatDateTime } from "~/utils";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { requireUserId } from "~/services/session.server";
import invariant from "tiny-invariant";
import { WorkflowRunPresenter } from "~/models/workflowRunPresenter.server";
import type { WorkflowRunStatus } from "~/models/workflowRun.server";
import humanizeDuration from "humanize-duration";

export const loader = async ({ request, params }: LoaderArgs) => {
  await requireUserId(request);
  const { runId } = params;
  invariant(runId, "runId is required");

  const presenter = new WorkflowRunPresenter();

  try {
    const run = await presenter.data(runId);
    return typedjson({ run });
  } catch (error: any) {
    console.error(error);
    throw new Response("Error ", { status: 404 });
  }
};

type Run = Awaited<ReturnType<WorkflowRunPresenter["data"]>>;
type Trigger = Run["trigger"];
type Step = Run["steps"][number];
type StepOrTriggerType = Step["type"] | Trigger["type"];
type TriggerType<T, K extends Trigger["type"]> = T extends { type: K }
  ? T
  : never;
type StepType<T, K extends Step["type"]> = T extends { type: K } ? T : never;

export default function Page() {
  const { run } = useTypedLoaderData<typeof loader>();
  const output = run.steps.find((s) => s.type === "OUTPUT") as
    | StepType<Step, "OUTPUT">
    | undefined;

  return (
    <>
      <div className="flex sticky -top-12 py-4 -mt-4 -ml-1 pl-1 bg-slate-850 justify-between items-center z-10">
        <Header1 className="">Run {run.id}</Header1>
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

      <ul className="flex gap-6 ml-[-3px]">
        <li className="flex gap-2 items-center">
          <StatusIcon status={run.status} />
          <Header2 size="small" className="text-slate-400">
            {statusLabel[run.status]}
          </Header2>
        </li>
        <li className="flex gap-1 items-center">
          <Header2 size="small" className="text-slate-400">
            {run.startedAt &&
              `Started: ${formatDateTime(run.startedAt, "long")}`}
          </Header2>
        </li>
        {run.duration && (
          <li className="flex gap-1 items-center">
            <Header2 size="small" className="text-slate-400">
              Duration: {humanizeDuration(run.duration)}
            </Header2>
          </li>
        )}
      </ul>

      <TriggerStep trigger={run.trigger} />

      {run.steps
        .filter((s) => s.type !== "OUTPUT")
        .map((step, index) => (
          <WorkflowStep key={index} step={step} />
        ))}

      {run.status === "SUCCESS" && (
        <Panel>
          <div className="flex gap-2 items-center border-b border-slate-700 pb-3 mb-4">
            <CheckCircleIcon className="h-5 w-5 text-green-500" />
            <Body size="small" className="text-slate-300">
              Run {run.id} complete
            </Body>
          </div>
          <div className="grid grid-cols-3 gap-2 text-slate-300">
            <div className="flex flex-col gap-1">
              <Body size="extra-small" className={workflowNodeUppercaseClasses}>
                Run duration:
              </Body>
              <Body className={workflowNodeDelayClasses} size="small">
                {run.duration && humanizeDuration(run.duration)}
              </Body>
            </div>
            <div className="flex flex-col gap-1">
              <Body size="extra-small" className={workflowNodeUppercaseClasses}>
                Started:
              </Body>
              <Body className={workflowNodeDelayClasses} size="small">
                {run.startedAt && formatDateTime(run.startedAt, "long")}
              </Body>
            </div>
            <div className="flex flex-col gap-1">
              <Body size="extra-small" className={workflowNodeUppercaseClasses}>
                Completed:
              </Body>
              <Body className={workflowNodeDelayClasses} size="small">
                {run.finishedAt && formatDateTime(run.finishedAt, "long")}
              </Body>
            </div>
          </div>
          {output && (
            <CodeBlock
              code={stringifyCode(output.output)}
              language="json"
              className="mt-2"
            />
          )}
        </Panel>
      )}
    </>
  );
}

function stringifyCode(obj: any) {
  return JSON.stringify(obj, null, 2);
}

const workflowNodeFlexClasses = "flex gap-1 items-baseline";
const workflowNodeUppercaseClasses = "uppercase text-slate-400";
const workflowNodeDelayClasses = "flex rounded-md bg-[#0F172A] p-3";

function TriggerStep({ trigger }: { trigger: Trigger }) {
  return (
    <div className="flex items-stretch w-full">
      <div className="relative flex w-5 border-l border-slate-700 ml-2.5">
        <div className="absolute top-6 -left-[18px] p-1 bg-slate-850 rounded-full">
          <StatusIcon status={trigger.status} />
        </div>
      </div>
      <StepPanel status={trigger.status}>
        <StepHeader
          stepType={trigger.type}
          title={typeLabel[trigger.type]}
          startedAt={trigger.startedAt}
          finishedAt={null}
          // integration={trigger.type === "WEBHOOK"}
        />
        <TriggerBody trigger={trigger} />
      </StepPanel>
    </div>
  );
}

function WorkflowStep({ step }: { step: Step }) {
  return (
    <div className="flex items-stretch w-full">
      <div className="relative flex w-5 border-l border-slate-700 ml-2.5">
        <div className="absolute top-6 -left-[18px] p-1 bg-slate-850 rounded-full">
          <StatusIcon status={step.status} />
        </div>
      </div>
      <StepPanel status={step.status}>
        <StepHeader
          stepType={step.type}
          title={typeLabel[step.type]}
          startedAt={step.startedAt}
          finishedAt={step.finishedAt}
          // integration={trigger.type === "WEBHOOK"}
        />
        <StepBody step={step} />
      </StepPanel>
    </div>
  );
}

function StepPanel({
  status,
  children,
}: {
  status: WorkflowRunStatus;
  children: ReactNode;
}) {
  let borderClass = "border-slate-800";
  switch (status) {
    case "ERROR":
      borderClass = "border-red-700";
      break;
    case "PENDING":
      borderClass = "border-blue-700";
      break;
  }

  return <Panel className={`border ${borderClass} my-4`}>{children}</Panel>;
}

function StepHeader({
  stepType,
  title,
  startedAt,
  finishedAt,
  integration,
}: {
  stepType: StepOrTriggerType;
  title: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  integration?: {
    name: string;
    logoUrl: string;
  };
}) {
  return (
    <div className="flex mb-4 pb-3 justify-between items-center border-b border-slate-700">
      <ul className="flex gap-4 items-center">
        <li className="flex gap-1 items-center">
          <StepIcon stepType={stepType} />
          <Body size="small">{title}</Body>
        </li>
        {startedAt && (
          <li className={workflowNodeFlexClasses}>
            <Body size="extra-small" className={workflowNodeUppercaseClasses}>
              Started:
            </Body>
            <Body size="small">{formatDateTime(startedAt)}</Body>
          </li>
        )}
        {finishedAt && (
          <li className={workflowNodeFlexClasses}>
            <Body size="extra-small" className={workflowNodeUppercaseClasses}>
              Completed:
            </Body>
            <Body size="small">{formatDateTime(finishedAt)}</Body>
          </li>
        )}
      </ul>
      {integration && (
        <div className="flex gap-2 items-center">
          <Body size="small">{integration.name}</Body>
          <img
            src={integration.logoUrl}
            alt={integration.name}
            className="h-8 shadow"
          />
        </div>
      )}
    </div>
  );
}

function TriggerBody({ trigger }: { trigger: Trigger }) {
  switch (trigger.type) {
    case "WEBHOOK":
      return <Webhook webhook={trigger} />;
    case "SCHEDULE":
      break;
    case "CUSTOM_EVENT":
      return <CustomEventTrigger event={trigger} />;
    case "HTTP_ENDPOINT":
      break;
    default:
      break;
  }
  return <></>;
}

function StepBody({ step }: { step: Step }) {
  switch (step.type) {
    case "LOG_MESSAGE":
      return <Log log={step} />;
    case "CUSTOM_EVENT":
      return <CustomEventStep event={step} />;
  }
  return <></>;
}

function Webhook({ webhook }: { webhook: TriggerType<Trigger, "WEBHOOK"> }) {
  return (
    <>
      <div className="flex justify-between items-baseline">
        <Header3 size="large" className="mb-4">
          {webhook.config.id}
        </Header3>
        <div className="flex items-baseline gap-2">
          {Object.entries(webhook.config.params).map(([key, value]) => (
            <div key={key} className="flex gap-1 items-baseline">
              <Body size="extra-small" className={workflowNodeUppercaseClasses}>
                {key}
              </Body>
              <Body size="small">{value}</Body>
            </div>
          ))}
        </div>
      </div>
      {/* <CodeBlock code={JSON.stringify(webhook.input)} language="json" /> */}
    </>
  );
}

// function Delay({ step }: { step: DelayStep }) {
//   return (
//     <div className="grid grid-cols-3 gap-2 text-slate-300">
//       <div className="flex flex-col gap-1">
//         <Body size="extra-small" className={workflowNodeUppercaseClasses}>
//           Total delay:
//         </Body>
//         <Body className={workflowNodeDelayClasses} size="small">
//           3 days 5 hrs 30 mins 10 secs
//         </Body>
//       </div>
//       <div className="flex flex-col gap-1">
//         <Body size="extra-small" className={workflowNodeUppercaseClasses}>
//           Fires at:
//         </Body>
//         <Body className={workflowNodeDelayClasses} size="small">
//           3:45pm Dec 22 2022
//         </Body>
//       </div>
//       <div className="flex flex-col gap-1">
//         <Body size="extra-small" className={workflowNodeUppercaseClasses}>
//           Fires in:
//         </Body>
//         <Body className={workflowNodeDelayClasses} size="small">
//           2 days 16 hours 30 mins 10 secs
//         </Body>
//       </div>
//     </div>
//   );
// }

function CustomEventTrigger({
  event,
}: {
  event: TriggerType<Trigger, "CUSTOM_EVENT">;
}) {
  return (
    <>
      <Header2 size="large" className="mb-4">
        {event.config.name}
      </Header2>
      {/* <CodeBlock code={JSON.stringify(event.payload)} /> */}
    </>
  );
}

function CustomEventStep({ event }: { event: StepType<Step, "CUSTOM_EVENT"> }) {
  return (
    <>
      <Header2 size="large" className="mb-4">
        {event.input.name}
      </Header2>
      <Header4>Payload</Header4>
      <CodeBlock code={stringifyCode(event.input.payload)} />
      {event.input.context && (
        <>
          <Header4>Context</Header4>
          <CodeBlock code={stringifyCode(event.input.context)} />
        </>
      )}
    </>
  );
}

// function Email({ email }: { email: string }) {
//   return <CodeBlock code={email} />;
// }

function Log({ log }: { log: StepType<Step, "LOG_MESSAGE"> }) {
  return (
    <>
      <Header4>{log.input.level}</Header4>
      <CodeBlock code={log.input.message} />
      <CodeBlock code={stringifyCode(log.input.properties)} />
    </>
  );
}

// function StepError({ step }: { step: Step }) {
//   return (
//     <>
//       <div className="flex gap-2 mb-2 mt-3 ">
//         <ExclamationTriangleIcon className="h-5 w-5 text-red-600" />
//         <Body size="small" className="text-slate-300">
//           Failed with error:
//         </Body>
//       </div>
//       <CodeBlock
//         code={JSON.stringify(step.error)}
//         language="json"
//         className="border border-red-600"
//       />
//     </>
//   );
// }

function StatusIcon({ status }: { status: WorkflowRunStatus }) {
  switch (status) {
    case "ERROR":
      return <XCircleIcon className="relative h-7 w-7 text-red-500" />;
    case "PENDING":
      return <ClockIcon className="relative h-7 w-7 text-slate-500" />;
    case "SUCCESS":
      return <CheckCircleIcon className="relative h-7 w-7 text-green-500" />;
    case "RUNNING":
      return <Spinner className="relative h-6 w-6 ml-[1px] text-blue-500" />;
  }
}

function StepIcon({ stepType }: { stepType: StepOrTriggerType }) {
  const styleClass = "h-6 w-6 text-slate-400";
  switch (stepType) {
    case "LOG_MESSAGE":
      return <DocumentTextIcon className={styleClass} />;
    case "CUSTOM_EVENT":
      return <DocumentTextIcon className={styleClass} />;
    case "OUTPUT":
      return <DocumentTextIcon className={styleClass} />;
    case "WEBHOOK":
      return <DocumentTextIcon className={styleClass} />;
    case "HTTP_ENDPOINT":
      return <DocumentTextIcon className={styleClass} />;
    case "SCHEDULE":
      return <DocumentTextIcon className={styleClass} />;
  }
}

const statusLabel: Record<WorkflowRunStatus, string> = {
  SUCCESS: "Success",
  PENDING: "In progress",
  RUNNING: "Running",
  ERROR: "Error",
} as const;

const typeLabel: Record<StepOrTriggerType, string> = {
  LOG_MESSAGE: "Log",
  CUSTOM_EVENT: "Custom",
  OUTPUT: "Output",
  WEBHOOK: "Webhook",
  HTTP_ENDPOINT: "HTTP",
  SCHEDULE: "Scheduled",
} as const;
