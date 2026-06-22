import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { CheckIcon, PlusIcon } from "@heroicons/react/20/solid";
import { BookOpenIcon } from "@heroicons/react/24/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useActionData, useLocation, useSearchParams } from "@remix-run/react";
import { type ActionFunctionArgs, json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { GitMeta } from "@trigger.dev/core/v3";
import { useCallback, useEffect, useState } from "react";
import { SearchInput } from "~/components/primitives/SearchInput";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { BranchEnvironmentIconSmall } from "~/assets/icons/EnvironmentIcons";
import { BranchesNoBranchableEnvironment, BranchesNoBranches } from "~/components/BlankStatePanels";
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
import { useShowSelfServe } from "~/hooks/useShowSelfServe";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";

import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { BranchesPresenter } from "~/presenters/v3/BranchesPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { UpsertBranchService } from "~/services/upsertBranch.server";
import { cn } from "~/utils/cn";
import {
  branchesDevPath,
  branchesPath,
  docsPath,
  ProjectParamSchema,
} from "~/utils/pathBuilder";
import { ArchiveButton } from "../resources.branches.archive";
import { IconArrowBearRight2 } from "@tabler/icons-react";

export const BranchesOptions = z.object({
  search: z.string().optional(),
  showArchived: z.preprocess((val) => val === "true" || val === true, z.boolean()).optional(),
  page: z.preprocess((val) => Number(val), z.number()).optional(),
});

export const CreateBranchOptions = z.object({
  projectId: z.string(),
  env: z.enum(["preview", "development"]),
  branchName: z.string().min(1),
  git: GitMeta.optional(),
});

export const schema = CreateBranchOptions.and(
  z.object({
    failurePath: z.string(),
  })
);

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
    logger.error("Error loading preview branches page", { error });
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);

  const formData = await request.formData();

  const submission = parse(formData, { schema });

  if (!submission.value) {
    return redirectWithErrorMessage("/", request, "Invalid form data");
  }

  const upsertBranchService = new UpsertBranchService();
  const result = await upsertBranchService.call(
    { type: "userMembership", userId },
    submission.value
  );

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
      `${branchesPath(result.organization, result.project, result.branch)}?dialogClosed=true`,
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

  const showSelfServe = useShowSelfServe();
  const atBranchLimit = limits.used >= limits.limit;
  const usageRatio = limits.limit > 0 ? Math.min(limits.used / limits.limit, 1) : 0;

  if (!branchableEnvironment) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title={<V4Title>Dev branches</V4Title>} />
        </NavBar>
        <PageBody>
          <MainCenteredContainer className="max-w-md">
            <BranchesNoBranchableEnvironment showSelfServe={showSelfServe} />
          </MainCenteredContainer>
        </PageBody>
      </PageContainer>
    );
  }

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
          {!hasBranches ? (
            <MainCenteredContainer className="max-w-md">
              <BranchesNoBranches
                envType="development"
                limits={limits}
                canUpgrade={false}
                showSelfServe={showSelfServe}
              />
            </MainCenteredContainer>
          ) : (
            <>
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
                                  value={branch.branchName ?? ""}
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
            </>
          )}
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

export function NewBranchPanel({
  button,
  env,
}: {
  button: React.ReactNode;
  env: "preview" | "development";
}) {
  const project = useProject();
  const lastSubmission = useActionData<typeof action>();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isOpen, setIsOpen] = useState(false);

  const [form, { projectId, env: envField, branchName, failurePath }] = useForm({
    id: "create-branch",
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onInput",
  });

  useEffect(() => {
    if (searchParams.has("dialogClosed")) {
      setSearchParams((s) => {
        s.delete("dialogClosed");
        return s;
      });
      setIsOpen(false);
    }
  }, [searchParams, setSearchParams]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>{button}</DialogTrigger>
      <DialogContent>
        <DialogHeader>New branch</DialogHeader>
        <div className="mt-2 flex flex-col gap-4">
          <Form method="post" {...form.props} className="w-full">
            <Fieldset className="max-w-full gap-y-3">
              <input
                value={project.id}
                {...conform.input(projectId, { type: "hidden" })}
              />
              <input
                value={env}
                {...conform.input(envField, { type: "hidden" })}
              />
              <input
                value={location.pathname}
                {...conform.input(failurePath, { type: "hidden" })}
              />
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
      </DialogContent>
    </Dialog>
  );
}
