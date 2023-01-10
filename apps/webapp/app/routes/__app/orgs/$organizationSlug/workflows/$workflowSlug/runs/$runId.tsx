import { BeakerIcon } from "@heroicons/react/20/solid";
import {
  BoltIcon,
  ChatBubbleLeftEllipsisIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  GlobeAltIcon,
} from "@heroicons/react/24/outline";
import {
  ArrowPathRoundedSquareIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  ChatBubbleOvalLeftEllipsisIcon,
} from "@heroicons/react/24/solid";
import { useFetcher } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import type { Delay, Scheduled } from "@trigger.dev/common-schemas";
import classNames from "classnames";
import humanizeDuration from "humanize-duration";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import CodeBlock from "~/components/code/CodeBlock";
import { BasicConnectButton } from "~/components/integrations/ConnectButton";
import { Panel } from "~/components/layout/Panel";
import { PanelHeader } from "~/components/layout/PanelHeader";
import { PrimaryButton } from "~/components/primitives/Buttons";
import { Body } from "~/components/primitives/text/Body";
import {
  Header1,
  Header2,
  Header4,
} from "~/components/primitives/text/Headers";
import { runStatusIcon, runStatusLabel } from "~/components/runs/runStatus";
import { TriggerBody } from "~/components/triggers/Trigger";
import { triggerInfo } from "~/components/triggers/triggerTypes";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";
import type { WorkflowRunStatus } from "~/models/workflowRun.server";
import { WorkflowRunPresenter } from "~/models/workflowRunPresenter.server";
import { requireUserId } from "~/services/session.server";
import { dateDifference, formatDateTime } from "~/utils";
import { calculateDurationInMs } from "~/utils/delays";

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
    throw new Response("Error ", { status: 400 });
  }
};

type Run = Awaited<ReturnType<WorkflowRunPresenter["data"]>>;
type Trigger = Run["trigger"];
type Step = Run["steps"][number];
type StepType<T, K extends Step["type"]> = T extends { type: K } ? T : never;

export default function Page() {
  const rerunFetcher = useFetcher();
  const { run } = useTypedLoaderData<typeof loader>();
  const output = run.steps.find((s) => s.type === "OUTPUT") as
    | StepType<Step, "OUTPUT">
    | undefined;
  const organization = useCurrentOrganization();
  invariant(organization, "organization is required");
  const workflow = useCurrentWorkflow();
  invariant(workflow, "workflow is required");

  return (
    <>
      <div className="flex sticky -top-12 py-4 -mt-4 -ml-1 pl-1 bg-slate-850 justify-between items-center z-10">
        <Header1 className="truncate text-slate-300">Run {run.id}</Header1>
        <div className="flex gap-2">
          {run.isTest && (
            <Body
              size="extra-small"
              className="flex items-center pl-2 pr-3 py-0.5 rounded uppercase whitespace-nowrap tracking-wide text-slate-500"
            >
              <BeakerIcon className="h-4 w-4 mr-1" />
              Test Run
            </Body>
          )}
          <rerunFetcher.Form
            action={`/resources/run/${organization.slug}/test/${workflow.slug}`}
            method="post"
          >
            <input
              type={"hidden"}
              name={"eventName"}
              value={run.trigger.eventName}
            />
            <input
              type={"hidden"}
              name={"payload"}
              value={JSON.stringify(run.trigger.input)}
            />
            <PrimaryButton
              type="submit"
              name="source"
              value="rerun"
              onClick={(e) => {
                if (
                  !confirm(
                    "Are you sure you want to create a new run with the same payload?"
                  )
                ) {
                  e.preventDefault();
                }
              }}
            >
              <ArrowPathRoundedSquareIcon className="h-5 w-5 -ml-1" />
              Rerun
            </PrimaryButton>
          </rerunFetcher.Form>
        </div>
      </div>

      <ul className="flex gap-6 ml-[-3px] flex-wrap">
        <li className="flex gap-2 items-center">
          {runStatusIcon(run.status, "large")}
          <Header2 size="small" className="text-slate-400">
            {runStatusLabel(run.status)}
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
        <>
          <div className="h-3 w-full ml-[10px] border-l border-slate-700"></div>
          <Panel>
            <PanelHeader
              icon={<CheckCircleIcon className="h-6 w-6 text-green-500" />}
              title="Run complete"
              runId={run.id}
            />
            <div className="grid grid-cols-3 gap-2 text-slate-300">
              <div className="flex flex-col gap-1">
                <Body
                  size="extra-small"
                  className={workflowNodeUppercaseClasses}
                >
                  Run duration
                </Body>
                <Body className={workflowNodeDelayClasses} size="small">
                  {run.duration && humanizeDuration(run.duration)}
                </Body>
              </div>
              <div className="flex flex-col gap-1">
                <Body
                  size="extra-small"
                  className={workflowNodeUppercaseClasses}
                >
                  Started
                </Body>
                <Body className={workflowNodeDelayClasses} size="small">
                  {run.startedAt && formatDateTime(run.startedAt, "long")}
                </Body>
              </div>
              <div className="flex flex-col gap-1">
                <Body
                  size="extra-small"
                  className={workflowNodeUppercaseClasses}
                >
                  Completed
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
                align="top"
                maxHeight="150px"
              />
            )}
          </Panel>
        </>
      )}

      {run.status === "PENDING" && (
        <div className="h-10 w-full ml-[10px] border-dashed border-l border-gradient border-slate-700"></div>
      )}

      {run.error && <Error error={run.error} />}
    </>
  );
}

