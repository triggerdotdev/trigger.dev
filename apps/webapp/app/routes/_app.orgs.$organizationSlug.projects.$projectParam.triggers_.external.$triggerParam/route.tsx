import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { json } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import type { ActionFunction, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Callout, variantClasses } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import {
  NavBar,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTitle,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RunListSearchSchema } from "~/components/runs/RunStatuses";
import { RunsTable } from "~/components/runs/RunsTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { TriggerSourcePresenter } from "~/presenters/TriggerSourcePresenter.server";
import { requireUserId } from "~/services/session.server";
import { ActivateSourceService } from "~/services/sources/activateSource.server";
import { cn } from "~/utils/cn";
import {
  TriggerSourceParamSchema,
  externalTriggerPath,
  externalTriggerRunsParentPath,
  projectTriggersPath,
} from "~/utils/pathBuilder";
import { ListPagination } from "../../components/ListPagination";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, triggerParam } = TriggerSourceParamSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const searchParams = RunListSearchSchema.parse(s);

  const presenter = new TriggerSourcePresenter();
  const { trigger } = await presenter.call({
    userId,
    organizationSlug,
    projectSlug: projectParam,
    triggerSourceId: triggerParam,
    direction: searchParams.direction,
    cursor: searchParams.cursor,
  });

  if (!trigger) {
    throw new Response("Trigger not found", {
      status: 404,
      statusText: "Not Found",
    });
  }

  return typedjson({ trigger });
};

const schema = z.object({
  jobId: z.string(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, triggerParam } = TriggerSourceParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value) {
    return json(submission);
  }

  try {
    const service = new ActivateSourceService();

    const result = await service.call(triggerParam);

    return redirectWithSuccessMessage(
      externalTriggerPath({ slug: organizationSlug }, { slug: projectParam }, { id: triggerParam }),
      request,
      `Retrying registration now`
    );
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function Page() {
  const { trigger } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const user = useUser();
  const navigation = useNavigation();
  const lastSubmission = useActionData();

  const [form, { jobId }] = useForm({
    id: "trigger-registration-retry",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  const isLoading = navigation.state === "submitting" && navigation.formData !== undefined;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title={`${trigger.integration.title}: ${trigger.integration.slug}`}
          backButton={{
            to: projectTriggersPath(organization, project),
            text: "External Triggers",
          }}
        />
      </NavBar>

      <PageBody scrollable={false}>
        <div className="grid grid-rows-[auto_1fr] gap-y-4 p-4">
          <PageInfoRow>
            <PageInfoGroup>
              <PageInfoProperty
                icon={trigger.integration.definition.icon ?? trigger.integration.definitionId}
                label={trigger.integration.title ?? ""}
                value={trigger.integration.slug}
              />
              <PageInfoProperty
                label={trigger.active ? "Active" : "Inactive"}
                value={
                  <NamedIcon name={trigger.active ? "active" : "inactive"} className="h-4 w-4" />
                }
              />
              {trigger.dynamic && (
                <PageInfoProperty
                  label="Dynamic"
                  value={
                    <span className="flex items-center gap-0.5">
                      <NamedIcon name="dynamic" className="h-4 w-4" />
                      {trigger.dynamic.slug}
                    </span>
                  }
                />
              )}
              <PageInfoProperty
                label="Environment"
                value={<EnvironmentLabel environment={trigger.environment} />}
              />
            </PageInfoGroup>
          </PageInfoRow>
          <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            <Header2 spacing>External Trigger registration runs</Header2>
            <Paragraph variant="small" spacing>
              External Triggers need to be registered with the external service. You can see the
              list of attempted registrations below.
            </Paragraph>

            {!trigger.active &&
              (trigger.registrationJob ? (
                <Form method="post" {...form.props}>
                  <Callout variant="error" className="justiy-between mb-4 items-center">
                    <Paragraph
                      variant="small"
                      className={cn(variantClasses.error.textColor, "grow")}
                    >
                      Registration hasn't succeeded yet, check the runs below.
                    </Paragraph>
                    <input
                      {...conform.input(jobId, { type: "hidden" })}
                      defaultValue={trigger.registrationJob?.id}
                    />
                    <Button
                      variant="danger/small"
                      type="submit"
                      name={conform.INTENT}
                      value="retry"
                      disabled={isLoading}
                      LeadingIcon={isLoading ? "spinner-white" : undefined}
                    >
                      {isLoading ? "Retrying…" : "Retry now"}
                    </Button>
                  </Callout>
                </Form>
              ) : trigger.dynamic ? null : (
                <Callout variant="error" className="justiy-between mb-4 items-center">
                  This External Trigger hasn't registered successfully. Contact support for help:{" "}
                  {trigger.id}
                </Callout>
              ))}

            {trigger.runList ? (
              <>
                <ListPagination list={trigger.runList} className="mb-2 justify-end" />
                <RunsTable
                  runs={trigger.runList.runs}
                  total={trigger.runList.runs.length}
                  hasFilters={false}
                  runsParentPath={externalTriggerRunsParentPath(organization, project, trigger)}
                  currentUser={user}
                />
                <ListPagination list={trigger.runList} className="mt-2 justify-end" />
              </>
            ) : (
              <Callout variant="warning">No registration runs found</Callout>
            )}
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
