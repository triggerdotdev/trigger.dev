import { useNavigation } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EventDetail } from "~/components/event/EventDetail";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { RunsFilters } from "~/components/runs/RunFilters";
import { RunListSearchSchema } from "~/components/runs/RunStatuses";
import { RunsTable } from "~/components/runs/RunsTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { EventPresenter } from "~/presenters/EventPresenter.server";
import { RunListPresenter } from "~/presenters/RunListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { EventParamSchema, projectPath } from "~/utils/pathBuilder";
import { ListPagination } from "../../components/ListPagination";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { eventParam, projectParam, organizationSlug } = EventParamSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const searchParams = RunListSearchSchema.parse(s);

  const presenter = new EventPresenter();
  try {
    const event = await presenter.call({
      userId,
      projectSlug: projectParam,
      organizationSlug,
      eventId: eventParam,
    });

    if (!event) {
      throw new Response("Not Found", { status: 404 });
    }

    const runsPresenter = new RunListPresenter();

    const list = await runsPresenter.call({
      userId,
      filterEnvironment: searchParams.environment,
      filterStatus: searchParams.status,
      eventId: event.id,
      projectSlug: projectParam,
      organizationSlug,
      direction: searchParams.direction,
      cursor: searchParams.cursor,
      from: searchParams.from,
      to: searchParams.to,
    });

    return typedjson({ event, list });
  } catch (e) {
    console.log(e);
    throw new Response(e instanceof Error ? e.message : JSON.stringify(e), { status: 404 });
  }
};

export default function Page() {
  const { event, list } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const organization = useOrganization();
  const project = useProject();
  const user = useUser();

  return (
    <PageContainer>
      <PageBody scrollable={false}>
        <div className="grid h-full grid-cols-2">
          <div className="overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            <EventDetail event={event} />
          </div>

          <div className="overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            <div className="mb-2 flex items-center justify-between gap-x-2">
              <RunsFilters />
              <div className="flex items-center justify-end gap-x-2">
                <ListPagination list={list} />
              </div>
            </div>

            <RunsTable
              total={list.runs.length}
              hasFilters={false}
              runs={list.runs}
              isLoading={isLoading}
              showJob={true}
              runsParentPath={projectPath(organization, project)}
              currentUser={user}
            />
            <ListPagination list={list} className="mt-2 justify-end" />
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
