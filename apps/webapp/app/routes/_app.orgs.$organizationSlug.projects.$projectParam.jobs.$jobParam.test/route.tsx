import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ClipboardIcon } from "@heroicons/react/20/solid";
import { ClockIcon, CodeBracketIcon } from "@heroicons/react/24/outline";
import { Form, useActionData, useSubmit } from "@remix-run/react";
import { ActionFunction, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { useCallback, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { JSONEditor } from "~/components/code/JSONEditor";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { DateTime } from "~/components/primitives/DateTime";
import { DetailCell } from "~/components/primitives/DetailCell";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/primitives/Select";
import { TextLink } from "~/components/primitives/TextLink";
import { runStatusClassNameColor, runStatusTitle } from "~/components/runs/RunStatuses";
import { redirectBackWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { TestJobPresenter } from "~/presenters/TestJobPresenter.server";
import { TestJobService } from "~/services/jobs/testJob.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import { isValidIcon } from "~/utils/icon";
import { JobParamsSchema, jobRunDashboardPath, trimTrailingSlash } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, jobParam } = JobParamsSchema.parse(params);

  const presenter = new TestJobPresenter();
  const { environments, runs, examples } = await presenter.call({
    userId,
    organizationSlug,
    projectSlug: projectParam,
    jobSlug: jobParam,
  });

  return typedjson({ environments, runs, examples });
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
  accountId: z.string().optional(),
});

//todo save the chosen environment to a cookie (for that user), use it to default the env dropdown
export const action: ActionFunction = async ({ request, params }) => {
  const { organizationSlug, projectParam, jobParam } = JobParamsSchema.parse(params);

  const formData = await request.formData();

  const submission = parse(formData, { schema });

  if (!submission.value) {
    return json(submission);
  }

  const testService = new TestJobService();
  const run = await testService.call(submission.value);

  if (!run) {
    return redirectBackWithErrorMessage(
      request,
      "Unable to start a test run: Something went wrong"
    );
  }

  return redirectWithSuccessMessage(
    jobRunDashboardPath(
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
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Test" />,
};

const startingJson = "{\n\n}";

export default function Page() {
  const { environments, runs, examples } = useTypedLoaderData<typeof loader>();

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

  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>(environments[0].id);
  const selectedEnvironment = environments.find((e) => e.id === selectedEnvironmentId);

  const currentJson = useRef<string>(defaultJson);
  const [currentAccountId, setCurrentAccountId] = useState<string | undefined>(undefined);

  const submitForm = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      submit(
        {
          payload: currentJson.current,
          environmentId: selectedEnvironmentId,
          versionId: selectedEnvironment?.versionId ?? "",
          ...(currentAccountId ? { accountId: currentAccountId } : {}),
        },
        {
          action: "",
          method: "post",
        }
      );
      e.preventDefault();
    },
    [currentJson, selectedEnvironmentId, currentAccountId]
  );

  const [form, { environmentId, payload, accountId }] = useForm({
    id: "test-job",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  if (environments.length === 0) {
    return (
      <Callout variant="warning">
        Can't run a test when there are no environments. This shouldn't happen, please contact
        support.
      </Callout>
    );
  }

  return (
    <div className="grid h-full grid-cols-1 gap-4">
      <div className="flex h-full max-h-full overflow-hidden">
        <Form
          className="flex h-full max-h-full grow flex-col gap-4 overflow-y-auto"
          method="post"
          {...form.props}
          onSubmit={(e) => submitForm(e)}
        >
          <div className="grid h-full grid-cols-[1fr_auto] overflow-hidden">
            <div className="relative h-full flex-1 overflow-hidden rounded-l border border-border">
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
            </div>
            <div className="flex h-full w-fit min-w-[20rem] flex-col gap-4 overflow-y-auto rounded-r border border-l-0 border-border p-4">
              {examples.length > 0 && (
                <div className="flex flex-col gap-2">
                  <Header2>Example payloads</Header2>
                  {examples.map((example) => (
                    <button
                      type="button"
                      key={example.id}
                      onClick={(e) => {
                        setCode(example.payload ?? "");
                        setSelectedCodeSampleId(example.id);
                      }}
                    >
                      <DetailCell
                        leadingIcon={isValidIcon(example.icon) ? example.icon : CodeBracketIcon}
                        leadingIconClassName="text-blue-500"
                        label={example.name}
                        trailingIcon={example.id === selectedCodeSampleId ? "check" : "plus"}
                        trailingIconClassName={
                          example.id === selectedCodeSampleId
                            ? "text-green-500 group-hover:text-green-400"
                            : "text-slate-500 group-hover:text-bright"
                        }
                      />
                    </button>
                  ))}
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Header2>Recent payloads</Header2>
                {runs.length === 0 ? (
                  <Callout variant="info">
                    Recent payloads will show here once you've completed a Run.
                  </Callout>
                ) : (
                  <div className="flex flex-col gap-2">
                    {runs.map((run) => (
                      <button
                        key={run.id}
                        type="button"
                        onClick={(e) => {
                          setCode(run.payload ?? "");
                          setSelectedCodeSampleId(run.id);
                        }}
                      >
                        <DetailCell
                          leadingIcon={ClockIcon}
                          leadingIconClassName="text-slate-400"
                          label={<DateTime date={run.created} />}
                          description={
                            <>
                              Run #{run.number}{" "}
                              <span className={runStatusClassNameColor(run.status)}>
                                {runStatusTitle(run.status).toLocaleLowerCase()}
                              </span>
                            </>
                          }
                          trailingIcon={run.id === selectedCodeSampleId ? "check" : "plus"}
                          trailingIconClassName={
                            run.id === selectedCodeSampleId
                              ? "text-green-500 group-hover:text-green-400"
                              : "text-slate-500 group-hover:text-bright"
                          }
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {selectedEnvironment?.hasAuthResolver && (
                <div className="flex flex-col gap-2">
                  <Header2>Account ID</Header2>
                  <InputGroup fullWidth>
                    <Input
                      type="text"
                      fullWidth
                      variant="large"
                      value={currentAccountId}
                      placeholder={`e.g. abc_1234`}
                      onChange={(e) => setCurrentAccountId(e.target.value)}
                    />
                    <FormError>{accountId.error}</FormError>
                    <Hint>
                      Learn about testing Jobs with an Account ID in our{" "}
                      <TextLink href="https://trigger.dev/docs/documentation/guides/using-integrations-byo-auth#testing-jobs-with-account-id">
                        BYOAuth docs
                      </TextLink>
                    </Hint>
                  </InputGroup>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between">
            <LinkButton
              variant="tertiary/medium"
              to="https://trigger.dev/docs/documentation/guides/testing-jobs"
              TrailingIcon="external-link"
            >
              Learn more about running tests
            </LinkButton>
            <div className="flex flex-none items-center justify-end gap-2">
              {payload.error ? (
                <FormError id={payload.errorId}>{payload.error}</FormError>
              ) : (
                <div />
              )}
              <SelectGroup>
                <Select
                  name="environment"
                  value={selectedEnvironmentId}
                  onValueChange={setSelectedEnvironmentId}
                >
                  <SelectTrigger size="medium">
                    <SelectValue placeholder="Select environment" className="m-0 p-0" /> Environment
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
              <Button
                type="submit"
                variant="primary/medium"
                LeadingIcon="beaker"
                leadingIconClassName="text-bright"
                shortcut={{ key: "enter", modifiers: ["mod"], enabledOnInputElements: true }}
              >
                Run test
              </Button>
            </div>
          </div>
        </Form>
      </div>
    </div>
  );
}
