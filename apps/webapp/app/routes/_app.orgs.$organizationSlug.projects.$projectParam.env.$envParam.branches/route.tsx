import {
  ArchiveBoxIcon,
  ArrowRightIcon,
  ArrowUpCircleIcon,
  CheckIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from "@heroicons/react/20/solid";
import { BookOpenIcon } from "@heroicons/react/24/solid";
import { useLocation, useNavigate, useSearchParams } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useCallback } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { BranchEnvironmentIconSmall } from "~/assets/icons/EnvironmentIcons";
import { BranchesNoBranchableEnvironment, BranchesNoBranches } from "~/components/BlankStatePanels";
import { Feedback } from "~/components/Feedback";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
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
import { usePathName } from "~/hooks/usePathName";
import { useProject } from "~/hooks/useProject";
import { useThrottle } from "~/hooks/useThrottle";
import { BranchesPresenter } from "~/presenters/v3/BranchesPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  docsPath,
  ProjectParamSchema,
  v3BillingPath,
  v3EnvironmentPath,
} from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { NewBranchPanel } from "../resources.branches.new";
import { ArchiveIcon, UnarchiveIcon } from "~/assets/icons/ArchiveIcon";

export const BranchesOptions = z.object({
  search: z.string().optional(),
  showArchived: z.preprocess((val) => val === "true" || val === true, z.boolean()).optional(),
  page: z.number().optional(),
});

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
      ...options,
    });

    return typedjson(result);
  } catch (error) {
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const {
    branchableEnvironment,
    branches,
    hasFilters,
    limits,
    currentPage,
    totalPages,
    totalCount,
  } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();
  const pathName = usePathName();

  const plan = useCurrentPlan();
  const requiresUpgrade =
    plan?.v3Subscription?.plan &&
    limits.used >= plan.v3Subscription.plan.limits.branches.number &&
    !plan.v3Subscription.plan.limits.branches.canExceed;
  const canUpgrade =
    plan?.v3Subscription?.plan && !plan.v3Subscription.plan.limits.branches.canExceed;

  const isAtLimit = limits.used >= limits.limit;

  if (!branchableEnvironment) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title="Preview branches" />
        </NavBar>
        <PageBody>
          <MainCenteredContainer className="max-w-md">
            <BranchesNoBranchableEnvironment />
          </MainCenteredContainer>
        </PageBody>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Preview branches" />
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

          <LinkButton variant={"docs/small"} LeadingIcon={BookOpenIcon} to={docsPath("branches")}>
            Branches docs
          </LinkButton>

          {isAtLimit ? (
            <UpgradePanel limits={limits} canUpgrade={canUpgrade ?? false} />
          ) : (
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  variant="primary/small"
                  shortcut={{ key: "n" }}
                  LeadingIcon={PlusIcon}
                  leadingIconClassName="text-white"
                  fullWidth
                  textAlignLeft
                >
                  New branch
                </Button>
              </DialogTrigger>
              <DialogContent>
                <NewBranchPanel parentEnvironment={branchableEnvironment} />
              </DialogContent>
            </Dialog>
          )}
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid max-h-full min-h-full grid-rows-[auto_1fr_auto]">
          {totalCount === 0 && !hasFilters ? (
            <MainCenteredContainer className="max-w-md">
              <BranchesNoBranches
                parentEnvironment={branchableEnvironment}
                limits={limits}
                canUpgrade={canUpgrade ?? false}
              />
            </MainCenteredContainer>
          ) : (
            <>
              <div className="flex items-center justify-between gap-x-2 p-2">
                <BranchFilters />
                <div className="flex items-center justify-end gap-x-2">
                  <PaginationControls
                    currentPage={currentPage}
                    totalPages={totalPages}
                    showPageNumbers={false}
                  />
                </div>
              </div>

              <div
                className={cn(
                  "grid max-h-full min-h-full overflow-x-auto",
                  totalPages > 1 ? "grid-rows-[1fr_auto]" : "grid-rows-[1fr]"
                )}
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Branch</TableHeaderCell>
                      <TableHeaderCell>Created</TableHeaderCell>
                      <TableHeaderCell>Git branch</TableHeaderCell>
                      <TableHeaderCell>Git PR</TableHeaderCell>
                      <TableHeaderCell>Archived</TableHeaderCell>
                      <TableHeaderCell>
                        <span className="sr-only">Actions</span>
                      </TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {branches.length === 0 ? (
                      <TableBlankRow colSpan={10}>
                        There are no matches for your filters
                      </TableBlankRow>
                    ) : (
                      branches.map((branch) => {
                        const path = v3EnvironmentPath(organization, project, branch);
                        const cellClass = branch.archivedAt ? "opacity-50" : "";

                        return (
                          <TableRow key={branch.id}>
                            <TableCell isTabbableCell className={cellClass}>
                              <div className="flex items-center gap-1">
                                <BranchEnvironmentIconSmall className="size-4" />
                                <CopyableText value={branch.branchName ?? ""} />
                              </div>
                            </TableCell>
                            <TableCell className={cellClass}>
                              <DateTime date={branch.createdAt} />
                            </TableCell>
                            <TableCell className={cellClass}>
                              {branch.git?.branch ? (
                                <CopyableText value={branch.git.branch} />
                              ) : (
                                "–"
                              )}
                            </TableCell>
                            <TableCell className={cellClass}>
                              {branch.git?.pr ? <CopyableText value={branch.git.pr} /> : "–"}
                            </TableCell>
                            <TableCell className={cellClass}>
                              {branch.archivedAt ? (
                                <CheckIcon className="size-4 text-charcoal-400" />
                              ) : (
                                "–"
                              )}
                            </TableCell>
                            <TableCellMenu
                              isSticky
                              hiddenButtons={<PopoverMenuItem to={path} title="View branch" />}
                              popoverContent={
                                <>
                                  <PopoverMenuItem
                                    to={path}
                                    icon={ArrowRightIcon}
                                    leadingIconClassName="text-blue-500"
                                    title="View branch"
                                  />
                                  {branch.archivedAt ? (
                                    <>
                                      {isAtLimit ? (
                                        <UpgradePanel
                                          limits={limits}
                                          canUpgrade={canUpgrade ?? false}
                                        />
                                      ) : (
                                        <Button
                                          variant="small-menu-item"
                                          LeadingIcon={UnarchiveIcon}
                                          leadingIconClassName="text-text-dimmed"
                                          fullWidth
                                          textAlignLeft
                                          className="w-full px-1.5 py-[0.9rem]"
                                        >
                                          Unarchive branch
                                        </Button>
                                      )}
                                    </>
                                  ) : (
                                    <Dialog>
                                      <DialogTrigger
                                        asChild
                                        className="size-6 rounded-sm p-1 text-text-dimmed transition hover:bg-charcoal-700 hover:text-text-bright"
                                      >
                                        <Button
                                          variant="small-menu-item"
                                          LeadingIcon={ArchiveIcon}
                                          leadingIconClassName="text-error"
                                          fullWidth
                                          textAlignLeft
                                          className="w-full px-1.5 py-[0.9rem]"
                                        >
                                          Archive branch
                                        </Button>
                                      </DialogTrigger>
                                    </Dialog>
                                  )}
                                </>
                              }
                            />
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
                <div
                  className={cn(
                    "flex min-h-full",
                    totalPages > 1 && "justify-end border-t border-grid-dimmed px-2 py-3"
                  )}
                >
                  <PaginationControls currentPage={currentPage} totalPages={totalPages} />
                </div>
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
                            className={`fill-none ${
                              requiresUpgrade ? "stroke-error" : "stroke-success"
                            }`}
                            strokeWidth="4"
                            r="10"
                            cx="12"
                            cy="12"
                            strokeDasharray={`${(limits.used / limits.limit) * 62.8} 62.8`}
                            strokeDashoffset="0"
                            strokeLinecap="round"
                          />
                        </svg>
                      </div>
                    }
                    content={`${Math.round((limits.used / limits.limit) * 100)}%`}
                  />
                  <div className="flex w-full items-center justify-between gap-6">
                    {requiresUpgrade ? (
                      <Header3 className="text-error">
                        You've used all {limits.limit} of your branches. Archive one or upgrade your
                        plan to enable more.
                      </Header3>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Header3>
                          You've used {limits.used}/{limits.limit} of your branches
                        </Header3>
                        <InfoIconTooltip content="Archived branches don't count towards your limit." />
                      </div>
                    )}

                    {canUpgrade ? (
                      <LinkButton
                        to={v3BillingPath(organization)}
                        variant="secondary/small"
                        LeadingIcon={ArrowUpCircleIcon}
                        leadingIconClassName="text-indigo-500"
                      >
                        Upgrade
                      </LinkButton>
                    ) : (
                      <Feedback
                        button={<Button variant="secondary/small">Request more</Button>}
                        defaultValue="help"
                      />
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </PageBody>
    </PageContainer>
  );
}

export function BranchFilters() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { search, showArchived, page } = BranchesOptions.parse(
    Object.fromEntries(searchParams.entries())
  );

  const handleFilterChange = useCallback((filterType: string, value: string | undefined) => {
    setSearchParams((s) => {
      if (value) {
        searchParams.set(filterType, value);
      } else {
        searchParams.delete(filterType);
      }
      searchParams.delete("page");
      return searchParams;
    });
  }, []);

  const handleArchivedChange = useCallback((checked: boolean) => {
    handleFilterChange("showArchived", checked ? "true" : undefined);
  }, []);

  const handleSearchChange = useThrottle((value: string) => {
    handleFilterChange("search", value.length === 0 ? undefined : value);
  }, 300);

  return (
    <div className="flex w-full">
      <Input
        name="search"
        placeholder="Search branch name"
        icon={MagnifyingGlassIcon}
        variant="tertiary"
        className="grow"
        defaultValue={search}
        onChange={(e) => handleSearchChange(e.target.value)}
      />

      <Switch
        checked={showArchived ?? false}
        onCheckedChange={handleArchivedChange}
        label="Show archived"
        variant="small"
      />
    </div>
  );
}

function UpgradePanel({
  limits,
  canUpgrade,
}: {
  limits: {
    used: number;
    limit: number;
  };
  canUpgrade: boolean;
}) {
  const organization = useOrganization();

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
        <DialogDescription>
          You've used {limits.used}/{limits.limit} of your branches.
        </DialogDescription>
        <DialogFooter>
          {canUpgrade ? (
            <LinkButton variant="primary/small" to={v3BillingPath(organization)}>
              Upgrade
            </LinkButton>
          ) : (
            <Feedback
              button={<Button variant="primary/small">Request more</Button>}
              defaultValue="help"
            />
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
