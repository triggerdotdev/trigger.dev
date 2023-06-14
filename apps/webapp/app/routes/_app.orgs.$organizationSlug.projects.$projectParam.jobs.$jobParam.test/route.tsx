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
import { Button, ButtonContent } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { FormError } from "~/components/primitives/FormError";
import { Popover, PopoverContent } from "~/components/primitives/Popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/primitives/Select";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { TestJobPresenter } from "~/presenters/TestJobPresenter.server";
import { TestJobService } from "~/services/jobs/testJob.server";
import { requireUserId } from "~/services/session.server";
import { formDataAsObject } from "~/utils/formData";
import { Handle } from "~/utils/handle";
import { JobParamsSchema, jobTestPath, runPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, jobParam } =
    JobParamsSchema.parse(params);

  const presenter = new TestJobPresenter();
  const { environments } = await presenter.call({
    userId,
    organizationSlug,
    projectSlug: projectParam,
    jobSlug: jobParam,
  });

  return typedjson({ environments });
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
  const userId = await requireUserId(request);
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

  return redirectWithSuccessMessage(
    runPath(
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
  const { environments } = useTypedLoaderData<typeof loader>();

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
    <Form
      className="grid h-full grid-rows-[2rem_auto_2rem] gap-2 overflow-y-auto"
      method="post"
      {...form.props}
      onSubmit={(e) => submitForm(e)}
    >
      <div className="flex items-center justify-between">
        <SelectGroup>
          <Select
            name="environment"
            value={selectedEnvironmentId}
            onValueChange={setSelectedEnvironmentId}
          >
            <SelectTrigger size="medium">
              Environment: <SelectValue placeholder="Select environment" />
            </SelectTrigger>
            <SelectContent>
              {environments.map((environment) => (
                <SelectItem key={environment.id} value={environment.id}>
                  <EnvironmentLabel environment={environment} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SelectGroup>

        <Popover
          open={isExamplePopoverOpen}
          onOpenChange={(open) => setIsExamplePopoverOpen(open)}
        >
          <PopoverTrigger>
            <ButtonContent
              variant="secondary/medium"
              TrailingIcon="chevron-down"
            >
              Insert example
            </ButtonContent>
          </PopoverTrigger>

          <PopoverContent className="w-80 p-0" align="start">
            {selectedEnvironment?.examples.map((example) => (
              <Button
                key={example.id}
                variant="menu-item"
                onClick={(e) => insertCode(example.payload)}
                LeadingIcon={example.icon ?? undefined}
                fullWidth
                textAlignLeft
              >
                {example.name}
              </Button>
            ))}
          </PopoverContent>
        </Popover>
      </div>
      <div className="overflow-auto">
        <JSONEditor
          defaultValue={defaultJson}
          readOnly={false}
          basicSetup
          onChange={(v) => (currentJson.current = v)}
        />
      </div>
      <div className="flex justify-between">
        {payload.error ? (
          <FormError id={payload.errorId}>{payload.error}</FormError>
        ) : (
          <div />
        )}
        <Button type="submit" variant="primary/medium">
          Run test
        </Button>
      </div>
    </Form>
  );
}
