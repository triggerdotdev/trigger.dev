import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { Form, useActionData, useNavigation, useSubmit } from "@remix-run/react";
import { ActionFunction, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { useCallback, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { JSONEditor } from "~/components/code/JSONEditor";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioButtonCircle } from "~/components/primitives/RadioButton";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { TaskPath } from "~/components/runs/v3/TaskPath";
import { TaskRunStatus } from "~/components/runs/v3/TaskRunStatus";
import { redirectBackWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { TestTaskPresenter } from "~/presenters/v3/TestTaskPresenter.server";
import { requireUserId } from "~/services/session.server";
import { v3RunPath, v3TaskParamsSchema } from "~/utils/pathBuilder";
import { TestTaskService } from "~/v3/services/testTask.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, taskParam } = v3TaskParamsSchema.parse(params);

  const presenter = new TestTaskPresenter();
  const { task, runs } = await presenter.call({
    userId,
    projectSlug: projectParam,
    taskFriendlyId: taskParam,
  });

  return typedjson({
    task,
    runs,
  });
};

const schema = z.object({
  payload: z.string().transform((payload, ctx) => {
    try {
      const data = JSON.parse(payload);
      return data as any;
    } catch (e) {
      console.log("parsing error", e);

      if (e instanceof Error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: e.message,
        });
      } else {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "This is invalid JSON",
        });
      }
    }
  }),
  taskIdentifier: z.string(),
  environmentId: z.string(),
  accountId: z.string().optional(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, taskParam } = v3TaskParamsSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

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
    v3RunPath({ slug: organizationSlug }, { slug: projectParam }, { friendlyId: run.friendlyId }),
    request,
    "Test run created"
  );
};

const startingJson = "{\n\n}";

export default function Page() {
  const { task, runs } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();

  //form submission
  const submit = useSubmit();
  const lastSubmission = useActionData();

  //examples
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
      return parse(formData, { schema });
    },
  });

  return (
    <Form
      className="grid h-full max-h-full grid-rows-[1fr_2.5rem]"
      method="post"
      {...form.props}
      onSubmit={(e) => submitForm(e)}
    >
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
                      setCode(run.payload ?? "");
                      setSelectedCodeSampleId(run.id);
                    }}
                    className="flex items-center gap-2 px-2 py-2"
                  >
                    <RadioButtonCircle checked={run.id === selectedCodeSampleId} />
                    <div className="flex flex-col items-start">
                      <Paragraph variant="small">
                        <DateTime date={run.createdAt} />
                      </Paragraph>
                      <div className="flex items-center gap-1 text-xs text-text-dimmed">
                        <div>Run #{run.number}</div>
                        <TaskRunStatus status={run.status} />
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <div className="bg-midnight-900 flex items-center justify-end gap-2 border-t border-grid-bright px-2">
        <div className="flex items-center gap-1">
          <TaskPath
            filePath={task.filePath}
            functionName={`${task.exportName}()`}
            className="text-xs"
          />
          <Paragraph variant="small">will run as a test in your</Paragraph>
          <EnvironmentLabel environment={task.environment} />
          <Paragraph variant="small">environment:</Paragraph>
        </div>
        <Button
          type="submit"
          variant="primary/small"
          LeadingIcon="beaker"
          leadingIconClassName="text-text-bright"
          shortcut={{ key: "enter", modifiers: ["mod"], enabledOnInputElements: true }}
        >
          Run test
        </Button>
      </div>
    </Form>
  );
}