function stringifyCode(obj: any) {
  return JSON.stringify(obj, null, 2);
}

const workflowNodeUppercaseClasses = "uppercase text-slate-400 tracking-wider";
const workflowNodeDelayClasses =
  "flex rounded-md bg-[#0F172A] pl-4 p-3 font-mono";

function TriggerStep({ trigger }: { trigger: Trigger }) {
  return (
    <>
      <Panel className="mt-4">
        <PanelHeader
          icon={triggerInfo[trigger.type].icon}
          title={triggerInfo[trigger.type].label}
          startedAt={trigger.startedAt}
          finishedAt={null}
          name="Initial wait"
          // integration={trigger.type === "WEBHOOK"}
        />
        <TriggerBody trigger={trigger} />
        {trigger.input && (
          <CodeBlock
            code={stringifyCode(trigger.input)}
            align="top"
            maxHeight="150px"
            className="mt-2"
          />
        )}
      </Panel>
      <div className="h-3 w-full ml-[10px] border-l border-slate-700"></div>
    </>
  );
}

function WorkflowStep({ step }: { step: Step }) {
  const [showCodeBlock, setShowCodeBlock] = useState(false);
  const toggleCodeBlock = () => {
    setShowCodeBlock(!showCodeBlock);
  };
  switch (step.type) {
    case "DISCONNECTION":
      return (
        <div className="flex items-stretch w-full">
          <div className="relative flex w-5 border-l border-dashed border-slate-700 ml-2.5">
            <div className="absolute top-2 -left-[18px] p-1 bg-slate-850 rounded-full">
              {runStatusIcon("DISCONNECTED", "large")}
            </div>
          </div>

          <Body
            size="small"
            className={classNames("font-mono my-4 ml-0.5 text-slate-400")}
          >
            {step.startedAt && step.finishedAt
              ? `The run disconnected for ${humanizeDuration(
                  dateDifference(step.startedAt, step.finishedAt),
                  { round: true }
                )} here.`
              : step.startedAt
              ? `The run disconnected on ${formatDateTime(
                  step.startedAt,
                  "long"
                )}.`
              : "Disconnected"}
          </Body>
        </div>
      );
    case "LOG_MESSAGE":
      return (
        <div className="flex items-stretch w-full">
          <div className="relative flex w-5 border-l border-slate-700 ml-2.5">
            <div className="absolute top-2 -left-[18px] p-1 bg-slate-850 rounded-full">
              <ChatBubbleOvalLeftEllipsisIcon
                className={classNames("h-7 w-7", logColor[step.input.level])}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2 w-full my-4">
            <div className={classNames("flex gap-2 items-center")}>
              <Body
                size="small"
                className={classNames(
                  "ml-1 font-mono",
                  logColor[step.input.level]
                )}
              >
                {step.input.message}
              </Body>

              {step.input.properties &&
                Object.keys(step.input.properties).length !== 0 && (
                  <button
                    onClick={toggleCodeBlock}
                    className="text-sm text-slate-400 hover:text-slate-200 transition"
                  >
                    {showCodeBlock ? (
                      <span className="flex gap-1 items-center">
                        Hide custom fields <ChevronUpIcon className="h-4 w-4" />
                      </span>
                    ) : (
                      <span className="flex gap-1 items-center">
                        View custom fields{" "}
                        <ChevronDownIcon className="h-4 w-4" />
                      </span>
                    )}
                  </button>
                )}
            </div>

            {step.input.properties &&
              Object.keys(step.input.properties).length !== 0 &&
              showCodeBlock && (
                <CodeBlock
                  code={stringifyCode(step.input.properties)}
                  align="top"
                  maxHeight="150px"
                />
              )}
          </div>
        </div>
      );
    default:
      return (
        <div className="flex items-stretch w-full">
          <div className="relative flex w-5 border-l border-slate-700 ml-2.5">
            <div className="absolute top-[23px] -left-[18px] p-1 bg-slate-850 rounded-full">
              {runStatusIcon(step.status, "large")}
            </div>
          </div>
          <StepPanel status={step.status}>
            <StepHeader step={step} />
            <StepBody step={step} />
          </StepPanel>
        </div>
      );
  }
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
      borderClass = "border-rose-700";
      break;
    case "PENDING":
      borderClass = "border-blue-700";
      break;
  }

  return <Panel className={`border ${borderClass} my-4`}>{children}</Panel>;
}

