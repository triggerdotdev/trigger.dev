import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import {
  ArrowRightIcon,
  ArrowUpCircleIcon,
  CheckIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from "@heroicons/react/20/solid";
import { BookOpenIcon } from "@heroicons/react/24/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useActionData, useSearchParams } from "@remix-run/react";
import { type ActionFunctionArgs, json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { GitMeta } from "@trigger.dev/core/v3";
import { useCallback } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { BranchEnvironmentIconSmall } from "~/assets/icons/EnvironmentIcons";
import { BranchesNoBranchableEnvironment, BranchesNoBranches } from "~/components/BlankStatePanels";
import { Feedback } from "~/components/Feedback";
import { GitMetadata } from "~/components/GitMetadata";
import { V4Title } from "~/components/V4Badge";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { InlineCode } from "~/components/code/InlineCode";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
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
import { useThrottle } from "~/hooks/useThrottle";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { BranchesPresenter } from "~/presenters/v3/BranchesPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { UpsertBranchService } from "~/services/upsertBranch.server";
import { cn } from "~/utils/cn";
import { branchesPath, docsPath, ProjectParamSchema, v3BillingPath } from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { ArchiveButton } from "../resources.branches.archive";

export const BranchesOptions = z.object({
  search: z.string().optional(),
  showArchived: z.preprocess((val) => val === "true" || val === true, z.boolean()).optional(),
  page: z.preprocess((val) => Number(val), z.number()).optional(),
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
    logger.error("Error loading preview branches page", { error });
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export const CreateBranchOptions = z.object({
  parentEnvironmentId: z.string(),
  branchName: z.string().min(1),
  git: GitMeta.optional(),
});

export type CreateBranchOptions = z.infer<typeof CreateBranchOptions>;

export const schema = CreateBranchOptions.and(
  z.object({
    failurePath: z.string(),
  })
);

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value) {
    return redirectWithErrorMessage("/", request, "Invalid form data");
  }

  const upsertBranchService = new UpsertBranchService();
  const result = await upsertBranchService.call(userId, submission.value);

  if (result.success) {
    if (result.alreadyExisted) {
      submission.error = {
        branchName: [
          `Branch "${result.branch.branchName}" already exists. You can archive it and create a new one with the same name.`,
        ],
      };
      return json(submission);
    }

    return redirectWithSuccessMessage(
      branchesPath(result.organization, result.project, result.branch),
      request,
      `Branch "${result.branch.branchName}" created`
    );
  }

  submission.error = { branchName: [result.error] };
  return json(submission);
}

export default function Page() {
  const {
    branchableEnvironment,
    branches,
    hasFilters,
    limits,
    currentPage,
    totalPages,
    hasBranches,
  } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const plan = useCurrentPlan();
  const requiresUpgrade =
    plan?.v3Subscription?.plan &&
    limits.used >= plan.v3Subscription.plan.limits.branches.number &&
    !plan.v3Subscription.plan.limits.branches.canExceed;
  const canUpgrade =
    plan?.v3Subscription?.plan && !plan.v3Subscription.plan.limits.branches.canExceed;

  if (!branchableEnvironment) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title={<V4Title>Preview branches</V4Title>} />
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
        <PageTitle title={<V4Title>Preview branches</V4Title>} />
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
            to={docsPath("deployment/preview-branches")}
          >
            Branches docs
          </LinkButton>

          {limits.isAtLimit ? (
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
          {!hasBranches ? (
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
                      <TableHeaderCell>Git</TableHeaderCell>
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
                        const path = branchesPath(organization, project, branch);
                        const cellClass = branch.archivedAt ? "opacity-50" : "";
                        const isSelected = branch.id === environment.id;

                        return (
                          <TableRow key={branch.id}>
                            <TableCell isTabbableCell className={cellClass}>
                              <div className="flex items-center gap-1">
                                <BranchEnvironmentIconSmall
                                  className={cn("size-4", isSelected && "text-preview")}
                                />
                                <CopyableText
                                  value={branch.branchName ?? ""}
                                  className={cn(isSelected && "text-preview")}
                                />
                                {isSelected && <Badge variant="extra-small">Current</Badge>}
                              </div>
                            </TableCell>
                            <TableCell className={cellClass}>
                              <DateTime date={branch.createdAt} />
                            </TableCell>
                            <TableCell className={cellClass}>
                              <div className="-ml-1 flex items-center">
                                <GitMetadata git={branch.git} />
                              </div>
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
                                  <PopoverMenuItem to={path} title="Switch to branch" />
                                )
                              }
                              popoverContent={
                                !isSelected || !branch.archivedAt ? (
                                  <>
                                    {isSelected ? null : (
                                      <PopoverMenuItem
                                        to={path}
                                        icon={ArrowRightIcon}
                                        leadingIconClassName="text-blue-500"
                                        title="Switch to branch"
                                      />
                                    )}
                                    {!branch.archivedAt ? (
                                      <ArchiveButton environment={branch} />
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
    <div className="flex w-full gap-2">
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
        <div className="mt-2">
          <Paragraph spacing>
            You've used {limits.used}/{limits.limit} of your branches.
          </Paragraph>
          <Paragraph>You can archive one or upgrade your plan for more.</Paragraph>
        </div>
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

export function NewBranchPanel({ parentEnvironment }: { parentEnvironment: { id: string } }) {
  const lastSubmission = useActionData<typeof action>();

  const [form, { parentEnvironmentId, branchName, failurePath }] = useForm({
    id: "create-branch",
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onInput",
  });

  return (
    <>
      <DialogHeader>New branch</DialogHeader>
      <div className="mt-2 flex flex-col gap-4">
        <Form method="post" {...form.props} className="w-full">
          <Fieldset className="max-w-full gap-y-3">
            <input
              value={parentEnvironment.id}
              {...conform.input(parentEnvironmentId, { type: "hidden" })}
            />
            <input value={location.pathname} {...conform.input(failurePath, { type: "hidden" })} />
            <InputGroup className="max-w-full">
              <Label>Branch name</Label>
              <Input {...conform.input(branchName)} />
              <Hint>
                Must not contain: spaces <InlineCode variant="extra-small">~</InlineCode>{" "}
                <InlineCode variant="extra-small">^</InlineCode>{" "}
                <InlineCode variant="extra-small">:</InlineCode>{" "}
                <InlineCode variant="extra-small">?</InlineCode>{" "}
                <InlineCode variant="extra-small">*</InlineCode>{" "}
                <InlineCode variant="extra-small">{"["}</InlineCode>{" "}
                <InlineCode variant="extra-small">\</InlineCode>{" "}
                <InlineCode variant="extra-small">//</InlineCode>{" "}
                <InlineCode variant="extra-small">..</InlineCode>{" "}
                <InlineCode variant="extra-small">{"@{"}</InlineCode>{" "}
                <InlineCode variant="extra-small">.lock</InlineCode>
              </Hint>
              <FormError id={branchName.errorId}>{branchName.error}</FormError>
            </InputGroup>
            <FormError>{form.error}</FormError>
            <FormButtons
              confirmButton={
                <Button type="submit" variant="primary/medium">
                  Create branch
                </Button>
              }
              cancelButton={
                <DialogClose asChild>
                  <Button variant="tertiary/medium">Cancel</Button>
                </DialogClose>
              }
            />
          </Fieldset>
        </Form>
      </div>
    </>
  );
}
