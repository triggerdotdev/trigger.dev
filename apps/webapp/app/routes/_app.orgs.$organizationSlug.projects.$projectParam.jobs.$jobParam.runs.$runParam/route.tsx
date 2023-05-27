import { Outlet } from "@remix-run/react";
import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { PageContainer, PageBody } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import {
  PageHeader,
  PageTitleRow,
  PageTitle,
  PageButtons,
  PageInfoRow,
  PageInfoGroup,
  PageInfoProperty,
  PageTabs,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { RunPresenter } from "~/presenters/RunPresenter.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import {
  jobTestPath,
  jobPath,
  jobTriggerPath,
  jobSettingsPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { jobParam, runParam } = params;
  invariant(jobParam, "jobParam not found");
  invariant(runParam, "runParam not found");

  const presenter = new RunPresenter();
  const run = await presenter.call({
    userId,
    id: runParam,
  });

  return typedjson({
    run,
  });
};

//todo breadcrumb
export const handle: Handle = {
  // breadcrumb: {
  // slug: "run",
  // },
};

export default function Page() {
  const { run } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const job = useJob();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle
            backButton={{
              to: jobPath(organization, project, job),
              text: "Runs",
            }}
            title={`Run #${run?.number}`}
          />
          <PageButtons>
            {/*  //todo rerun
            <LinkButton
              to={jobTestPath(organization, project, job)}
              variant="primary/small"
              shortcut="T"
            >
              Rerun Job
            </LinkButton> */}
          </PageButtons>
        </PageTitleRow>
        <PageInfoRow>
          <PageInfoGroup>
            <PageInfoProperty
              icon={job.event.icon}
              label={"Trigger"}
              value={job.event.title}
            />
            {job.event.elements &&
              job.event.elements.map((element, index) => (
                <PageInfoProperty
                  key={index}
                  icon="property"
                  label={element.label}
                  value={element.text}
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
      </PageHeader>
      <PageBody>Run body here</PageBody>
    </PageContainer>
  );
}
