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
import { RunListSearchSchema } from "../_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam._index/route";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/primitives/Select";
import { JobRunStatus, RuntimeEnvironmentType } from "@trigger.dev/database";
import {
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  PauseCircleIcon,
  XCircleIcon,
} from "@heroicons/react/24/solid";
import { ChartBarIcon } from "@heroicons/react/20/solid";
import { cn } from "~/utils/cn";
import { Spinner } from "~/components/primitives/Spinner";
import { NoSymbolIcon } from "@heroicons/react/20/solid";

// Filter -> status types
const ExtendedJobRunStatus = {
  ALL: "ALL" as const,
  ...JobRunStatus,
} as const;
type ExtendedJobRunStatusKey = keyof typeof ExtendedJobRunStatus;

type FilterableStatus =
  | "ALL"
  | "QUEUED"
  | "IN_PROGRESS"
  | "WAITING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  | "TIMEDOUT";

const filterableStatuses: Record<FilterableStatus, ExtendedJobRunStatusKey[]> = {
  ALL: ["ALL"],
  QUEUED: ["QUEUED", "WAITING_TO_EXECUTE", "PENDING", "WAITING_ON_CONNECTIONS"],
  IN_PROGRESS: ["STARTED", "EXECUTING", "PREPROCESSING"],
  WAITING: ["WAITING_TO_CONTINUE"],
  COMPLETED: ["SUCCESS"],
  FAILED: ["FAILURE", "UNRESOLVED_AUTH", "INVALID_PAYLOAD", "ABORTED"],
  TIMEDOUT: ["TIMED_OUT"],
  CANCELED: ["CANCELED"],
};

const statusKeys: FilterableStatus[] = Object.keys(filterableStatuses) as FilterableStatus[];