function StepHeader({ step }: { step: Step }) {
  switch (step.type) {
    case "INTEGRATION_REQUEST":
      return (
        <PanelHeader
          icon={
            <img
              src={step.service.integration.icon}
              alt={step.service.integration.name}
              className="h-5 w-5 mr-1"
            />
          }
          title={step.service.integration.name}
          startedAt={step.startedAt}
          finishedAt={step.finishedAt}
          integration={step.service.connection?.title}
        />
      );
    default:
      return (
        <PanelHeader
          icon={stepInfo[step.type].icon}
          title={stepInfo[step.type].label}
          startedAt={step.startedAt}
          finishedAt={step.finishedAt}
        />
      );
  }
}

function InputTitle() {
  return (
    <Body size="extra-small" className={`mb-1 ${workflowNodeUppercaseClasses}`}>
      Input
    </Body>
  );
}

function OutputTitle() {
  return (
    <Body size="extra-small" className={`mb-1 ${workflowNodeUppercaseClasses}`}>
      Output
    </Body>
  );
}

function StepBody({ step }: { step: Step }) {
  switch (step.type) {
    case "CUSTOM_EVENT":
      return <CustomEventStep event={step} />;
    case "INTEGRATION_REQUEST":
      return <IntegrationRequestStep request={step} />;
    case "DURABLE_DELAY":
      return <DelayStep step={step} />;
  }
  return <></>;
}

function DelayStep({ step }: { step: StepType<Step, "DURABLE_DELAY"> }) {
  switch (step.input.type) {
    case "DELAY":
      return <DelayDuration step={step} delay={step.input} />;
    case "SCHEDULE_FOR":
      return <DelayScheduled step={step} scheduled={step.input} />;
  }
}

