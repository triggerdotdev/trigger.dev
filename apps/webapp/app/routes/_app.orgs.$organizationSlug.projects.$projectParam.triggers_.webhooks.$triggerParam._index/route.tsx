import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { Callout, variantClasses } from "~/components/primitives/Callout";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RunListSearchSchema } from "~/components/runs/RunStatuses";
import { RunsTable } from "~/components/runs/RunsTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { WebhookSourcePresenter } from "~/presenters/WebhookSourcePresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { TriggerSourceParamSchema, webhookTriggerRunsParentPath } from "~/utils/pathBuilder";
import { ListPagination } from "../../components/ListPagination";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, triggerParam } = TriggerSourceParamSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const searchParams = RunListSearchSchema.parse(s);

  const presenter = new WebhookSourcePresenter();
  const { trigger } = await presenter.call({
    userId,
    organizationSlug,
    projectSlug: projectParam,
    webhookId: triggerParam,
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
    <>
      <Paragraph variant="small" spacing>
        Webhook Triggers need to be registered with the external service. You can see the list of
        attempted registrations below.
      </Paragraph>

      {!trigger.active && (
        <Form method="post" {...form.props}>
          <Callout variant="error" className="justiy-between mb-4 items-center">
            <Paragraph variant="small" className={cn(variantClasses.error.textColor, "grow")}>
              Registration hasn't succeeded yet, check the runs below.
            </Paragraph>
            {/* <input
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
          </Button> */}
          </Callout>
        </Form>
      )}

      {trigger.runList ? (
        <>
          <ListPagination list={trigger.runList} className="mb-2 justify-end" />
          <RunsTable
            runs={trigger.runList.runs}
            total={trigger.runList.runs.length}
            hasFilters={false}
            runsParentPath={webhookTriggerRunsParentPath(organization, project, trigger)}
            currentUser={user}
          />
          <ListPagination list={trigger.runList} className="mt-2 justify-end" />
        </>
      ) : (
        <Callout variant="warning">No registration runs found</Callout>
      )}
    </>
  );
}
