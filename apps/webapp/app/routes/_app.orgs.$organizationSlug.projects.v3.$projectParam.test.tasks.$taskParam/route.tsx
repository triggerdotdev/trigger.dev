import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { BeakerIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useSubmit } from "@remix-run/react";
import { ActionFunction, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { TaskRunStatus } from "@trigger.dev/database";
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
import { TextLink } from "~/components/primitives/TextLink";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import { redirectBackWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import {
  ScheduledRun,
  StandardRun,
  TestTask,
  TestTaskPresenter,
} from "~/presenters/v3/TestTaskPresenter.server";
import { requireUserId } from "~/services/session.server";
import { docsPath, v3RunSpanPath, v3TaskParamsSchema } from "~/utils/pathBuilder";
import { TestTaskService } from "~/v3/services/testTask.server";
import { TestTaskData } from "~/v3/testTask";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, taskParam } = v3TaskParamsSchema.parse(params);

  const presenter = new TestTaskPresenter();
  const result = await presenter.call({
    userId,
    projectSlug: projectParam,
    taskFriendlyId: taskParam,
  });

  return typedjson(result);
};

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, taskParam } = v3TaskParamsSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: TestTaskData });

  if (!submission.value) {
    return json(submission);
  }

  const testService = new TestTaskService();
  const run = await testService.call(userId, submission.value);

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
      { friendlyId: run.friendlyId },
      { spanId: run.spanId }
    ),
    request,
    "Test run created"
  );
};

export default function Page() {
  const result = useTypedLoaderData<typeof loader>();

  switch (result.triggerSource) {
    case "STANDARD": {
      return <StandardTaskForm task={result.task} runs={result.runs} />;
    }
    case "SCHEDULED": {
      return <ScheduledTaskForm task={result.task} runs={result.runs} />;
    }
  }
}

const startingJson = "{\n\n}";

function StandardTaskForm({ task, runs }: { task: TestTask["task"]; runs: StandardRun[] }) {
  //form submission
  const submit = useSubmit();
  const lastSubmission = useActionData();

  //recent runs
  const [selectedCodeSampleId, setSelectedCodeSampleId] = useState(runs.at(0)?.id);
  const selectedCodeSample = runs.find((r) => r.id === selectedCodeSampleId)?.payload;

  const [defaultJson, setDefaultJson] = useState<string>(selectedCodeSample ?? startingJson);
  const setCode = useCallback((code: string) => {
    setDefaultJson(code);
  }, []);

  const currentJson = useRef<string>(defaultJson);

  const submitForm = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      submit(
        {
          triggerSource: "STANDARD",
          payload: currentJson.current,
          taskIdentifier: task.taskIdentifier,
          environmentId: task.environment.id,
        },
        {
          action: "",
          method: "post",
        }
      );
      e.preventDefault();
    },
    [currentJson]
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
      className="grid h-full max-h-full grid-rows-[1fr_2.5rem]"
      method="post"
      {...form.props}
      onSubmit={(e) => submitForm(e)}
    >
      <input type="hidden" name="triggerSource" value={"STANDARD"} />
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel order={1} minSize={30} defaultSize={60}>
          <div className="h-full bg-charcoal-900">
            <JSONEditor
              defaultValue={defaultJson}
              readOnly={false}
              basicSetup
              onChange={(v) => {
                currentJson.current = v;

                //deselect the example if it's been edited
                if (selectedCodeSampleId) {
                  if (v !== selectedCodeSample) {
                    setDefaultJson(v);
                    setSelectedCodeSampleId(undefined);
                  }
                }
              }}
              height="100%"
              min-height="100%"
              max-height="100%"
              autoFocus
              placeholder="Use your schema to enter valid JSON or add one of the recent payloads then click 'Run test'"
              className="h-full"
            />
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel order={2} minSize={20} defaultSize={40}>
          <RecentPayloads
            runs={runs}
            selectedId={selectedCodeSampleId}
            onSelected={(id) => {
              const payload = runs.find((r) => r.id === id)?.payload;
              if (!payload) return;
              setCode(payload);
              setSelectedCodeSampleId(id);
            }}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
      <div className="flex items-center justify-end gap-2 border-t border-grid-bright bg-background-dimmed px-2">
        <div className="flex items-center gap-1">
          <Paragraph variant="small" className="whitespace-nowrap">
            This test will run in
          </Paragraph>
          <EnvironmentLabel environment={task.environment} />
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

function ScheduledTaskForm({ task, runs }: { task: TestTask["task"]; runs: ScheduledRun[] }) {
  const lastSubmission = useActionData();
  const [selectedCodeSampleId, setSelectedCodeSampleId] = useState(runs.at(0)?.id);
  const [timestampValue, setTimestampValue] = useState<Date | undefined>();
  const [lastTimestampValue, setLastTimestampValue] = useState<Date | undefined>();
  const [externalIdValue, setExternalIdValue] = useState<string | undefined>();

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
  }, [selectedCodeSampleId]);

  const [
    form,
    { timestamp, lastTimestamp, externalId, triggerSource, taskIdentifier, environmentId },
  ] = useForm({
    id: "test-task-scheduled",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: TestTaskData });
    },
  });

  return (
    <Form className="grid h-full max-h-full grid-rows-[1fr_2.5rem]" method="post" {...form.props}>
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
        value={task.environment.id}
      />
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel order={1} minSize={30} defaultSize={60}>
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
                />
                <Hint>
                  This is the timestamp of the previous run. You can use this in your code to find
                  new data since the previous run. This can be undefined if there hasn't been a
                  previous run.
                </Hint>
                <FormError id={lastTimestamp.errorId}>{lastTimestamp.error}</FormError>
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
        <ResizableHandle withHandle />
        <ResizablePanel order={2} minSize={20} defaultSize={40}>
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
      <div className="flex items-center justify-end gap-2 border-t border-grid-bright bg-background-dimmed px-2">
        <div className="flex items-center gap-1">
          <Paragraph variant="small" className="whitespace-nowrap">
            This test will run in
          </Paragraph>
          <EnvironmentLabel environment={task.environment} />
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

function RecentPayloads({
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
    <div className="flex flex-col gap-2 pl-4">
      <div className="flex h-10 items-center border-b border-grid-dimmed">
        <Header2>Recent payloads</Header2>
      </div>
      {runs.length === 0 ? (
        <Callout variant="info">
          Recent payloads will show here once you've completed a Run.
        </Callout>
      ) : (
        <div className="flex flex-col divide-y divide-charcoal-850">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={(e) => {
                onSelected(run.id);
              }}
              className="flex items-center gap-2 px-2 py-2"
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