function DelayDuration({
  step,
  delay,
}: {
  step: StepType<Step, "DURABLE_DELAY">;
  delay: Delay;
}) {
  const msDelay = calculateDurationInMs(delay);
  const [timeRemaining, setTimeRemaining] = useState(
    step.startedAt
      ? msDelay - dateDifference(step.startedAt, new Date())
      : undefined
  );

  useEffect(() => {
    if (timeRemaining === undefined) return;
    const interval = setInterval(() => {
      setTimeRemaining((timeRemaining) => {
        if (timeRemaining === undefined) return undefined;
        if (timeRemaining <= 1000) return 0;
        if (timeRemaining <= 0) {
          clearInterval(interval);
          return 0;
        }

        return timeRemaining - 1000;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [timeRemaining]);

  return (
    <div className="grid grid-cols-2 gap-2 text-slate-300">
      <div className="flex flex-col gap-1">
        <Body size="extra-small" className={workflowNodeUppercaseClasses}>
          Total delay
        </Body>
        <Body
          className={classNames(workflowNodeDelayClasses, "w-full")}
          size="small"
        >
          {humanizeDuration(msDelay)}
        </Body>
      </div>
      {step.status === "PENDING" && timeRemaining && (
        <div className="flex flex-col gap-1">
          <Body size="extra-small" className={workflowNodeUppercaseClasses}>
            Fires in
          </Body>
          <Body
            className={classNames(workflowNodeDelayClasses, "w-full")}
            size="small"
          >
            {humanizeDuration(timeRemaining, { round: true })}
          </Body>
        </div>
      )}
    </div>
  );
}

function DelayScheduled({
  step,
  scheduled,
}: {
  step: StepType<Step, "DURABLE_DELAY">;
  scheduled: Scheduled;
}) {
  const scheduledDate = new Date(scheduled.scheduledFor);
  const [timeRemaining, setTimeRemaining] = useState(
    scheduledDate ? dateDifference(new Date(), scheduledDate) : undefined
  );

  useEffect(() => {
    if (timeRemaining === undefined) return;
    const interval = setInterval(() => {
      setTimeRemaining((timeRemaining) => {
        if (timeRemaining === undefined) return undefined;
        if (timeRemaining <= 1000) return undefined;
        if (timeRemaining <= 0) {
          clearInterval(interval);
          return undefined;
        }

        return timeRemaining - 1000;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [timeRemaining]);

  return (
    <div className="grid grid-cols-2 gap-2 text-slate-300">
      <div className="flex flex-col gap-1 items-stretch">
        <Body size="extra-small" className={workflowNodeUppercaseClasses}>
          Fires at
        </Body>
        <Body
          className={classNames(workflowNodeDelayClasses, "font-mono")}
          size="small"
        >
          {formatDateTime(scheduledDate, "long")}
        </Body>
      </div>
      {step.status === "PENDING" && timeRemaining && (
        <div className="flex flex-col gap-1">
          <Body
            size="extra-small"
            className={classNames(workflowNodeUppercaseClasses)}
          >
            Fires in
          </Body>
          <Body
            className={classNames(workflowNodeDelayClasses, "font-mono")}
            size="small"
          >
            {humanizeDuration(timeRemaining, { round: true })}
          </Body>
        </div>
      )}
    </div>
  );
}

function CustomEventStep({ event }: { event: StepType<Step, "CUSTOM_EVENT"> }) {
  return (
    <>
      <Body size="extra-small" className={workflowNodeUppercaseClasses}>
        Name
      </Body>
      <Header2 size="small" className="text-slate-300 mb-2">
        {event.input.name}
      </Header2>
      <Header4>Payload</Header4>
      <CodeBlock code={stringifyCode(event.input.payload)} align="top" />
      {event.input.context && (
        <>
          <Header4>Context</Header4>
          <CodeBlock code={stringifyCode(event.input.context)} align="top" />
        </>
      )}
    </>
  );
}

function IntegrationRequestStep({
  request,
}: {
  request: StepType<Step, "INTEGRATION_REQUEST">;
}) {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization must be set");

  return (
    <>
      <Header2 size="small" className="text-slate-300 mb-2">
        {request.displayProperties.title}
      </Header2>
      {request.service.connection === null && (
        <>
          <div className="flex items-center gap-2 rounded-md bg-rose-500/10 border border-rose-600 p-3 mb-2">
            <ExclamationCircleIcon className="h-6 w-6 mr-1 text-rose-500" />
            <div className="flex gap-2 items-center justify-between flex-wrap w-full">
              <Body>
                You need to connect to {request.service.integration.name} to
                continue this workflow.
              </Body>
              <BasicConnectButton
                key={request.service.slug}
                integration={request.service.integration}
                organizationId={organization.id}
                serviceId={request.service.id}
              />
            </div>
          </div>
        </>
      )}

      <div className="mt-4">
        {request.input && (
          <>
            <InputTitle />
            <CodeBlock code={stringifyCode(request.input)} align="top" />
          </>
        )}
      </div>

      <div className="mt-4">
        {request.requestStatus === "ERROR" ? (
          <div>
            <div className="flex gap-2 mb-2 mt-3 ">
              <ExclamationTriangleIcon className="h-5 w-5 text-rose-500" />
              <Body size="small" className="text-rose-500">
                Failed with error:
              </Body>
            </div>
            <CodeBlock
              code={request.output ? stringifyCode(request.output) : ""}
              align="top"
              maxHeight="200px"
              className="border border-rose-500"
            />
          </div>
        ) : (
          request.output && (
            <>
              <div className="flex justify-between">
                <OutputTitle />
                {request.retryCount > 0 && (
                  <Body size="small" className="text-slate-400">
                    {request.retryCount} retries
                  </Body>
                )}
              </div>
              <CodeBlock
                code={stringifyCode(request.output)}
                align="top"
                maxHeight="200px"
              />
            </>
          )
        )}
      </div>
    </>
  );
}

function Error({ error }: { error: Run["error"] }) {
  if (!error) return null;

  return (
    <>
      <div className="flex gap-2 mb-2 mt-3 ">
        <ExclamationTriangleIcon className="h-5 w-5 text-rose-500" />
        <Body size="small" className="text-slate-300">
          Failed with error:
        </Body>
      </div>
      <Panel className="border border-rose-600">
        <Header4 className="font-mono">
          {error.name}: {error.message}
        </Header4>
        {error.stackTrace && (
          <div className="mt-2">
            <CodeBlock code={error.stackTrace} language="json" align="top" />
          </div>
        )}
      </Panel>
    </>
  );
}

const styleClass = "h-6 w-6 text-slate-400";
const stepInfo: Record<Step["type"], { label: string; icon: ReactNode }> = {
  LOG_MESSAGE: {
    label: "Log",
    icon: <ChatBubbleLeftEllipsisIcon className={styleClass} />,
  },
  CUSTOM_EVENT: {
    label: "Fire custom event",
    icon: <BoltIcon className={styleClass} />,
  },
  OUTPUT: { label: "Output", icon: <></> },
  INTEGRATION_REQUEST: {
    label: "API request",
    icon: <GlobeAltIcon className={styleClass} />,
  },
  DURABLE_DELAY: {
    label: "Delay",
    icon: <ClockIcon className={styleClass} />,
  },
  DISCONNECTION: {
    label: "Disconnected",
    icon: <ExclamationCircleIcon className={styleClass} />,
  },
} as const;

type LogLevel = StepType<Step, "LOG_MESSAGE">["input"]["level"];
const logColor: Record<LogLevel, string> = {
  INFO: "text-slate-400",
  WARN: "text-amber-300",
  ERROR: "text-rose-400",
  DEBUG: "text-slate-400",
} as const;
