import { BookOpenIcon } from "@heroicons/react/24/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { QuestionMarkIcon } from "~/assets/icons/QuestionMarkIcon";
import { InlineCode } from "~/components/code/InlineCode";
import { ListPagination } from "~/components/ListPagination";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { MainCenteredContainer, PageBody } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { SessionFilters } from "~/components/sessions/v1/SessionFilters";
import { SessionsTable } from "~/components/sessions/v1/SessionsTable";
import { SessionsNone } from "~/components/BlankStatePanels";
import { $replica } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getSessionFiltersFromRequest } from "~/presenters/SessionFilters.server";
import { SessionListPresenter } from "~/presenters/v3/SessionListPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { requireUserId } from "~/services/session.server";
import { docsPath, EnvironmentParamSchema } from "~/utils/pathBuilder";
import { throwNotFound } from "~/utils/httpErrors";

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
    throwNotFound("Environment not found");
  }

  const filters = getSessionFiltersFromRequest(request);

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );
  const presenter = new SessionListPresenter($replica, clickhouse);
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
        <PageTitle title="Sessions" accessory={<SessionsHelpTooltip />} />
        <PageAccessories>
          <AdminDebugTooltip />
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/ai-chat/sessions")}
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
              <SessionFilters hasFilters={list.hasFilters} possibleTasks={list.possibleTasks} />
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

function SessionsHelpTooltip() {
  return (
    <SimpleTooltip
      button={
        <QuestionMarkIcon className="size-4 text-text-dimmed transition hover:text-text-bright" />
      }
      side="bottom"
      className="max-w-sm p-3"
      disableHoverableContent
      content={
        <div className="flex flex-col gap-3">
          <div>
            <Paragraph variant="small/bright">What is a Session?</Paragraph>
            <Paragraph variant="extra-small" className="mt-1">
              A session is a pair of streams: input for incoming user messages, and output for
              everything the agent produces, including AI generation parts (text, reasoning, tool
              calls, etc.) and any custom data parts your task emits. Sessions also orchestrate
              the execution of agent runs, so a single conversation can span many task triggers.
            </Paragraph>
          </div>
          <div className="flex flex-col gap-2.5 border-t border-grid-dimmed pt-3">
            <div>
              <Paragraph variant="small/bright">
                <InlineCode>chat.agent</InlineCode>
              </Paragraph>
              <Paragraph variant="extra-small" className="mt-1">
                The high-level chat building block. Built on sessions and handles the chat turn
                loop for you. Use it for chat apps and conversational AI experiences.
              </Paragraph>
            </div>
            <div>
              <Paragraph variant="small/bright">
                <InlineCode>sessions.start()</InlineCode>
              </Paragraph>
              <Paragraph variant="extra-small" className="mt-1">
                The raw sessions API. Use it for non-chat patterns like agent inboxes, approval
                flows, or server-to-server streaming where you need a durable bi-directional
                channel.
              </Paragraph>
            </div>
          </div>
        </div>
      }
    />
  );
}
