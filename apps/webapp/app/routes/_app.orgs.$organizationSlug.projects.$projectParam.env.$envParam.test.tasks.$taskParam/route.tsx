import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { BeakerIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useSubmit } from "@remix-run/react";
import { type ActionFunction, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { type TaskRunStatus } from "@trigger.dev/database";
import { useCallback, useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { JSONEditor } from "~/components/code/JSONEditor";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { DateField } from "~/components/primitives/DateField";
import { DateTime } from "~/components/primitives/DateTime";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioButtonCircle } from "~/components/primitives/RadioButton";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Select } from "~/components/primitives/Select";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { TextLink } from "~/components/primitives/TextLink";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import { TimezoneList } from "~/components/scheduled/timezones";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useSearchParams } from "~/hooks/useSearchParam";
import {
  redirectBackWithErrorMessage,
  redirectWithErrorMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  type ScheduledRun,
  type StandardRun,
  type TestTask,
  TestTaskPresenter,
} from "~/presenters/v3/TestTaskPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { docsPath, v3RunSpanPath, v3TaskParamsSchema, v3TestPath } from "~/utils/pathBuilder";
import { TestTaskService } from "~/v3/services/testTask.server";
import { OutOfEntitlementError } from "~/v3/services/triggerTask.server";
import { TestTaskData } from "~/v3/testTask";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam, taskParam } = v3TaskParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  const presenter = new TestTaskPresenter();
  try {
    const result = await presenter.call({
      userId,
      projectId: project.id,
      taskIdentifier: taskParam,
      environment: environment,
    });

    return typedjson(result);
  } catch (error) {
    return redirectWithErrorMessage(
      v3TestPath({ slug: organizationSlug }, { slug: projectParam }, environment),
      request,
      `Couldn't load test page for ${taskParam}`
    );
  }
};

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, taskParam } = v3TaskParamsSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: TestTaskData });

  if (!submission.value) {
    return json(submission);
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return redirectBackWithErrorMessage(request, "Project not found");
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);

  if (!environment) {
    return redirectBackWithErrorMessage(request, "Environment not found");
  }

  const testService = new TestTaskService();
  try {
    const run = await testService.call(environment, submission.value);

    if (!run) {
      return redirectBackWithErrorMessage(
        request,
        "Unable to start a test run: Something went wrong"
      );
    }

    return redirectWithSuccessMessage(
      v3RunSpanPath(
        { slug: organizationSlug },
        { slug: projectParam },
        { slug: envParam },
        { friendlyId: run.friendlyId },
        { spanId: run.spanId }
      ),
      request,
      "Test run created"
    );
  } catch (e) {
    if (e instanceof OutOfEntitlementError) {
      return redirectBackWithErrorMessage(
        request,
        "Unable to start a test run: You have exceeded your free credits"
      );
    }

    logger.error("Failed to start a test run", { error: e instanceof Error ? e.message : e });

    return redirectBackWithErrorMessage(
      request,
      "Unable to start a test run: Something went wrong"
    );
  }
};

export default function Page() {
  const result = useTypedLoaderData<typeof loader>();

  if (!result.foundTask) {
    return <div></div>;
  }

  switch (result.task.triggerSource) {
    case "STANDARD": {
      return <StandardTaskForm task={result.task.task} runs={result.task.runs} />;
    }
    case "SCHEDULED": {
      return (
        <ScheduledTaskForm
          task={result.task.task}
          runs={result.task.runs}
          possibleTimezones={result.task.possibleTimezones}
        />
      );
    }
  }
}

const startingJson = "{\n\n}";

