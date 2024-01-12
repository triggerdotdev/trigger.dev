import { useNavigation } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import {
  PageButtons,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { EventsTable } from "~/components/events/EventsTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { EventListPresenter } from "~/presenters/EventListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema, docsPath, projectPath, trimTrailingSlash } from "~/utils/pathBuilder";
import { ListPagination } from "../_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam._index/ListPagination";
import { EventListSearchSchema } from "~/components/events/EventStatuses";
import { useUser } from "~/hooks/useUser";
import { EventsFilters } from "~/components/events/EventsFilters";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = ProjectParamSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const searchParams = EventListSearchSchema.parse(s);

  const presenter = new EventListPresenter();
  const list = await presenter.call({
    userId,
    filterEnvironment: searchParams.environment,
    projectSlug: projectParam,
    organizationSlug,
    direction: searchParams.direction,
    cursor: searchParams.cursor,
    pageSize: 25,
  });

  return typedjson({
    list,
  });
};

export default function Page() {
  const { list } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const organization = useOrganization();
  const project = useProject();
  const user = useUser();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title={`${project.name} events`} />
          <PageButtons>
            <LinkButton
              LeadingIcon={"docs"}
              to={docsPath("documentation/concepts/triggers/events")}
              variant="secondary/small"
            >
              Event documentation
            </LinkButton>
          </PageButtons>
        </PageTitleRow>
        <PageDescription>All events in this project</PageDescription>
      </PageHeader>

      <PageBody scrollable={false}>
        <div className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
          <div className="mb-2 flex items-center justify-between gap-x-2">
            <EventsFilters />
            <ListPagination list={list} />
          </div>
          <EventsTable
            total={list.events.length}
            hasFilters={false}
            events={list.events}
            isLoading={isLoading}
            eventsParentPath={projectPath(organization, project)}
            currentUser={user}
          />
          <ListPagination list={list} className="mt-2 justify-end" />
        </div>
      </PageBody>
    </PageContainer>
  );
}
