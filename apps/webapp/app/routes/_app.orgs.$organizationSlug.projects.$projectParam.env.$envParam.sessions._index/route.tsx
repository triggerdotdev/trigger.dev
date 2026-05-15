import { BookOpenIcon } from "@heroicons/react/24/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ListPagination } from "~/components/ListPagination";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { MainCenteredContainer, PageBody } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { SessionFilters } from "~/components/sessions/v1/SessionFilters";
import { SessionsTable } from "~/components/sessions/v1/SessionsTable";
import { SessionsNone } from "~/components/BlankStatePanels";
import { $replica } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getSessionFiltersFromRequest } from "~/presenters/SessionFilters.server";
import { SessionListPresenter } from "~/presenters/v3/SessionListPresenter.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { requireUserId } from "~/services/session.server";
import { docsPath, EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Sessions | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return redirectWithErrorMessage("/", request, "Project not found");
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Error("Environment not found");
  }

  const filters = getSessionFiltersFromRequest(request);

  const presenter = new SessionListPresenter($replica, clickhouseClient);
  const list = await presenter.call(project.organizationId, environment.id, {
    userId,
    projectId: project.id,
    statuses: filters.statuses,
    types: filters.types,
    taskIdentifiers: filters.taskIdentifiers,
    externalId: filters.externalId,
    tags: filters.tags,
    period: filters.period,
    from: filters.from,
    to: filters.to,
    cursor: filters.cursor,
    direction: filters.direction,
  });

  return typedjson(list);
};

export default function Page() {
  const list = useTypedLoaderData<typeof loader>();

  return (
    <>
      <NavBar>
        <PageTitle title="Sessions" />
        <PageAccessories>
          <AdminDebugTooltip />
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/ai-chat/overview")}
          >
            Sessions docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        {!list.hasAnySessions ? (
          <MainCenteredContainer className="max-w-md">
            <SessionsNone />
          </MainCenteredContainer>
        ) : (
          <div className="grid h-full max-h-full grid-rows-[auto_1fr] overflow-hidden">
            <div className="flex items-start justify-between gap-x-2 p-2">
              <SessionFilters hasFilters={list.hasFilters} />
              <div className="flex items-center justify-end gap-x-2">
                <ListPagination list={{ pagination: list.pagination }} />
              </div>
            </div>
            <SessionsTable
              sessions={list.sessions}
              filters={list.filters}
              hasFilters={list.hasFilters}
            />
          </div>
        )}
      </PageBody>
    </>
  );
}