function StandardTaskForm({ task, runs }: { task: TestTask["task"]; runs: StandardRun[] }) {
  const environment = useEnvironment();
  const { value, replace } = useSearchParams();
  const tab = value("tab");

  //form submission
  const submit = useSubmit();
  const lastSubmission = useActionData();

  //recent runs
  const [selectedCodeSampleId, setSelectedCodeSampleId] = useState(runs.at(0)?.id);
  const selectedCodeSample = runs.find((r) => r.id === selectedCodeSampleId);
  const selectedCodeSamplePayload = selectedCodeSample?.payload;
  const selectedCodeSampleMetadata = selectedCodeSample?.seedMetadata;

  const [defaultPayloadJson, setDefaultPayloadJson] = useState<string>(
    selectedCodeSamplePayload ?? startingJson
  );
  const setPayload = useCallback((code: string) => {
    setDefaultPayloadJson(code);
  }, []);

  const currentPayloadJson = useRef<string>(defaultPayloadJson);

  const [defaultMetadataJson, setDefaultMetadataJson] = useState<string>(
    selectedCodeSampleMetadata ?? "{}"
  );
  const setMetadata = useCallback((code: string) => {
    setDefaultMetadataJson(code);
  }, []);

  const currentMetadataJson = useRef<string>(defaultMetadataJson);

  const submitForm = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      submit(
        {
          triggerSource: "STANDARD",
          payload: currentPayloadJson.current,
          metadata: currentMetadataJson.current,
          taskIdentifier: task.taskIdentifier,
          environmentId: environment.id,
        },
        {
          action: "",
          method: "post",
        }
      );
      e.preventDefault();
    },
    [currentPayloadJson, currentMetadataJson, task]
  );

  const [form, { environmentId, payload }] = useForm({
    id: "test-task",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: TestTaskData });
    },
  });

  return (
    <Form
      className="grid h-full max-h-full grid-rows-[1fr_auto]"
      method="post"
      {...form.props}
      onSubmit={(e) => submitForm(e)}
    >
      <input type="hidden" name="triggerSource" value={"STANDARD"} />
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel id="test-task-main" min="100px" default="60%">
          <div className="flex h-full flex-col overflow-hidden bg-charcoal-900">
            <TabContainer className="px-3 pt-2">
              <TabButton
                isActive={!tab || tab === "payload"}
                layoutId="test-editor"
                onClick={() => {
                  replace({ tab: "payload" });
                }}
              >
                Payload
              </TabButton>

              <TabButton
                isActive={tab === "metadata"}
                layoutId="test-editor"
                onClick={() => {
                  replace({ tab: "metadata" });
                }}
              >
                Metadata
              </TabButton>
            </TabContainer>
            <div className="flex-1 overflow-hidden">
              <JSONEditor
                defaultValue={defaultPayloadJson}
                readOnly={false}
                basicSetup
                onChange={(v) => {
                  currentPayloadJson.current = v;

                  //deselect the example if it's been edited
                  if (selectedCodeSampleId) {
                    if (v !== selectedCodeSamplePayload) {
                      setDefaultPayloadJson(v);
                      setSelectedCodeSampleId(undefined);
                    }
                  }
                }}
                height="100%"
                autoFocus={!tab || tab === "payload"}
                className={cn("h-full overflow-auto", tab === "metadata" && "hidden")}
              />
              <JSONEditor
                defaultValue={defaultMetadataJson}
                readOnly={false}
                basicSetup
                onChange={(v) => {
                  currentMetadataJson.current = v;

                  //deselect the example if it's been edited
                  if (selectedCodeSampleId) {
                    if (v !== selectedCodeSampleMetadata) {
                      setDefaultMetadataJson(v);
                      setSelectedCodeSampleId(undefined);
                    }
                  }
                }}
                height="100%"
                autoFocus={tab === "metadata"}
                placeholder=""
                className={cn("h-full overflow-auto", tab !== "metadata" && "hidden")}
              />
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle id="test-task-handle" />
        <ResizablePanel id="test-task-inspector" min="100px">
          <RecentPayloads
            runs={runs}
            selectedId={selectedCodeSampleId}
            onSelected={(id) => {
              const run = runs.find((r) => r.id === id);
              if (!run) return;
              setPayload(run.payload);
              setMetadata(run.seedMetadata ?? "{}");
              setSelectedCodeSampleId(id);
            }}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
      <div className="flex items-center justify-end gap-3 border-t border-grid-bright bg-background-dimmed p-2">
        <div className="flex items-center gap-1">
          <Paragraph variant="small" className="whitespace-nowrap">
            This test will run in
          </Paragraph>
          <EnvironmentLabel environment={environment} className="text-sm" />
        </div>
        <Button
          type="submit"
          variant="primary/medium"
          LeadingIcon={BeakerIcon}
          shortcut={{ key: "enter", modifiers: ["mod"], enabledOnInputElements: true }}
        >
          Run test
        </Button>
      </div>
    </Form>
  );
}

