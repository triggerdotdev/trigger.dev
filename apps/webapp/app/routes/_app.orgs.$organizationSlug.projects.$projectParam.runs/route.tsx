import { useLocation, useNavigate, useNavigation } from "@remix-run/react";
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
import { RunsTable } from "~/components/runs/RunsTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { RunListPresenter } from "~/presenters/RunListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema, docsPath, projectPath } from "~/utils/pathBuilder";
import { ListPagination } from "../_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam._index/ListPagination";
import { RunListSearchSchema } from "~/components/runs/RunStatuses";
import { RunsFilters } from "~/components/runs/RunFilters";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = ProjectParamSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const searchParams = RunListSearchSchema.parse(s);

  const presenter = new RunListPresenter();

  const list = await presenter.call({
    userId,
    filterEnvironment: searchParams.environment,
    filterStatus: searchParams.status,
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
          <PageTitle title={`${project.name} runs`} />
          <PageButtons>
            <LinkButton
              LeadingIcon={"docs"}
              to={docsPath("documentation/concepts/runs")}
              variant="secondary/small"
            >
              Run documentation
            </LinkButton>
          </PageButtons>
        </PageTitleRow>
        <PageDescription>All job runs in this project</PageDescription>
      </PageHeader>

      <PageBody scrollable={false}>
        <div className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
          <div className="mb-2 flex items-center justify-between gap-x-2">
            <RunsFilters />
            <ListPagination list={list} />
          </div>
          <RunsTable
            total={list.runs.length}
            hasFilters={false}
            showJob={true}
            runs={list.runs}
            isLoading={isLoading}
            runsParentPath={projectPath(organization, project)}
            currentUser={user}
          />
          <ListPagination list={list} className="mt-2 justify-end" />
        </div>
      </PageBody>
    </PageContainer>
  );
}
