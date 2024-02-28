import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ClockIcon } from "@heroicons/react/20/solid";
import { useActionData, useNavigation, useSubmit } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useCallback, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { CodeBlock } from "~/components/code/CodeBlock";
import { JSONEditor } from "~/components/code/JSONEditor";
import { Callout } from "~/components/primitives/Callout";
import { DateTime } from "~/components/primitives/DateTime";
import { DetailCell } from "~/components/primitives/DetailCell";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioButtonCircle } from "~/components/primitives/RadioButton";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { TaskRunStatus } from "~/components/runs/v3/TaskRunStatus";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { TestTaskPresenter } from "~/presenters/v3/TestTaskPresenter.server";
import { requireUserId } from "~/services/session.server";
import { v3TaskParamsSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, taskParam } = v3TaskParamsSchema.parse(params);

  const presenter = new TestTaskPresenter();
  const { task, examples, runs } = await presenter.call({
    userId,
    projectSlug: projectParam,
    taskFriendId: taskParam,
  });

  return typedjson({
    task,
    examples,
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
  taskId: z.string(),
  accountId: z.string().optional(),
});

const startingJson = "{\n\n}";

export default function Page() {
  const { task, examples, runs } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();

  //form submission
  const submit = useSubmit();
  const lastSubmission = useActionData();

  //examples
  const [selectedCodeSampleId, setSelectedCodeSampleId] = useState(
    examples.at(0)?.id ?? runs.at(0)?.id
  );
  const selectedCodeSample =
    examples.find((e) => e.id === selectedCodeSampleId)?.payload ??
    runs.find((r) => r.id === selectedCodeSampleId)?.payload;

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
          taskId: task.id,
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
    <div className="grid h-full max-h-full grid-rows-[1fr_2.5rem]">
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel order={1} minSize={30} defaultSize={60}>
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
            placeholder="Use your schema to enter valid JSON or add one of the example payloads then click 'Run test'"
            className="h-full"
          />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel order={2} minSize={20} defaultSize={40}>
          <div className="flex flex-col gap-2 pl-4">
            <Header2>Recent payloads</Header2>
            {runs.length === 0 ? (
              <Callout variant="info">
                Recent payloads will show here once you've completed a Run.
              </Callout>
            ) : (
              <div className="flex flex-col divide-y divide-slate-850">
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
                      <div className="flex items-center gap-1 text-xs text-dimmed">
                        <div>Run #${run.number}</div>
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
      <div className="bg-slate-600"></div>
    </div>
  );
}
