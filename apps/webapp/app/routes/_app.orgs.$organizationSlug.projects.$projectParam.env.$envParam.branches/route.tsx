import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ArrowUpCircleIcon, CheckIcon, EnvelopeIcon, PlusIcon } from "@heroicons/react/20/solid";
import { BookOpenIcon } from "@heroicons/react/24/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useActionData, useLocation, useNavigation, useSearchParams } from "@remix-run/react";
import { type ActionFunctionArgs, json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { GitMeta, tryCatch } from "@trigger.dev/core/v3";
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
import { InputNumberStepper } from "~/components/primitives/InputNumberStepper";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import * as Property from "~/components/primitives/PropertyTable";
import { SpinnerWhite } from "~/components/primitives/Spinner";
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

import { findProjectBySlug } from "~/models/project.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { BranchesPresenter } from "~/presenters/v3/BranchesPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { UpsertBranchService } from "~/services/upsertBranch.server";
import { cn } from "~/utils/cn";
import {
  branchesPath,
  docsPath,
  EnvironmentParamSchema,
  ProjectParamSchema,
  v3BillingPath,
} from "~/utils/pathBuilder";
import { formatCurrency, formatNumber } from "~/utils/numberFormatter";
import { SetBranchesAddOnService } from "~/v3/services/setBranchesAddOn.server";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { ArchiveButton } from "../resources.branches.archive";
import { IconArrowBearRight2 } from "@tabler/icons-react";

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

const PurchaseSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("purchase"),
    amount: z.coerce.number().min(0, "Amount must be 0 or more"),
  }),
  z.object({
    action: z.literal("quota-increase"),
    amount: z.coerce.number().min(1, "Amount must be greater than 0"),
  }),
]);

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);

  const formData = await request.formData();
  const formType = formData.get("_formType");

  if (formType === "purchase-branches") {
    const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
    const project = await findProjectBySlug(organizationSlug, projectParam, userId);
    const redirectPath = branchesPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam }
    );

    if (!project) {
      throw redirectWithErrorMessage(redirectPath, request, "Project not found");
    }

    const submission = parse(formData, { schema: PurchaseSchema });

    if (!submission.value || submission.intent !== "submit") {
      return json(submission);
    }

    const service = new SetBranchesAddOnService();
    const [error, result] = await tryCatch(
      service.call({
        userId,
        organizationId: project.organizationId,
        action: submission.value.action,
        amount: submission.value.amount,
      })
    );

    if (error) {
      submission.error.amount = [error instanceof Error ? error.message : "Unknown error"];
      return json(submission);
    }

    if (!result.success) {
      submission.error.amount = [result.error];
      return json(submission);
    }

    return redirectWithSuccessMessage(
      `${redirectPath}?purchaseSuccess=true`,
      request,
      submission.value.action === "purchase"
        ? "Preview branches updated successfully"
        : "Requested extra preview branches, we'll get back to you soon."
    );
  }

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
    canPurchaseBranches,
    extraBranches,
    branchPricing,
    maxBranchQuota,
    planBranchLimit,
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
            <UpgradePanel
              limits={limits}
              canUpgrade={canUpgrade ?? false}
              canPurchaseBranches={canPurchaseBranches}
              branchPricing={branchPricing}
              extraBranches={extraBranches}
              maxBranchQuota={maxBranchQuota}
              planBranchLimit={planBranchLimit}
            />
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
              parentEnvironment={branchableEnvironment}
            />
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

                    {canPurchaseBranches && branchPricing ? (
                      <PurchaseBranchesModal
                        branchPricing={branchPricing}
                        extraBranches={extraBranches}
                        activeBranches={limits.used}
                        maxQuota={maxBranchQuota}
                        planBranchLimit={planBranchLimit}
                      />
                    ) : canUpgrade ? (
                      <div className="flex items-center gap-3">
                        <Paragraph variant="small" className="whitespace-nowrap text-text-dimmed">
                          Upgrade plan for more Preview Branches
                        </Paragraph>
                        <LinkButton
                          to={v3BillingPath(organization)}
                          variant="secondary/small"
                          LeadingIcon={ArrowUpCircleIcon}
                          leadingIconClassName="text-indigo-500"
                        >
                          Upgrade
                        </LinkButton>
                      </div>
                    ) : null}
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
      <SearchInput placeholder="Search branch name" resetParams={["page"]} />
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
  canPurchaseBranches,
  branchPricing,
  extraBranches,
  maxBranchQuota,
  planBranchLimit,
}: {
  limits: {
    used: number;
    limit: number;
  };
  canUpgrade: boolean;
  canPurchaseBranches: boolean;
  branchPricing: { stepSize: number; centsPerStep: number } | null;
  extraBranches: number;
  maxBranchQuota: number;
  planBranchLimit: number;
}) {
  const organization = useOrganization();

  if (canPurchaseBranches && branchPricing) {
    return (
      <PurchaseBranchesModal
        branchPricing={branchPricing}
        extraBranches={extraBranches}
        activeBranches={limits.used}
        maxQuota={maxBranchQuota}
        planBranchLimit={planBranchLimit}
        triggerButton={
          <Button
            LeadingIcon={PlusIcon}
            leadingIconClassName="text-white"
            variant="primary/small"
            shortcut={{ key: "n" }}
          >
            Purchase more…
          </Button>
        }
      />
    );
  }

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
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PurchaseBranchesModal({
  branchPricing,
  extraBranches,
  activeBranches,
  maxQuota,
  planBranchLimit,
  triggerButton,
}: {
  branchPricing: {
    stepSize: number;
    centsPerStep: number;
  };
  extraBranches: number;
  activeBranches: number;
  maxQuota: number;
  planBranchLimit: number;
  triggerButton?: React.ReactNode;
}) {
  const lastSubmission = useActionData();
  const organization = useOrganization();
  const [form, { amount }] = useForm({
    id: "purchase-branches",
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: PurchaseSchema });
    },
    shouldRevalidate: "onSubmit",
  });

  const [amountValue, setAmountValue] = useState(extraBranches);
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle" && navigation.formMethod === "POST";

  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const success = searchParams.get("purchaseSuccess");
    if (success) {
      setOpen(false);
      setSearchParams((s) => {
        s.delete("purchaseSuccess");
        return s;
      });
    }
  }, [searchParams.get("purchaseSuccess")]);

  const state = updateBranchState({
    value: amountValue,
    existingValue: extraBranches,
    quota: maxQuota,
    activeBranches,
    planBranchLimit,
  });
  const changeClassName =
    state === "decrease" ? "text-error" : state === "increase" ? "text-success" : undefined;

  const pricePerBranch = branchPricing.centsPerStep / branchPricing.stepSize / 100;
  const title = extraBranches === 0 ? "Purchase extra branches" : "Add/remove branches";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {triggerButton ?? (
          <Button variant="primary/small" onClick={() => setOpen(true)}>
            Purchase more…
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>{title}</DialogHeader>
        <Form method="post" {...form.props}>
          <input type="hidden" name="_formType" value="purchase-branches" />
          <div className="flex flex-col gap-4 pt-2">
            <div className="flex flex-col gap-1">
              <Paragraph variant="base/bright">
                Purchase extra preview branches at {formatCurrency(pricePerBranch, false)}/month per
                branch. Reducing the number of branches will take effect at the start of the next
                billing cycle (1st of the month).
              </Paragraph>
            </div>
            <Fieldset>
              <InputGroup fullWidth>
                <Label htmlFor="amount" className="text-text-dimmed">
                  Total extra branches
                </Label>
                <InputNumberStepper
                  {...conform.input(amount, { type: "number" })}
                  step={branchPricing.stepSize}
                  min={0}
                  max={undefined}
                  value={amountValue}
                  onChange={(e) => setAmountValue(Number(e.target.value))}
                  disabled={isLoading}
                />
                <FormError id={amount.errorId}>
                  {amount.error ?? amount.initialError?.[""]?.[0]}
                </FormError>
                <FormError>{form.error}</FormError>
              </InputGroup>
            </Fieldset>
            {state === "need_to_archive" ? (
              <div className="flex flex-col pb-3">
                <Paragraph variant="small" className="text-warning" spacing>
                  You need to archive{" "}
                  {formatNumber(activeBranches - (planBranchLimit + amountValue))} more{" "}
                  {activeBranches - (planBranchLimit + amountValue) === 1 ? "branch" : "branches"}{" "}
                  before you can reduce to this level.
                </Paragraph>
              </div>
            ) : state === "above_quota" ? (
              <div className="flex flex-col pb-3">
                <Paragraph variant="small" className="text-warning" spacing>
                  Currently you can only have up to {maxQuota} extra preview branches. Send a
                  request below to lift your current limit. We'll get back to you soon.
                </Paragraph>
              </div>
            ) : (
              <div className="flex flex-col pb-3 tabular-nums">
                <div className="grid grid-cols-2 border-b border-grid-dimmed pb-1">
                  <Header3 className="font-normal text-text-dimmed">Summary</Header3>
                  <Header3 className="justify-self-end font-normal text-text-dimmed">Total</Header3>
                </div>
                <div className="grid grid-cols-2 pt-2">
                  <Header3 className="pb-0 font-normal text-text-dimmed">
                    <span className="text-text-bright">{formatNumber(extraBranches)}</span> current
                    extra
                  </Header3>
                  <Header3 className="justify-self-end font-normal text-text-bright">
                    {formatCurrency(extraBranches * pricePerBranch, true)}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({extraBranches} {extraBranches === 1 ? "branch" : "branches"})
                  </span>
                  <span className="justify-self-end text-text-dimmed">/mth</span>
                </div>
                <div className="grid grid-cols-2 pt-2">
                  <Header3 className={cn("pb-0 font-normal", changeClassName)}>
                    {state === "increase" ? "+" : null}
                    {formatNumber(amountValue - extraBranches)}
                  </Header3>
                  <Header3 className={cn("justify-self-end font-normal", changeClassName)}>
                    {state === "increase" ? "+" : null}
                    {formatCurrency((amountValue - extraBranches) * pricePerBranch, true)}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({Math.abs(amountValue - extraBranches)}{" "}
                    {Math.abs(amountValue - extraBranches) === 1 ? "branch" : "branches"} @{" "}
                    {formatCurrency(pricePerBranch, true)}/mth)
                  </span>
                  <span className="justify-self-end text-text-dimmed">/mth</span>
                </div>
                <div className="grid grid-cols-2 pt-2">
                  <Header3 className="pb-0 font-normal text-text-dimmed">
                    <span className="text-text-bright">{formatNumber(amountValue)}</span> new total
                  </Header3>
                  <Header3 className="justify-self-end font-normal text-text-bright">
                    {formatCurrency(amountValue * pricePerBranch, true)}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({amountValue} {amountValue === 1 ? "branch" : "branches"})
                  </span>
                  <span className="justify-self-end text-text-dimmed">/mth</span>
                </div>
              </div>
            )}
          </div>
          <FormButtons
            confirmButton={
              state === "above_quota" ? (
                <>
                  <input type="hidden" name="action" value="quota-increase" />
                  <Button
                    LeadingIcon={isLoading ? SpinnerWhite : EnvelopeIcon}
                    variant="primary/medium"
                    type="submit"
                    disabled={isLoading}
                  >
                    {`Send request for ${formatNumber(amountValue)}`}
                  </Button>
                </>
              ) : state === "decrease" || state === "need_to_archive" ? (
                <>
                  <input type="hidden" name="action" value="purchase" />
                  <Button
                    variant="danger/medium"
                    type="submit"
                    disabled={isLoading || state === "need_to_archive"}
                    LeadingIcon={isLoading ? SpinnerWhite : undefined}
                  >
                    {`Remove ${formatNumber(extraBranches - amountValue)} ${
                      extraBranches - amountValue === 1 ? "branch" : "branches"
                    }`}
                  </Button>
                </>
              ) : (
                <>
                  <input type="hidden" name="action" value="purchase" />
                  <Button
                    variant="primary/medium"
                    type="submit"
                    disabled={isLoading || state === "no_change"}
                    LeadingIcon={isLoading ? SpinnerWhite : undefined}
                  >
                    {`Purchase ${formatNumber(amountValue - extraBranches)} ${
                      amountValue - extraBranches === 1 ? "branch" : "branches"
                    }`}
                  </Button>
                </>
              )
            }
            cancelButton={
              <DialogClose asChild>
                <Button variant="secondary/medium" disabled={isLoading}>
                  Cancel
                </Button>
              </DialogClose>
            }
          />
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function updateBranchState({
  value,
  existingValue,
  quota,
  activeBranches,
  planBranchLimit,
}: {
  value: number;
  existingValue: number;
  quota: number;
  activeBranches: number;
  planBranchLimit: number;
}): "no_change" | "increase" | "decrease" | "above_quota" | "need_to_archive" {
  if (value === existingValue) return "no_change";
  if (value < existingValue) {
    const newTotalLimit = planBranchLimit + value;
    if (activeBranches > newTotalLimit) {
      return "need_to_archive";
    }
    return "decrease";
  }
  if (value > quota) return "above_quota";
  return "increase";
}

export function NewBranchPanel({
  button,
  parentEnvironment,
}: {
  button: React.ReactNode;
  parentEnvironment: { id: string };
}) {
  const lastSubmission = useActionData<typeof action>();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isOpen, setIsOpen] = useState(false);

  const [form, { parentEnvironmentId, branchName, failurePath }] = useForm({
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
                value={parentEnvironment.id}
                {...conform.input(parentEnvironmentId, { type: "hidden" })}
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
