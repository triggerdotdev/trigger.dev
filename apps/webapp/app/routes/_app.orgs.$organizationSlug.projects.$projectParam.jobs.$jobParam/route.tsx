import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import {
  PageButtons,
  PageHeader,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTabs,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useOptionalRun, useRun } from "~/hooks/useRun";
import { getJob } from "~/models/job.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import {
  jobPath,
  jobSettingsPath,
  jobTestPath,
  jobTriggerPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { jobParam } = params;
  invariant(jobParam, "jobParam not found");

  const job = await getJob({
    userId,
    slug: jobParam,
  });

  if (job === null) {
    throw new Response("Not Found", { status: 404 });
  }

  //todo identify job
  // analytics.job.identify({ job });

  return typedjson({
    job,
  });
};

export const handle: Handle = {
  breadcrumb: {
    slug: "job",
  },
};

export default function Job() {
  const organization = useOrganization();
  const project = useProject();
  const job = useJob();
  const run = useOptionalRun();
  const renderHeader = run === undefined;

  return renderHeader ? (
    <PageContainer>
      <PageHeader hideBorder>
        <PageTitleRow>
          <PageTitle title={job.title} />
          <PageButtons>
            <LinkButton
              to={jobTestPath(organization, project, job)}
              variant="primary/small"
              shortcut="T"
            >
              Run Test
            </LinkButton>
          </PageButtons>
        </PageTitleRow>
        <PageInfoRow>
          <PageInfoGroup>
            <PageInfoProperty
              icon={job.event.icon}
              label={"Trigger"}
              value={job.event.title}
            />
            <PageInfoProperty icon="id" label={"ID"} value={job.slug} />
            {job.properties &&
              job.properties.map((property, index) => (
                <PageInfoProperty
                  key={index}
                  icon="property"
                  label={property.label}
                  value={property.text}
                />
              ))}
            {job.integrations.length > 0 && (
              <PageInfoProperty
                label="Integrations"
                value={
                  <div className="flex gap-0.5">
                    {job.integrations.map((integration, index) => (
                      <NamedIcon
                        key={index}
                        name={integration.icon}
                        className={"h-4 w-4"}
                      />
                    ))}
                  </div>
                }
              />
            )}
          </PageInfoGroup>
          <PageInfoGroup alignment="right">
            <Paragraph variant="extra-small" className="text-slate-600">
              UID: {job.id}
            </Paragraph>
          </PageInfoGroup>
        </PageInfoRow>
        <PageTabs
          tabs={[
            { label: "Runs", to: jobPath(organization, project, job) },
            { label: "Test", to: jobTestPath(organization, project, job) },
            {
              label: "Trigger",
              to: jobTriggerPath(organization, project, job),
            },
            {
              label: "Settings",
              to: jobSettingsPath(organization, project, job),
            },
          ]}
        />
      </PageHeader>
      <PageBody>
        <Outlet />
      </PageBody>
    </PageContainer>
  ) : (
    <Outlet />
  );
}
