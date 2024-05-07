import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { Callout } from "~/components/primitives/Callout";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RunListSearchSchema } from "~/components/runs/RunStatuses";
import { WebhookDeliveryRunsTable } from "~/components/runs/WebhookDeliveryRunsTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { WebhookDeliveryPresenter } from "~/presenters/WebhookDeliveryPresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  TriggerSourceParamSchema,
  webhookTriggerDeliveryRunsParentPath,
} from "~/utils/pathBuilder";
import { ListPagination } from "../../components/ListPagination";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, triggerParam } = TriggerSourceParamSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const searchParams = RunListSearchSchema.parse(s);

  const presenter = new WebhookDeliveryPresenter();
  const { webhook } = await presenter.call({
    userId,
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
