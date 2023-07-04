import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { PopoverTrigger } from "@radix-ui/react-popover";
import { Form, useActionData, useSubmit } from "@remix-run/react";
import { ActionFunction, LoaderArgs, json } from "@remix-run/server-runtime";
import { useCallback, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { JSONEditor } from "~/components/code/JSONEditor";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { HowToRunATest } from "~/components/helpContent/HelpContentText";
import { Button, ButtonContent } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { FormError } from "~/components/primitives/FormError";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Popover, PopoverContent } from "~/components/primitives/Popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/primitives/Select";
import {
  redirectBackWithErrorMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { TestJobPresenter } from "~/presenters/TestJobPresenter.server";
import { TestJobService } from "~/services/jobs/testJob.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import { JobParamsSchema, runDashboardPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, jobParam } =
    JobParamsSchema.parse(params);

  const presenter = new TestJobPresenter();
  const { environments, hasTestRuns } = await presenter.call({
    userId,
    organizationSlug,
    projectSlug: projectParam,
    jobSlug: jobParam,
  });

  return typedjson({ environments, hasTestRuns });
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
  environmentId: z.string(),
  versionId: z.string(),
});

//todo save the chosen environment to a cookie (for that user), use it to default the env dropdown
export const action: ActionFunction = async ({ request, params }) => {
  const { organizationSlug, projectParam, jobParam } =
    JobParamsSchema.parse(params);

  const formData = await request.formData();

  const submission = parse(formData, { schema });

  if (!submission.value) {
    return json(submission);
  }

  const testService = new TestJobService();
  const run = await testService.call({
    environmentId: submission.value.environmentId,
    payload: submission.value.payload,
    versionId: submission.value.versionId,
  });

  if (!run) {
    return redirectBackWithErrorMessage(
      request,
      "Unable to start a test run: Something went wrong"
    );
  }

  return redirectWithSuccessMessage(
    runDashboardPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: jobParam },
      { id: run.id }
    ),
    request,
    "Test run created"
  );
};

export const handle: Handle = {
  breadcrumb: {
    slug: "test",
  },
};

const startingJson = "{\n\n}";

export default function Page() {
  const submit = useSubmit();
  const lastSubmission = useActionData();
  const [isExamplePopoverOpen, setIsExamplePopoverOpen] = useState(false);
  const { environments, hasTestRuns } = useTypedLoaderData<typeof loader>();

  const [defaultJson, setDefaultJson] = useState<string>(startingJson);
  const currentJson = useRef<string>(defaultJson);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>(
    environments[0].id
  );

  const selectedEnvironment = environments.find(
    (e) => e.id === selectedEnvironmentId
  );

  const insertCode = useCallback((code: string) => {
    setDefaultJson(code);
    setIsExamplePopoverOpen(false);
  }, []);

  const submitForm = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      submit(
        {
          payload: currentJson.current,
          environmentId: selectedEnvironmentId,
          versionId: selectedEnvironment?.versionId ?? "",
        },
        {
          action: "",
          method: "post",
        }
      );
      e.preventDefault();
    },
    [currentJson, selectedEnvironmentId]
  );

  const [form, { environmentId, payload }] = useForm({
    id: "test-job",
    lastSubmission,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  if (environments.length === 0) {
    return (
      <Callout variant="warning">
        Can't run a test when there are no environments. This shouldn't happen,
        please contact support.
      </Callout>
    );
  }

  return (
    <Help defaultOpen={!hasTestRuns}>
      {(open) => (
        <div
          className={cn(
            "grid h-full gap-4",
            open ? "grid-cols-2" : "grid-cols-1"
          )}
        >
          <div className="flex h-fit max-h-full overflow-hidden">
            <Form
              className="flex max-h-full grow flex-col gap-2 overflow-y-auto"
              method="post"
              {...form.props}
              onSubmit={(e) => submitForm(e)}
            >
              <div className="flex flex-none items-center justify-between gap-2">
                <div className="flex flex-none items-center gap-2">
                  <SelectGroup>
                    <Select
                      name="environment"
                      value={selectedEnvironmentId}
                      onValueChange={setSelectedEnvironmentId}
                    >
                      <SelectTrigger size="secondary/small">
                        <SelectValue
                          placeholder="Select environment"
                          className="m-0 p-0"
                        />{" "}
                        Environment
                      </SelectTrigger>
                      <SelectContent>
                        {environments.map((environment) => (
                          <SelectItem
                            key={environment.id}
                            value={environment.id}
                          >
                            <EnvironmentLabel environment={environment} />
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SelectGroup>

                  {selectedEnvironment &&
                    selectedEnvironment.examples.length > 0 && (
                      <Popover
                        open={isExamplePopoverOpen}
                        onOpenChange={(open) => setIsExamplePopoverOpen(open)}
                      >
                        <PopoverTrigger>
                          <ButtonContent
                            variant="secondary/small"
                            LeadingIcon="beaker"
                            TrailingIcon="chevron-down"
                          >
                            Insert an example
                          </ButtonContent>
                        </PopoverTrigger>

                        <PopoverContent className="w-80 p-0" align="start">
                          {selectedEnvironment?.examples.map((example) => (
                            <Button
                              key={example.id}
                              variant="menu-item"
                              onClick={(e) => insertCode(example.payload)}
                              LeadingIcon={example.icon ?? "beaker"}
                              fullWidth
                              textAlignLeft
                            >
                              {example.name}
                            </Button>
                          ))}
                        </PopoverContent>
                      </Popover>
                    )}
                </div>
                <HelpTrigger title="How do I run a test" />
              </div>
              <div className="flex-1 overflow-auto rounded border border-slate-850 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
                <JSONEditor
                  defaultValue={defaultJson}
                  readOnly={false}
                  basicSetup
                  onChange={(v) => (currentJson.current = v)}
                  minHeight="150px"
                />
              </div>
              <div className="flex flex-none items-center justify-between">
                {payload.error ? (
                  <FormError id={payload.errorId}>{payload.error}</FormError>
                ) : (
                  <div />
                )}
                <Button
                  type="submit"
                  variant="primary/medium"
                  LeadingIcon="beaker"
                  leadingIconClassName="text-bright"
                >
                  Run test
                </Button>
              </div>
            </Form>
          </div>
          <HelpContent title="How to run a test" className="h-fit">
            <HowToRunATest />
          </HelpContent>
        </div>
      )}
    </Help>
  );
}