function ScheduledTaskForm({
  task,
  runs,
  possibleTimezones,
}: {
  task: TestTask["task"];
  runs: ScheduledRun[];
  possibleTimezones: string[];
}) {
  const environment = useEnvironment();
  const lastSubmission = useActionData();
  const [selectedCodeSampleId, setSelectedCodeSampleId] = useState(runs.at(0)?.id);
  const [timestampValue, setTimestampValue] = useState<Date | undefined>();
  const [lastTimestampValue, setLastTimestampValue] = useState<Date | undefined>();
  const [externalIdValue, setExternalIdValue] = useState<string | undefined>();
  const [timezoneValue, setTimezoneValue] = useState<string>("UTC");

  //set initial values
  useEffect(() => {
    const initialRun = runs.find((r) => r.id === selectedCodeSampleId);
    if (!initialRun) {
      setTimestampValue(new Date());
      return;
    }

    setTimestampValue(initialRun.payload.timestamp);
    setLastTimestampValue(initialRun.payload.lastTimestamp);
    setExternalIdValue(initialRun.payload.externalId);
    setTimezoneValue(initialRun.payload.timezone);
  }, [selectedCodeSampleId]);

  const [
    form,
    {
      timestamp,
      lastTimestamp,
      externalId,
      triggerSource,
      taskIdentifier,
      environmentId,
      timezone,
    },
  ] = useForm({
    id: "test-task-scheduled",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: TestTaskData });
    },
  });

  return (
    <Form className="grid h-full max-h-full grid-rows-[1fr_auto]" method="post" {...form.props}>
      <input
        type="hidden"
        {...conform.input(triggerSource, { type: "hidden" })}
        value={"SCHEDULED"}
      />
      <input
        type="hidden"
        {...conform.input(taskIdentifier, { type: "hidden" })}
        value={task.taskIdentifier}
      />
      <input
        type="hidden"
        {...conform.input(environmentId, { type: "hidden" })}
        value={environment.id}
      />
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel id="test-task-main" min="100px" default="70%">
          <div className="p-3">
            <Fieldset>
              <InputGroup>
                <Label htmlFor={timestamp.id}>Timestamp UTC</Label>
                <input
                  type="hidden"
                  {...conform.input(timestamp, { type: "hidden" })}
                  value={timestampValue?.toISOString() ?? ""}
                />
                <DateField
                  label="Timestamp UTC"
                  defaultValue={timestampValue}
                  onValueChange={(val) => setTimestampValue(val)}
                  granularity="second"
                  showNowButton
                  variant="medium"
                  utc
                />
                <Hint>
                  This is the timestamp of the CRON, it will come through to your run in the
                  payload.
                </Hint>
                <FormError id={timestamp.errorId}>{timestamp.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={lastTimestamp.id} required={false}>
                  Last timestamp UTC
                </Label>
                <input
                  type="hidden"
                  {...conform.input(lastTimestamp, { type: "hidden" })}
                  value={lastTimestampValue?.toISOString() ?? ""}
                />
                <DateField
                  label="Last timestamp UTC"
                  defaultValue={lastTimestampValue}
                  onValueChange={(val) => setLastTimestampValue(val)}
                  granularity="second"
                  showNowButton
                  showClearButton
                  variant="medium"
                  utc
                />
                <Hint>
                  This is the timestamp of the previous run. You can use this in your code to find
                  new data since the previous run. This can be undefined if there hasn't been a
                  previous run.
                </Hint>
                <FormError id={lastTimestamp.errorId}>{lastTimestamp.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={timezone.id}>Timezone</Label>
                <Select
                  {...conform.select(timezone)}
                  placeholder="Select a timezone"
                  defaultValue={timezoneValue}
                  value={timezoneValue}
                  setValue={(e) => {
                    if (Array.isArray(e)) return;
                    setTimezoneValue(e);
                  }}
                  items={possibleTimezones}
                  filter={{ keys: [(item) => item.replace(/\//g, " ").replace(/_/g, " ")] }}
                  dropdownIcon
                  variant="tertiary/medium"
                >
                  {(matches) => <TimezoneList timezones={matches} />}
                </Select>
                <Hint>
                  The Timestamp and Last timestamp are in UTC so this just changes the timezone
                  string that comes through in the payload.
                </Hint>
                <FormError id={timezone.errorId}>{timezone.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label required={false} htmlFor={externalId.id}>
                  External ID
                </Label>
                <Input
                  {...conform.input(externalId, { type: "text" })}
                  placeholder="Optionally specify your own ID, e.g. user id"
                  value={externalIdValue ?? ""}
                  onChange={(e) => setExternalIdValue(e.target.value)}
                />
                <Hint>
                  Optionally, you can specify your own IDs (like a user ID) and then use it inside
                  the run function of your task. This allows you to have per-user CRON tasks.{" "}
                  <TextLink to={docsPath("v3/tasks-scheduled")}>Read the docs.</TextLink>
                </Hint>
                <FormError id={externalId.errorId}>{externalId.error}</FormError>
              </InputGroup>
            </Fieldset>
          </div>
        </ResizablePanel>
        <ResizableHandle id="test-task-handle" />
        <ResizablePanel id="test-task-inspector" min="100px">
          <RecentPayloads
            runs={runs}
            selectedId={selectedCodeSampleId}
            onSelected={(id) => {
              const run = runs.find((r) => r.id === id);
              if (!run) return;
              setSelectedCodeSampleId(id);
              setTimestampValue(run.payload.timestamp);
              setLastTimestampValue(run.payload.lastTimestamp);
              setExternalIdValue(run.payload.externalId);
            }}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
      <div className="flex items-center justify-end gap-2 border-t border-grid-bright bg-background-dimmed p-2">
        <div className="flex items-center gap-1">
          <Paragraph variant="small" className="whitespace-nowrap">
            This test will run in
          </Paragraph>
          <EnvironmentLabel environment={environment} className="text-sm" />
        </div>
        <Button
          type="submit"
          variant="primary/small"
          LeadingIcon={BeakerIcon}
          shortcut={{ key: "enter", modifiers: ["mod"], enabledOnInputElements: true }}
        >
          Run test
        </Button>
      </div>
    </Form>
  );
}

export function RecentPayloads({
  runs,
  selectedId,
  onSelected,
}: {
  runs: {
    id: string;
    createdAt: Date;
    number: number;
    status: TaskRunStatus;
  }[];
  selectedId?: string;
  onSelected: (id: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center border-b border-grid-dimmed py-2 pl-3">
        <Header2>Recent payloads</Header2>
      </div>
      {runs.length === 0 ? (
        <div className="p-3">
          <Callout variant="info">
            Recent payloads will show here once you've completed a Run.
          </Callout>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-charcoal-750 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={(e) => {
                onSelected(run.id);
              }}
              className="flex items-center gap-4 py-2 pl-4 pr-6 transition hover:bg-charcoal-800"
            >
              <RadioButtonCircle checked={run.id === selectedId} />
              <div className="flex flex-col items-start">
                <Paragraph variant="small">
                  <DateTime date={run.createdAt} />
                </Paragraph>
                <div className="flex items-center gap-1 text-xs text-text-dimmed">
                  <div>Run #{run.number}</div>
                  <TaskRunStatusCombo status={run.status} />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
