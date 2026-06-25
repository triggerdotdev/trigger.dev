import { CheckIcon, PlusIcon } from "@heroicons/react/20/solid";
import { BookOpenIcon } from "@heroicons/react/24/solid";
import { useSearchParams } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useCallback } from "react";
import { SearchInput } from "~/components/primitives/SearchInput";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { BranchEnvironmentIconSmall } from "~/assets/icons/EnvironmentIcons";
import { V4Title } from "~/components/V4Badge";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import * as Property from "~/components/primitives/PropertyTable";
import { Switch } from "~/components/primitives/Switch";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { InfoIconTooltip, SimpleTooltip } from "~/components/primitives/Tooltip";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";

import { BranchesPresenter } from "~/presenters/v3/BranchesPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { branchesDevPath, docsPath, ProjectParamSchema } from "~/utils/pathBuilder";
import { ArchiveButton } from "../resources.branches.archive";
import { NewBranchPanel } from "~/routes/resources.branches.create";
import { BranchesOptions } from "~/utils/branches";
import { IconArrowBearRight2 } from "@tabler/icons-react";
import { useAutoRevalidate } from "~/hooks/useAutoRevalidate";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  const searchParams = new URL(request.url).searchParams;
  const parsedSearchParams = BranchesOptions.safeParse(Object.fromEntries(searchParams));
  const options = parsedSearchParams.success ? parsedSearchParams.data : {};

  try {
    const presenter = new BranchesPresenter();
    const result = await presenter.call({
      userId,
      projectSlug: projectParam,
      env: "development",
      ...options,
    });

    return typedjson(result);
  } catch (error) {
    logger.error("Error loading dev branches page", { error });
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const {
    branches,
    limits,
    currentPage,
    totalPages,
  } = useTypedLoaderData<typeof loader>();
  useAutoRevalidate({ interval: 5000 });

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const atBranchLimit = limits.used >= limits.limit;
  const usageRatio = limits.limit > 0 ? Math.min(limits.used / limits.limit, 1) : 0;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={<V4Title>Dev branches</V4Title>} />
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              {branches.map((branch) => (
                <Property.Item key={branch.id}>
                  <Property.Label>{branch.branchName}</Property.Label>
                  <Property.Value>{branch.id}</Property.Value>
                </Property.Item>
              ))}
            </Property.Table>
          </AdminDebugTooltip>

          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("deployment/dev-branches")}
          >
            Dev branches docs
          </LinkButton>

          {limits.isAtLimit ? (
            <BranchLimitReachedDialog limits={limits} />
          ) : (
            <NewBranchPanel
              button={
                <Button
                  variant="primary/small"
                  shortcut={{ key: "n" }}
                  LeadingIcon={PlusIcon}
                  leadingIconClassName="text-white"
                  fullWidth
                  textAlignLeft
                >
                  New branch…
                </Button>
              }
              env="development"
            />
          )}
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid max-h-full min-h-full grid-rows-[auto_1fr_auto]">
              <div className="flex items-center justify-between gap-x-1.5 p-2">
                <BranchFilters />
                <PaginationControls
                  currentPage={currentPage}
                  totalPages={totalPages}
                  showPageNumbers={false}
                />
              </div>

              <div className="grid max-h-full min-h-full grid-rows-[1fr] overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Branch</TableHeaderCell>
                      <TableHeaderCell>Created</TableHeaderCell>
                      <TableHeaderCell>Last active</TableHeaderCell>
                      <TableHeaderCell>Archived</TableHeaderCell>
                      <TableHeaderCell>
                        <span className="sr-only">Actions</span>
                      </TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {branches.length === 0 ? (
                      <TableBlankRow colSpan={5}>
                        <Paragraph>There are no matches for your filters</Paragraph>
                      </TableBlankRow>
                    ) : (
                      branches.map((branch) => {
                        const path = branchesDevPath(organization, project, branch);
                        const cellClass = branch.archivedAt ? "opacity-50" : "";
                        const isSelected = branch.id === environment.id;

                        return (
                          <TableRow key={branch.id}>
                            <TableCell isTabbableCell className={cellClass}>
                              <div className="flex items-center gap-1">
                                <BranchEnvironmentIconSmall
                                  className={cn("size-4", isSelected && "text-dev")}
                                />
                                <CopyableText
                                  value={branch.branchName}
                                  className={cn(isSelected && "text-dev")}
                                />
                                {isSelected && <Badge variant="extra-small">Current</Badge>}
                              </div>
                            </TableCell>
                            <TableCell className={cellClass}>
                              <DateTime date={branch.createdAt} />
                            </TableCell>
                            <TableCell className={cellClass}>
                              {branch.isConnected ? (
                                <>Online now</>
                              ) : branch.lastActivity ? (
                                <DateTime date={branch.lastActivity} />
                              ) : null}
                            </TableCell>
                            <TableCell className={cellClass}>
                              {branch.archivedAt ? (
                                <CheckIcon className="size-4 text-charcoal-400" />
                              ) : (
                                "–"
                              )}
                            </TableCell>
                            <TableCellMenu
                              className="pl-32"
                              isSticky
                              hiddenButtons={
                                isSelected ? null : (
                                  <LinkButton
                                    to={path}
                                    variant="secondary/small"
                                    LeadingIcon={IconArrowBearRight2}
                                    leadingIconClassName="text-blue-500 -mr-2"
                                    className="pl-1.5"
                                  >
                                    Switch to branch
                                  </LinkButton>
                                )
                              }
                              popoverContent={
                                !isSelected || !branch.archivedAt ? (
                                  <>
                                    {isSelected ? null : (
                                      <PopoverMenuItem
                                        to={path}
                                        icon={IconArrowBearRight2}
                                        leadingIconClassName="text-blue-500 -mr-0.5 -ml-1"
                                        title="Switch to branch"
                                      />
                                    )}
                                    {!branch.archivedAt ? (
                                      <ArchiveButton
                                        environment={branch}
                                        // The root dev env (no parent) is the default
                                        // branch and can't be archived — matches the
                                        // guard in ArchiveBranchService.
                                        disabled={!branch.parentEnvironmentId}
                                      />
                                    ) : null}
                                  </>
                                ) : null
                              }
                            />
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>

              <div className="flex w-full items-start justify-between">
                <div className="flex h-fit w-full items-center gap-4 border-t border-grid-bright bg-background-bright p-[0.86rem] pl-4">
                  <SimpleTooltip
                    button={
                      <div className="size-6">
                        <svg className="h-full w-full -rotate-90 overflow-visible">
                          <circle
                            className="fill-none stroke-grid-bright"
                            strokeWidth="4"
                            r="10"
                            cx="12"
                            cy="12"
                          />
                          <circle
                            className={`fill-none ${atBranchLimit ? "stroke-error" : "stroke-success"
                              }`}
                            strokeWidth="4"
                            r="10"
                            cx="12"
                            cy="12"
                            strokeDasharray={`${usageRatio * 62.8} 62.8`}
                            strokeDashoffset="0"
                            strokeLinecap="round"
                          />
                        </svg>
                      </div>
                    }
                    content={`${Math.round(usageRatio * 100)}%`}
                  />
                  <div className="flex w-full items-center justify-between gap-6">
                    {atBranchLimit ? (
                      <Header3 className="text-error">
                        You've used all {limits.limit} of your branches. Archive one to free up
                        space.
                      </Header3>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Header3>
                          You've used {limits.used}/{limits.limit} of your branches
                        </Header3>
                        <InfoIconTooltip content="Archived branches don't count towards your limit." />
                      </div>
                    )}
                  </div>
                </div>
              </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

export function BranchFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { showArchived } = BranchesOptions.parse(Object.fromEntries(searchParams.entries()));

  const handleArchivedChange = useCallback((checked: boolean) => {
    setSearchParams((s) => {
      if (checked) {
        s.set("showArchived", "true");
      } else {
        s.delete("showArchived");
      }
      s.delete("page");
      return s;
    });
  }, []);

  return (
    <div className="flex w-full items-center justify-between gap-2">
      <SearchInput placeholder="Search branch name…" resetParams={["page"]} />
      <Switch
        checked={showArchived ?? false}
        onCheckedChange={handleArchivedChange}
        label="Show archived"
        variant="secondary/small"
      />
    </div>
  );
}

function BranchLimitReachedDialog({
  limits,
}: {
  limits: {
    used: number;
    limit: number;
  };
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          LeadingIcon={PlusIcon}
          leadingIconClassName="text-white"
          variant="primary/small"
          shortcut={{ key: "n" }}
        >
          New branch
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>You've exceeded your limit</DialogHeader>
        <div className="mt-2">
          <Paragraph spacing>
            You've used {limits.used}/{limits.limit} of your branches.
          </Paragraph>
          <Paragraph>You can archive a branch to free up space.</Paragraph>
        </div>
      </DialogContent>
    </Dialog>
  );
}

