import { BookOpenIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typeddefer, useTypedLoaderData } from "remix-typedjson";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { MainCenteredContainer, PageBody } from "~/components/layout/AppLayout";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { LinkButton } from "~/components/primitives/Buttons";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { EndpointFilters } from "~/components/webhookEndpoints/v1/EndpointFilters";
import { EndpointsListTable } from "~/components/webhookEndpoints/v1/EndpointsListTable";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  ENDPOINT_STATUS_FILTERS,
  type EndpointStatusFilter,
  WebhookEndpointsListPresenter,
} from "~/presenters/v3/WebhookEndpointsListPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { requireUser } from "~/services/session.server";
import { docsPath, EnvironmentParamSchema } from "~/utils/pathBuilder";
import { webhookIngressUrl } from "~/utils/webhookIngressUrl.server";
import { requireWebhooksAccess } from "~/v3/webhooksAccess.server";

export const meta: MetaFunction = () => [{ title: "Endpoints | Webhooks | Trigger.dev" }];

function repeated(searchParams: URLSearchParams, key: string): string[] | undefined {
  const values = searchParams
    .getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return values.length > 0 ? Array.from(new Set(values)) : undefined;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) throw new Response("Project not found", { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment) throw new Response("Environment not found", { status: 404 });

  await requireWebhooksAccess(user, project.organizationId);

  const url = new URL(request.url);
  const statuses = repeated(url.searchParams, "statuses")?.filter(
    (status): status is EndpointStatusFilter =>
      (ENDPOINT_STATUS_FILTERS as readonly string[]).includes(status)
  );
  const directionRaw = url.searchParams.get("direction") ?? undefined;

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );
  const list = await new WebhookEndpointsListPresenter(clickhouse).call({
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    subscribers: repeated(url.searchParams, "subscribers"),
    sources: repeated(url.searchParams, "sources"),
    statuses,
    search: url.searchParams.get("search") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    direction: directionRaw ? DirectionSchema.parse(directionRaw) : undefined,
  });

  return typeddefer({
    ...list,
    endpoints: list.endpoints.map((endpoint) => ({
      ...endpoint,
      ingestUrl: webhookIngressUrl(endpoint.opaqueId),
    })),
  });
};

export default function Page() {
  const { endpoints, activity, pagination, filterOptions, hasFilters, hasAnyEndpoints } =
    useTypedLoaderData<typeof loader>();

  return (
    <>
      <NavBar>
        <PageTitle title="Webhooks" />
        <PageAccessories>
          <LinkButton
            variant="docs/small"
            LeadingIcon={BookOpenIcon}
            to={docsPath("webhooks/overview")}
          >
            Webhooks docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid h-full max-h-full grid-rows-[auto_1fr] overflow-hidden">
          {hasAnyEndpoints || hasFilters ? (
            <>
              <div className="flex items-start justify-between gap-x-2 p-2">
                <EndpointFilters
                  subscribers={filterOptions.subscribers}
                  sources={filterOptions.sources}
                />
                <ListPagination list={{ pagination }} />
              </div>
              <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                <EndpointsListTable
                  endpoints={endpoints}
                  activity={activity}
                  hasFilters={hasFilters}
                />
              </div>
            </>
          ) : (
            <div className="row-span-2">
              <NoEndpoints />
            </div>
          )}
        </div>
      </PageBody>
    </>
  );
}

function NoEndpoints() {
  return (
    <MainCenteredContainer className="max-w-2xl">
      <InfoPanel
        title="Declare your first webhook endpoint"
        icon={WebhookIcon}
        iconClassName="text-webhooks"
        panelClassName="max-w-2xl"
        accessory={
          <LinkButton
            to={docsPath("webhooks/overview")}
            variant="docs/small"
            LeadingIcon={BookOpenIcon}
          >
            Webhooks docs
          </LinkButton>
        }
      >
        <Paragraph spacing variant="small">
          An endpoint is one URL you register with a provider. Declare it once, then subscribe
          tasks, agents or channels to it:
        </Paragraph>
        <CodeBlock
          code={`import { webhook, webhooks } from "@trigger.dev/sdk";

export const payments = webhooks.endpoint.define({
  id: "payments",
  source: webhooks.stripe(),
});

export const orders = webhook({
  id: "orders",
  endpoint: payments,
  filter: "event.type == 'checkout.session.completed'",
  onEvent: async ({ event }) => {
    // ...
  },
});`}
          showLineNumbers={false}
        />
        <Paragraph spacing variant="small" className="mt-2">
          Endpoints appear here on your next <code>trigger dev</code> or deploy, a moment after the
          worker registers.
        </Paragraph>
      </InfoPanel>
    </MainCenteredContainer>
  );
}
