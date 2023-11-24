import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Fragment } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { BreadcrumbIcon } from "~/components/primitives/BreadcrumbIcon";
import { Callout } from "~/components/primitives/Callout";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useTypedMatchData } from "~/hooks/useTypedMatchData";
import { requireUser } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import {
  TriggerSourceParamSchema,
  projectTriggersPath,
  projectWebhookTriggersPath,
  trimTrailingSlash,
  webhookTriggerDeliveryRunsParentPath,
  webhookTriggerPath,
} from "~/utils/pathBuilder";
import { ListPagination } from "../_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam._index/ListPagination";
import { RunListSearchSchema } from "../_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam._index/route";
import { WebhookDeliveryPresenter } from "~/presenters/WebhookDeliveryPresenter.server";
import { WebhookDeliveryRunsTable } from "~/components/runs/WebhookDeliveryRunsTable";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, triggerParam } = TriggerSourceParamSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const searchParams = RunListSearchSchema.parse(s);

  const presenter = new WebhookDeliveryPresenter();
  const { webhook } = await presenter.call({
    userId: user.id,
    organizationSlug,
    projectSlug: projectParam,
    webhookId: triggerParam,
    direction: searchParams.direction,
    cursor: searchParams.cursor,
  });

  if (!webhook) {
    throw new Response("Trigger not found", {
      status: 404,
      statusText: "Not Found",
    });
  }

  return typedjson({ webhook });
};

export const handle: Handle = {
  //this one is complicated because we render outside the parent route (using triggers_ in the path)
  breadcrumb: (match, matches) => {
    const data = useTypedMatchData<typeof loader>(match);
    if (!data) return null;

    const org = useOrganization(matches);
    const project = useProject(matches);

    return (
      <Fragment>
        <BreadcrumbLink to={projectTriggersPath(org, project)} title="Triggers" />
        <BreadcrumbIcon />
        <BreadcrumbLink to={projectWebhookTriggersPath(org, project)} title="Webhook Triggers" />
        <BreadcrumbIcon />
        <BreadcrumbLink
          to={webhookTriggerPath(org, project, { id: data.webhook.id })}
          title={data.webhook.key}
        />
        <BreadcrumbIcon />
        <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Deliveries" />
      </Fragment>
    );
  },
};

export default function Page() {
  const { webhook } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  return (
    <>
      <Paragraph variant="small" spacing>
        Webhook payloads are delivered to clients for validation and event generation. You can see
        the list of attempted deliveries below.
      </Paragraph>

      {webhook.requestDeliveries ? (
        <>
          <ListPagination list={webhook.requestDeliveries} className="mb-2 justify-end" />
          <WebhookDeliveryRunsTable
            runs={webhook.requestDeliveries.runs}
            total={webhook.requestDeliveries.runs.length}
            hasFilters={false}
            runsParentPath={webhookTriggerDeliveryRunsParentPath(organization, project, webhook)}
          />
          <ListPagination list={webhook.requestDeliveries} className="mt-2 justify-end" />
        </>
      ) : (
        <Callout variant="warning">No registration runs found</Callout>
      )}
    </>
  );
}
