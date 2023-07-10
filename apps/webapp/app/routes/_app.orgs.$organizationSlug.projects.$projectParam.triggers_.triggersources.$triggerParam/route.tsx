import { Response } from "@remix-run/node";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
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
import { TriggerSourcePresenter } from "~/presenters/TriggerSourcePresenter.server";
import { requireUser } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import {
  TriggerSourceParamSchema,
  projectTriggersPath,
  triggerSourceRunsPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, triggerParam } =
    TriggerSourceParamSchema.parse(params);

  const presenter = new TriggerSourcePresenter();
  const { trigger } = await presenter.call({
    userId: user.id,
    organizationSlug,
    projectSlug: projectParam,
    triggerSourceId: triggerParam,
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
  breadcrumb: {
    slug: "trigger",
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
              text: "Triggers",
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
              icon={trigger.active ? "active" : "inactive"}
              label="Active"
              value={trigger.active ? "Yes" : "No"}
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
          {trigger.registrationJob ? (
            <RunsTable
              runs={trigger.registrationJob.runs}
              total={trigger.registrationJob.runs.length}
              hasFilters={false}
              runsParentPath={triggerSourceRunsPath(
                organization,
                project,
                trigger
              )}
            />
          ) : (
            <Callout variant="warning">No registration runs found</Callout>
          )}
        </div>
      </PageBody>
    </PageContainer>
  );
}
