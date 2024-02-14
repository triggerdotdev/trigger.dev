import { useNavigation } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { RunsFilters } from "~/components/runs/RunFilters";
import { RunListSearchSchema } from "~/components/runs/RunStatuses";
import { RunsTable } from "~/components/runs/v3/RunsTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { RunListPresenter } from "~/presenters/v3/RunListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema } from "~/utils/pathBuilder";
import { ListPagination } from "../../components/ListPagination";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = ProjectParamSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const searchParams = RunListSearchSchema.parse(s);

  const presenter = new RunListPresenter();
  const list = await presenter.call({
    userId,
    projectSlug: projectParam,
    taskSlugs: undefined,
    versions: undefined,
    statuses: undefined,
    environments: undefined,
    from: undefined,
    to: undefined,
    direction: searchParams.direction,
    cursor: searchParams.cursor,
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
    <>
      <div className={cn("grid h-fit grid-cols-1 gap-4")}>
        <div>
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
            currentUser={user}
          />
          <ListPagination list={list} className="mt-2 justify-end" />
        </div>
      </div>
    </>
  );
}
