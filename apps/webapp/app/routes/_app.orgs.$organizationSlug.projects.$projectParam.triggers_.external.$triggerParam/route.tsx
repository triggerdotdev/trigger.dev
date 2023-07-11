import { Response } from "@remix-run/node";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { Fragment } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { BreadcrumbIcon } from "~/components/primitives/BreadcrumbIcon";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import {
  PageHeader,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RunsTable } from "~/components/runs/RunsTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useTypedMatchData } from "~/hooks/useTypedMatchData";
import { TriggerSourcePresenter } from "~/presenters/TriggerSourcePresenter.server";
import { requireUser } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import {
  TriggerSourceParamSchema,
  projectTriggersPath,
  triggerSourceRunsPath,
  trimTrailingSlash,
} from "~/utils/pathBuilder";
import { ListPagination } from "../_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam._index/ListPagination";
import { RunListSearchSchema } from "../_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam._index/route";

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, triggerParam } =
    TriggerSourceParamSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const searchParams = RunListSearchSchema.parse(s);

  const presenter = new TriggerSourcePresenter();
  const { trigger } = await presenter.call({
    userId: user.id,
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

export const handle: Handle = {
  breadcrumb: (match, matches) => {
    const data = useTypedMatchData<typeof loader>(match);
    if (!data) return null;

    const org = useOrganization(matches);
    const project = useProject(matches);

    return (
      <Fragment>
        <BreadcrumbLink
          to={projectTriggersPath(org, project)}
          title="Triggers"
        />
        <BreadcrumbIcon />
        <BreadcrumbLink
          to={projectTriggersPath(org, project)}
          title="External Triggers"
        />
        <BreadcrumbIcon />
        <BreadcrumbLink
          to={trimTrailingSlash(match.pathname)}
          title={`${data.trigger.integration.title}: ${data.trigger.integration.slug}`}
        />
      </Fragment>
    );
  },
};

export default function Integrations() {
  const { trigger } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle
            title={`${trigger.integration.title}: ${trigger.integration.slug}`}
            backButton={{
              to: projectTriggersPath(organization, project),
              text: "External Triggers",
            }}
          />
        </PageTitleRow>
        <PageInfoRow>
          <PageInfoGroup>
            <PageInfoProperty
              icon={trigger.integration.definitionId}
              label={trigger.integration.title ?? ""}
              value={trigger.integration.slug}
            />
            <PageInfoProperty
              label={trigger.active ? "Active" : "Inactive"}
              value={
                <NamedIcon
                  name={trigger.active ? "active" : "inactive"}
                  className="h-4 w-4"
                />
              }
            />
            <PageInfoProperty
              label="Environment"
              value={<EnvironmentLabel environment={trigger.environment} />}
            />
          </PageInfoGroup>
        </PageInfoRow>
      </PageHeader>

      <PageBody scrollable={false}>
        <div className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
          <Header2 spacing>Trigger registration runs</Header2>
          <Paragraph variant="small" spacing>
            External Triggers need to be registered with the external service.
            You can see the list of attempted registrations below.
          </Paragraph>
          {trigger.runList ? (
            <>
              <ListPagination
                list={trigger.runList}
                className="mt-2 justify-end"
              />
              <RunsTable
                runs={trigger.runList.runs}
                total={trigger.runList.runs.length}
                hasFilters={false}
                runsParentPath={triggerSourceRunsPath(
                  organization,
                  project,
                  trigger
                )}
              />
              <ListPagination
                list={trigger.runList}
                className="mt-2 justify-end"
              />
            </>
          ) : (
            <Callout variant="warning">No registration runs found</Callout>
          )}
        </div>
      </PageBody>
    </PageContainer>
  );
}
