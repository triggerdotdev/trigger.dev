import { Outlet, UIMatch, useLocation } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
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
import { useOptionalRun } from "~/hooks/useRun";
import { useTypedMatchData, useTypedMatchesData } from "~/hooks/useTypedMatchData";
import { TaskPresenter } from "~/presenters/v3/TaskPresenter.server";
import { requireUserId } from "~/services/session.server";
import { titleCase } from "~/utils";
import { Handle } from "~/utils/handle";
import {
  jobPath,
  jobSettingsPath,
  jobTestPath,
  trimTrailingSlash,
  v3TaskParamsSchema,
  v3TaskPath,
  v3TaskTestPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { taskParam, projectParam, organizationSlug } = v3TaskParamsSchema.parse(params);

  const presenter = new TaskPresenter();
  const task = await presenter.call({
    userId,
    taskFriendlyId: taskParam,
    projectSlug: projectParam,
  });

  if (!task) {
    throw new Response("Not Found", {
      status: 404,
      statusText: `There is no task ${taskParam} in this project.`,
    });
  }

  return typedjson({
    task,
  });
};

export type MatchedTask = UseDataFunctionReturn<typeof loader>["task"];
const matchId = "routes/_app.orgs.$organizationSlug.projects.v3.$projectParam.tasks.$taskParam";

export function useOptionalTask(matches?: UIMatch[]) {
  const routeMatch = useTypedMatchesData<typeof loader>({
    id: matchId,
    matches,
  });

  if (!routeMatch) {
    return undefined;
  }

  return routeMatch.task;
}

export function useTask(matches?: UIMatch[]) {
  const task = useOptionalTask(matches);
  invariant(task, "Task must be defined");
  return task;
}

export const handle: Handle = {
  breadcrumb: (match) => {
    const data = useTypedMatchData<typeof loader>(match);
    return (
      <BreadcrumbLink
        to={trimTrailingSlash(match?.pathname ?? "")}
        title={data ? `${data.task.exportName}()` : "Task"}
      />
    );
  },
};

export default function Page() {
  const organization = useOrganization();
  const project = useProject();
  const location = useLocation();
  const { task } = useTypedLoaderData<typeof loader>();

  const isTestPage = location.pathname.endsWith("/test");

  return (
    <PageContainer>
      <PageHeader hideBorder>
        <PageTitleRow>
          <PageTitle title={`${task.exportName}()`} />
          {!isTestPage && (
            <PageButtons>
              <LinkButton
                to={v3TaskTestPath(organization, project, task)}
                variant="primary/small"
                shortcut={{ key: "t" }}
              >
                Test
              </LinkButton>
            </PageButtons>
          )}
        </PageTitleRow>
        {/* <PageInfoRow>
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
            <Paragraph variant="extra-small" className="text-slate-600">
              UID: {job.id}
            </Paragraph>
          </PageInfoGroup>
        </PageInfoRow> */}

        {/* {job.noRunsHelp && (
          <Callout variant="info" to={job.noRunsHelp.link} className="mt-2">
            {job.noRunsHelp.text}
          </Callout>
        )} */}

        <PageTabs
          layoutId="task"
          tabs={[
            { label: "Runs", to: v3TaskPath(organization, project, task) },
            { label: "Test", to: v3TaskTestPath(organization, project, task) },
          ]}
        />
      </PageHeader>
      <PageBody>
        <Outlet />
      </PageBody>
    </PageContainer>
  );
}