// Filter -> Environment types
const ExtendedRuntimeEnvironment = {
  ALL: "ALL" as const,
  ...RuntimeEnvironmentType,
} as const;
type ExtendedRuntimeEnvironmentType = keyof typeof ExtendedRuntimeEnvironment;
const environmentKeys: ExtendedRuntimeEnvironmentType[] = Object.keys(
  ExtendedRuntimeEnvironment
) as ExtendedRuntimeEnvironmentType[];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = ProjectParamSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const searchParams = RunListSearchSchema.parse(s);

  const status = url.searchParams.get("status");
  const environment = url.searchParams.get("environment");

  let filterStatus: JobRunStatus[] | undefined;
  if (status && status !== "ALL") {
    if (filterableStatuses.hasOwnProperty(status)) {
      filterStatus = filterableStatuses[status as FilterableStatus] as JobRunStatus[];
    }
  }

  let filterEnvironment: RuntimeEnvironmentType | undefined;
  if (environment && environment !== "ALL") {
    if (environmentKeys.includes(environment)) {
      filterEnvironment = environment as RuntimeEnvironmentType;
    }
  }

  const presenter = new RunListPresenter();

  const list = await presenter.call({
    userId,
    filterEnvironment: filterEnvironment,
    filterStatus: filterStatus,
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
  const navigate = useNavigate();
  const location = useLocation();
  const url = new URLSearchParams(location.search);

  const selectedEnvironment = url.get("environment") || ExtendedRuntimeEnvironment.ALL;
  const selectedStatus = url.get("status") || ExtendedJobRunStatus.ALL;

  const handleFilterChange = (filterType: string, value: string) => {
    url.set(filterType, value);
    url.delete("cursor");
    url.delete("direction");
    navigate(`${location.pathname}?${url.toString()}`);
  };

  const handleStatusChange = (value: FilterableStatus) => {
    handleFilterChange("status", value);
  };

  const handleEnvironmentChange = (value: string) => {
    handleFilterChange("environment", value);
  };

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
            <div className="flex flex-row justify-between gap-x-2">
              {/* environment filter */}
              <SelectGroup>
                <Select
                  name="environment"
                  value={selectedEnvironment}
                  onValueChange={handleEnvironmentChange}
                >
                  <SelectTrigger size="secondary/small" width="full">
                    <SelectValue placeholder="Select environment" className="ml-2 p-0" />
                  </SelectTrigger>
                  <SelectContent>
                    {environmentKeys.map((env) => (
                      <SelectItem key={env} value={env}>
                        <div className="flex gap-x-2">
                          {env !== "ALL" && (
                            <span
                              className={cn(
                                "inline-flex h-4 items-center justify-center rounded-[2px] px-1 text-xxs font-medium uppercase tracking-wider text-midnight-900",
                                filterEnvironmentColorClassName(env)
                              )}
                            >
                              {filterEnvironmentTitle(env)}
                            </span>
                          )}
                          <span
                            className={cn(
                              "inline-flex h-4 items-center justify-center pl-1 text-xxs font-medium uppercase tracking-wider text-dimmed"
                            )}
                          >
                            {env === "ALL" ? env + " Environments" : env}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SelectGroup>

              {/* status filter */}
              <SelectGroup>
                <Select name="status" value={selectedStatus} onValueChange={handleStatusChange}>
                  <SelectTrigger size="secondary/small" width="full">
                    <SelectValue placeholder="Select environment" className="ml-2 p-0" />
                  </SelectTrigger>
                  <SelectContent>
                    {statusKeys.map((status) => (
                      <SelectItem key={status} value={status}>
                        {
                          <span className="flex items-center gap-1 text-xxs font-medium uppercase tracking-wider">
                            <FilterStatusIcon status={status} className="h-4 w-4" />
                            <FilterStatusLabel status={status} />
                          </span>
                        }
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SelectGroup>
            </div>

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

function filterEnvironmentTitle(environment: ExtendedRuntimeEnvironmentType) {
  switch (environment) {
    case "ALL":
      return "All";
    case "PRODUCTION":
      return "Prod";
    case "STAGING":
      return "Staging";
    case "DEVELOPMENT":
      return "Dev";
    case "PREVIEW":
      return "Preview";
  }
}

function filterEnvironmentColorClassName(environment: ExtendedRuntimeEnvironmentType) {
  switch (environment) {
    case "ALL":
      return "bg-indigo-500";
    case "PRODUCTION":
      return "bg-green-500";
    case "STAGING":
      return "bg-amber-500";
    case "DEVELOPMENT":
      return "bg-pink-500";
    case "PREVIEW":
      return "bg-yellow-500";
  }
}

export function FilterStatusLabel({ status }: { status: FilterableStatus }) {
  return <span className={filterStatusClassNameColor(status)}>{filterStatusTitle(status)}</span>;
}

export function FilterStatusIcon({
  status,
  className,
}: {
  status: FilterableStatus;
  className: string;
}) {
  switch (status) {
    case "ALL":
      return <span className="w-[0.0625rem]"></span>;
    case "COMPLETED":
      return <CheckCircleIcon className={cn(filterStatusClassNameColor(status), className)} />;
    case "WAITING":
      return <ClockIcon className={cn(filterStatusClassNameColor(status), className)} />;
    case "QUEUED":
      return <PauseCircleIcon className={cn(filterStatusClassNameColor(status), className)} />;
    case "IN_PROGRESS":
      return <Spinner className={cn(filterStatusClassNameColor(status), className)} />;
    case "TIMEDOUT":
      return (
        <ExclamationTriangleIcon className={cn(filterStatusClassNameColor(status), className)} />
      );
    case "CANCELED":
      return <NoSymbolIcon className={cn(filterStatusClassNameColor(status), className)} />;
    case "FAILED":
      return <XCircleIcon className={cn(filterStatusClassNameColor(status), className)} />;
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}

export function filterStatusTitle(status: FilterableStatus): string {
  switch (status) {
    case "ALL":
      return "All Status";
    case "QUEUED":
      return "Queued";
    case "IN_PROGRESS":
      return "In progress";
    case "WAITING":
      return "Waiting";
    case "COMPLETED":
      return "Completed";
    case "FAILED":
      return "Failed";
    case "CANCELED":
      return "Canceled";
    case "TIMEDOUT":
      return "Timed out";
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}

export function filterStatusClassNameColor(status: FilterableStatus): string {
  switch (status) {
    case "ALL":
      return "text-dimmed";
    case "QUEUED":
      return "text-slate-500";
    case "IN_PROGRESS":
      return "text-blue-500";
    case "WAITING":
      return "text-blue-500";
    case "COMPLETED":
      return "text-green-500";
    case "FAILED":
      return "text-rose-500";
    case "CANCELED":
      return "text-slate-500";
    case "TIMEDOUT":
      return "text-amber-300";
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}
