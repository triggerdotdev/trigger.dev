import { BookOpenIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
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
import { WebhooksBetaAccess } from "~/components/webhookEndpoints/WebhooksBetaAccess";
import { $replica } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { jsonWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  ENDPOINT_STATUS_FILTERS,
  type EndpointStatusFilter,
  WebhookEndpointsListPresenter,
} from "~/presenters/v3/WebhookEndpointsListPresenter.server";
import { webhooksBetaPreview } from "~/presenters/v3/webhooksBetaPreview.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import {
  hasRequestedBetaAccess,
  recordBetaAccessRequest,
} from "~/services/dashboardPreferences.server";
import { requireUser } from "~/services/session.server";
import { telemetry } from "~/services/telemetry.server";
import { docsPath, EnvironmentParamSchema } from "~/utils/pathBuilder";
import { webhookIngressUrl } from "~/utils/webhookIngressUrl.server";
import { hasWebhooksAccess } from "~/v3/webhooksAccess.server";

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

  if (!(await hasWebhooksAccess(user, project.organizationId))) {
    if (!featuresForRequest(request).isManagedCloud) {
      throw new Response("Not found", { status: 404 });
    }
    const preview = webhooksBetaPreview();
    return typeddefer({
      betaAccess: true as const,
      organizationId: project.organizationId,
      requested: hasRequestedBetaAccess(
        user.dashboardPreferences,
        "webhooks",
        project.organizationId
      ),
      previewEndpoints: preview.endpoints,
      previewActivity: Promise.resolve(preview.activity),
    });
  }

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

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam } = EnvironmentParamSchema.parse(params);

  if (!featuresForRequest(request).isManagedCloud) {
    throw new Response("Not found", { status: 404 });
  }

  if (user.isImpersonating) {
    throw new Response("Beta access can't be requested while impersonating", { status: 403 });
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) throw new Response("Project not found", { status: 404 });

  const organization = await $replica.organization.findFirst({
    where: { id: project.organizationId },
    select: { id: true, slug: true, title: true },
  });
  if (!organization) throw new Response("Organization not found", { status: 404 });

  if (!hasRequestedBetaAccess(user.dashboardPreferences, "webhooks", organization.id)) {
    await recordBetaAccessRequest({ user, feature: "webhooks", organizationId: organization.id });
    telemetry.webhooks.betaRequested({ user, organization });
  }

  return jsonWithSuccessMessage({ requested: true }, request, "We've added you to the wait list");
};

export default function Page() {
  const data = useTypedLoaderData<typeof loader>();

  if ("betaAccess" in data) {
    return (
      <WebhooksBetaAccess
        key={data.organizationId}
        requested={data.requested}
        previewEndpoints={data.previewEndpoints}
        previewActivity={data.previewActivity}
      />
    );
  }

  return <Endpoints data={data} />;
}

type EndpointsData = Exclude<
  ReturnType<typeof useTypedLoaderData<typeof loader>>,
  { betaAccess: true }
>;

function Endpoints({ data }: { data: EndpointsData }) {
  const { endpoints, activity, pagination, filterOptions, hasFilters, hasAnyEndpoints } = data;

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
