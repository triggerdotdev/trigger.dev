import { Outlet, useLocation } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import {
  PageAccessories,
  NavBar,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTabs,
  PageTitle,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useOptionalRun } from "~/hooks/useRun";
import { JobPresenter } from "~/presenters/JobPresenter.server";
import { requireUserId } from "~/services/session.server";
import { titleCase } from "~/utils";
import { JobParamsSchema, jobPath, jobSettingsPath, jobTestPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { jobParam, projectParam, organizationSlug } = JobParamsSchema.parse(params);

  const presenter = new JobPresenter();
  const job = await presenter.call({
    userId,
    jobSlug: jobParam,
    organizationSlug,
    projectSlug: projectParam,
  });

  if (!job) {
    throw new Response("Not Found", {
      status: 404,
      statusText: `There is no Job ${jobParam} in this Project.`,
    });
  }

  return typedjson({
    job,
  });
};

export default function Job() {
  const organization = useOrganization();
  const project = useProject();
  const job = useJob();
  const run = useOptionalRun();
  const renderHeader = run === undefined;
  const location = useLocation();

  const isTestPage = location.pathname.endsWith("/test");

  return renderHeader ? (
    <PageContainer>
      <NavBar>
        <PageTitle title={job.title} />
        {!isTestPage && (
          <PageAccessories>
            <LinkButton
              to={jobTestPath(organization, project, job)}
              variant="primary/small"
              shortcut={{ key: "t" }}
            >
              Test
            </LinkButton>
          </PageAccessories>
        )}
      </NavBar>
      <PageBody className="grid grid-rows-[auto_1fr] px-4" scrollable={false}>
        <div className="py-4">
          <PageInfoRow>
            <PageInfoGroup>
              <PageInfoProperty
                icon={job.event.icon}
                label={"Trigger"}
                value={job.event.title}
                to={job.event.link ?? undefined}
              />
              {job.dynamic && <PageInfoProperty icon="dynamic" value={"Dynamic"} />}
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
                    <span className="flex gap-0.5">
                      {job.integrations.map((integration, index) => (
                        <NamedIcon key={index} name={integration.icon} className={"h-4 w-4"} />
                      ))}
                    </span>
                  }
                />
              )}
              <PageInfoProperty
                icon="pulse"
                label={"STATUS"}
                value={titleCase(job.status.toLowerCase())}
              />
            </PageInfoGroup>
            <PageInfoGroup alignment="right">
              <Paragraph variant="extra-small" className="text-charcoal-600">
                UID: {job.id}
              </Paragraph>
            </PageInfoGroup>
          </PageInfoRow>

          <PageTabs
            layoutId="jobs"
            tabs={[
              { label: "Runs", to: jobPath(organization, project, job) },
              { label: "Test", to: jobTestPath(organization, project, job) },
              {
                label: "Settings",
                to: jobSettingsPath(organization, project, job),
              },
            ]}
          />
        </div>
        <Outlet />
      </PageBody>
    </PageContainer>
  ) : (
    <Outlet />
  );
}
