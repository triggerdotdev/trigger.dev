import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ArrowUpCircleIcon, EnvelopeIcon, PlusIcon } from "@heroicons/react/20/solid";
import { BookOpenIcon } from "@heroicons/react/24/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { type MetaFunction, Outlet, useFetcher, useLocation, useParams } from "@remix-run/react";
import { type ActionFunctionArgs, json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/v3";
import { useEffect, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { SchedulesNoneAttached, SchedulesNoPossibleTaskPanel } from "~/components/BlankStatePanels";
import { Feedback } from "~/components/Feedback";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header3 } from "~/components/primitives/Headers";
import { InputGroup } from "~/components/primitives/InputGroup";
import { InputNumberStepper } from "~/components/primitives/InputNumberStepper";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import {
  RESIZABLE_PANEL_ANIMATION,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  collapsibleHandleClassName,
} from "~/components/primitives/Resizable";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { InfoIconTooltip, SimpleTooltip } from "~/components/primitives/Tooltip";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import { ScheduleFilters, ScheduleListFilters } from "~/components/runs/v3/ScheduleFilters";
import {
  ScheduleTypeCombo,
  ScheduleTypeIcon,
  scheduleTypeName,
} from "~/components/runs/v3/ScheduleType";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { usePathName } from "~/hooks/usePathName";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  type ScheduleListItem,
  ScheduleListPresenter,
} from "~/presenters/v3/ScheduleListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { formatCurrency, formatNumber } from "~/utils/numberFormatter";
import {
  docsPath,
  EnvironmentParamSchema,
  v3BillingPath,
  v3NewSchedulePath,
  v3SchedulePath,
  v3SchedulesPath,
} from "~/utils/pathBuilder";
import { SetSchedulesAddOnService } from "~/v3/services/setSchedulesAddOn.server";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Schedules | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return redirectWithErrorMessage("/", request, "Project not found");
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return redirectWithErrorMessage("/", request, "Environment not found");
  }

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const filters = ScheduleListFilters.parse(s);

  const presenter = new ScheduleListPresenter();
  const list = await presenter.call({
    userId,
    projectId: project.id,
    environmentId: environment.id,
    ...filters,
  });

  return typedjson(list);
};

const PurchaseSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("purchase"),
    amount: z.coerce
      .number()
      .int("Must be a whole number")
      .min(0, "Amount must be 0 or more")
      .refine((n) => n % 1000 === 0, "Schedules are sold in bundles of 1,000"),
  }),
  z.object({
    action: z.literal("quota-increase"),
    amount: z.coerce
      .number()
      .int("Must be a whole number")
      .min(1, "Amount must be greater than 0")
      .refine((n) => n % 1000 === 0, "Schedules are sold in bundles of 1,000"),
  }),
]);

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const formData = await request.formData();

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  const redirectPath = v3SchedulesPath(
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

  const service = new SetSchedulesAddOnService();
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

  return json({ ok: true } as const);
}

export default function Page() {
  const {
    schedules,
    possibleTasks,
    hasFilters,
    limits,
    currentPage,
    totalPages,
    canPurchaseSchedules,
    extraSchedules,
    maxScheduleQuota,
    planScheduleLimit,
    schedulePricing,
  } = useTypedLoaderData<typeof loader>();
  const location = useLocation();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const pathName = usePathName();

  const plan = useCurrentPlan();
  const requiresUpgrade =
    plan?.v3Subscription?.plan &&
    limits.used >= plan.v3Subscription.plan.limits.schedules.number &&
    !plan.v3Subscription.plan.limits.schedules.canExceed;
  const canUpgrade =
    plan?.v3Subscription?.plan && !plan.v3Subscription.plan.limits.schedules.canExceed;

  const { scheduleParam } = useParams();
  const isShowingNewPane = pathName.endsWith("/new");
  const isShowingSchedule = !!scheduleParam;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Schedules" />
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              {schedules.map((schedule) => (
                <Property.Item key={schedule.id}>
                  <Property.Label>{schedule.friendlyId}</Property.Label>
                  <Property.Value>{schedule.id}</Property.Value>
                </Property.Item>
              ))}
            </Property.Table>
          </AdminDebugTooltip>

          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/tasks/scheduled")}
          >
            Schedules docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="schedules-main" min={"100px"}>
            <div className="grid max-h-full min-h-full grid-rows-[auto_1fr_auto]">
              {possibleTasks.length === 0 ? (
                <MainCenteredContainer className="max-w-md">
                  <SchedulesNoPossibleTaskPanel />
                </MainCenteredContainer>
              ) : schedules.length === 0 && !hasFilters ? (
                <MainCenteredContainer className="max-w-md">
                  <SchedulesNoneAttached />
                </MainCenteredContainer>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-x-2 p-2">
                    <ScheduleFilters possibleTasks={possibleTasks} />
                    <div className="flex items-center justify-end gap-x-2">
                      <PaginationControls
                        currentPage={currentPage}
                        totalPages={totalPages}
                        showPageNumbers={false}
                      />
                      {limits.used >= limits.limit ? (
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button
                              LeadingIcon={PlusIcon}
                              leadingIconClassName="text-background-dimmed"
                              variant="primary/small"
                              shortcut={{ key: "n" }}
                              disabled={possibleTasks.length === 0 || isShowingNewPane}
                            >
                              New schedule
                            </Button>
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>You've exceeded your limit</DialogHeader>
                            <DialogDescription>
                              You've used {limits.used}/{limits.limit} of your schedules.
                            </DialogDescription>
                            <DialogFooter>
                              {canPurchaseSchedules && schedulePricing ? (
                                <PurchaseSchedulesModal
                                  schedulePricing={schedulePricing}
                                  extraSchedules={extraSchedules}
                                  usedSchedules={limits.used}
                                  maxQuota={maxScheduleQuota}
                                  planScheduleLimit={planScheduleLimit}
                                  triggerButton={
                                    <Button variant="primary/small">Purchase more…</Button>
                                  }
                                />
                              ) : canUpgrade ? (
                                <LinkButton
                                  variant="primary/small"
                                  to={v3BillingPath(organization)}
                                >
                                  Upgrade
                                </LinkButton>
                              ) : (
                                <Feedback
                                  button={
                                    <Button variant="primary/small">Request more</Button>
                                  }
                                  defaultValue="help"
                                />
                              )}
                            </DialogFooter>
                          </DialogContent>
                        </Dialog>
                      ) : (
                        <LinkButton
                          LeadingIcon={PlusIcon}
                          to={`${v3NewSchedulePath(organization, project, environment)}${location.search}`}
                          variant="primary/small"
                          shortcut={{ key: "n" }}
                          disabled={possibleTasks.length === 0 || isShowingNewPane}
                        >
                          New schedule
                        </LinkButton>
                      )}
                    </div>
                  </div>

                  <div
                    className={cn(
                      "grid max-h-full min-h-full overflow-x-auto",
                      totalPages > 1 ? "grid-rows-[1fr_auto]" : "grid-rows-[1fr]"
                    )}
                  >
                    <SchedulesTable schedules={schedules} hasFilters={hasFilters} />
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
                            You've used all {limits.limit} of your available schedules. Upgrade your
                            plan to enable more.
                          </Header3>
                        ) : (
                          <div className="flex items-center gap-1">
                            <Header3>
                              You've used {limits.used}/{limits.limit} of your schedules
                            </Header3>
                            <InfoIconTooltip content="Schedules created in Dev don't count towards your limit." />
                          </div>
                        )}

                        {canPurchaseSchedules && schedulePricing ? (
                          <PurchaseSchedulesModal
                            schedulePricing={schedulePricing}
                            extraSchedules={extraSchedules}
                            usedSchedules={limits.used}
                            maxQuota={maxScheduleQuota}
                            planScheduleLimit={planScheduleLimit}
                          />
                        ) : canUpgrade ? (
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
          </ResizablePanel>
          <ResizableHandle
            id="schedules-handle"
            className={collapsibleHandleClassName(isShowingNewPane || isShowingSchedule)}
          />
          <ResizablePanel
            id="schedules-inspector"
            min="400px"
            default="500px"
            className="overflow-hidden"
            collapsible
            collapsed={!isShowingNewPane && !isShowingSchedule}
            onCollapseChange={() => {}}
            collapsedSize="0px"
            collapseAnimation={RESIZABLE_PANEL_ANIMATION}
          >
            <div className="h-full" style={{ minWidth: 400 }}>
              <Outlet />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
    </PageContainer>
  );
}

function SchedulesTable({
  schedules,
  hasFilters,
}: {
  schedules: ScheduleListItem[];
  hasFilters: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();
  const { scheduleParam } = useParams();

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>ID</TableHeaderCell>
          <TableHeaderCell>Task ID</TableHeaderCell>
          <TableHeaderCell
            tooltip={
              <div className="flex max-w-xs flex-col gap-4 p-1">
                <div>
                  <div className="mb-0.5 flex items-center gap-1.5 text-sm">
                    <div className={"flex items-center space-x-1"}>
                      <ScheduleTypeIcon type={"DECLARATIVE"} className="text-sky-500" />
                      <span className="font-medium">{scheduleTypeName("DECLARATIVE")}</span>
                    </div>
                  </div>
                  <Paragraph variant="small" className="!text-wrap text-text-dimmed">
                    Declarative schedules are defined in a{" "}
                    <InlineCode variant="extra-small">schedules.task</InlineCode> with the{" "}
                    <InlineCode variant="extra-small">cron</InlineCode>
                    property. They sync when you update your{" "}
                    <InlineCode variant="extra-small">schedules.task</InlineCode> definition and run
                    the CLI dev or deploy commands.
                  </Paragraph>
                </div>
                <div>
                  <div className="mb-0.5 flex items-center gap-1.5 text-sm">
                    <div className={"flex items-center space-x-1"}>
                      <ScheduleTypeIcon type={"IMPERATIVE"} className="text-teal-500" />
                      <span className="font-medium">{scheduleTypeName("IMPERATIVE")}</span>
                    </div>
                  </div>
                  <Paragraph variant="small" className="!text-wrap text-text-dimmed">
                    Imperative schedules are defined here in the dashboard or by using the SDK
                    functions to create or delete them. They can be created, updated, disabled, and
                    deleted from the dashboard or using the SDK.
                  </Paragraph>
                </div>
                <LinkButton
                  variant="docs/small"
                  to={docsPath("v3/tasks-scheduled")}
                  LeadingIcon={BookOpenIcon}
                  className="mb-1"
                >
                  View the docs
                </LinkButton>
              </div>
            }
          >
            Type
          </TableHeaderCell>
          <TableHeaderCell>External ID</TableHeaderCell>
          <TableHeaderCell>CRON</TableHeaderCell>
          <TableHeaderCell hiddenLabel>CRON description</TableHeaderCell>
          <TableHeaderCell>Timezone</TableHeaderCell>
          <TableHeaderCell>Next run</TableHeaderCell>
          <TableHeaderCell>Last run</TableHeaderCell>
          <TableHeaderCell>Deduplication key</TableHeaderCell>
          <TableHeaderCell>Environments</TableHeaderCell>
          <TableHeaderCell>Enabled</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {schedules.length === 0 ? (
          <TableBlankRow colSpan={10}>There are no matches for your filters</TableBlankRow>
        ) : (
          schedules.map((schedule) => {
            const path = `${v3SchedulePath(organization, project, environment, schedule)}${
              location.search
            }`;
            const isSelected = scheduleParam === schedule.friendlyId;
            const cellClass = schedule.active ? "" : "opacity-50";
            const selectedActionClass = isSelected ? "text-text-bright" : undefined;
            return (
              <TableRow key={schedule.id} className={isSelected ? "bg-grid-dimmed" : undefined}>
                <TableCell to={path} isTabbableCell className={cellClass} actionClassName={selectedActionClass}>
                  {schedule.friendlyId}
                </TableCell>
                <TableCell to={path} className={cellClass} actionClassName={selectedActionClass}>
                  {schedule.taskIdentifier}
                </TableCell>
                <TableCell to={path} className={cellClass} actionClassName={selectedActionClass}>
                  <ScheduleTypeCombo type={schedule.type} />
                </TableCell>
                <TableCell to={path} className={cellClass} actionClassName={selectedActionClass}>
                  {schedule.type === "IMPERATIVE"
                    ? schedule.externalId
                      ? schedule.externalId
                      : "–"
                    : "N/A"}
                </TableCell>
                <TableCell to={path} className={cellClass} actionClassName={selectedActionClass}>
                  {schedule.cron}
                </TableCell>
                <TableCell to={path} className={cellClass} actionClassName={selectedActionClass}>
                  {schedule.cronDescription}
                </TableCell>
                <TableCell to={path} className={cellClass} actionClassName={selectedActionClass}>
                  {schedule.timezone}
                </TableCell>
                <TableCell to={path} className={cellClass} actionClassName={selectedActionClass}>
                  <DateTime date={schedule.nextRun} timeZone={schedule.timezone} />
                </TableCell>
                <TableCell to={path} className={cellClass} actionClassName={selectedActionClass}>
                  {schedule.lastRun ? (
                    <DateTime date={schedule.lastRun} timeZone={schedule.timezone} />
                  ) : (
                    "–"
                  )}
                </TableCell>
                <TableCell to={path} className={cellClass} actionClassName={selectedActionClass}>
                  {schedule.type === "IMPERATIVE"
                    ? schedule.userProvidedDeduplicationKey
                      ? schedule.deduplicationKey
                      : "–"
                    : "N/A"}
                </TableCell>
                <TableCell to={path} className={cellClass} actionClassName={selectedActionClass}>
                  <div className="flex items-center gap-3">
                    {schedule.environments.map((env) => (
                      <EnvironmentCombo key={env.id} environment={env} className="text-xs" />
                    ))}
                  </div>
                </TableCell>
                <TableCell to={path} actionClassName={selectedActionClass}>
                  {schedule.type === "IMPERATIVE" ? (
                    <EnabledStatus enabled={schedule.active} />
                  ) : (
                    "N/A"
                  )}
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

function PurchaseSchedulesModal({
  schedulePricing,
  extraSchedules,
  usedSchedules,
  maxQuota,
  planScheduleLimit,
  triggerButton,
}: {
  schedulePricing: {
    stepSize: number;
    centsPerStep: number;
  };
  extraSchedules: number;
  usedSchedules: number;
  maxQuota: number;
  planScheduleLimit: number;
  triggerButton?: React.ReactNode;
}) {
  const fetcher = useFetcher();
  const lastSubmission =
    fetcher.data && typeof fetcher.data === "object" && "intent" in fetcher.data
      ? fetcher.data
      : undefined;
  const [form, { amount }] = useForm({
    id: "purchase-schedules",
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: PurchaseSchema });
    },
    shouldRevalidate: "onSubmit",
  });

  const stepSize = schedulePricing.stepSize;
  const [bundles, setBundles] = useState(Math.round(extraSchedules / stepSize));
  useEffect(() => {
    setBundles(Math.round(extraSchedules / stepSize));
  }, [extraSchedules, stepSize]);
  const amountValue = bundles * stepSize;
  const isLoading = fetcher.state !== "idle";

  const [open, setOpen] = useState(false);
  useEffect(() => {
    const data = fetcher.data;
    if (
      fetcher.state === "idle" &&
      data !== null &&
      typeof data === "object" &&
      "ok" in data &&
      data.ok
    ) {
      setOpen(false);
    }
  }, [fetcher.state, fetcher.data]);

  const state = updateScheduleState({
    value: amountValue,
    existingValue: extraSchedules,
    quota: maxQuota,
    usedSchedules,
    planScheduleLimit,
  });
  const changeClassName =
    state === "decrease" ? "text-error" : state === "increase" ? "text-success" : undefined;

  const pricePerSchedule = schedulePricing.centsPerStep / stepSize / 100;
  const pricePerStep = schedulePricing.centsPerStep / 100;
  const stepUnit = formatNumber(stepSize);
  const title = extraSchedules === 0 ? "Purchase extra schedules…" : "Add/remove extra schedules…";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {triggerButton ?? (
          <Button variant="primary/small" onClick={() => setOpen(true)}>
            {title}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>{title}</DialogHeader>
        <fetcher.Form method="post" {...form.props}>
          <div className="flex flex-col gap-4 pt-2">
            <div className="flex flex-col gap-1">
              <Paragraph variant="small/bright">
                Schedules are purchased in bundles of {stepUnit}, at{" "}
                {formatCurrency(pricePerStep, false)}/month per bundle. Reducing will take effect at
                the start of the next billing cycle (1st of the month).
              </Paragraph>
            </div>
            <Fieldset>
              <InputGroup fullWidth>
                <Label htmlFor="schedule-bundles" className="text-text-dimmed">
                  Bundles of {stepUnit} schedules
                </Label>
                <InputNumberStepper
                  id="schedule-bundles"
                  step={1}
                  min={0}
                  value={bundles}
                  onChange={(e) => setBundles(Number(e.target.value))}
                  disabled={isLoading}
                />
                <input type="hidden" name="amount" value={amountValue} />
                <Paragraph variant="small" className="text-text-dimmed">
                  {formatNumber(bundles)} {bundles === 1 ? "bundle" : "bundles"} ={" "}
                  {formatNumber(amountValue)} schedules
                </Paragraph>
                <FormError id={amount.errorId}>
                  {amount.error ?? amount.initialError?.[""]?.[0]}
                </FormError>
                <FormError>{form.error}</FormError>
              </InputGroup>
            </Fieldset>
            {state === "need_to_delete" ? (
              <div className="flex flex-col pb-3">
                <Paragraph variant="small" className="text-warning" spacing>
                  You need to delete{" "}
                  {formatNumber(usedSchedules - (planScheduleLimit + amountValue))} more{" "}
                  {usedSchedules - (planScheduleLimit + amountValue) === 1 ? "schedule" : "schedules"}{" "}
                  before you can reduce to this level.
                </Paragraph>
              </div>
            ) : state === "above_quota" ? (
              <div className="flex flex-col pb-3">
                <Paragraph variant="small" className="text-warning" spacing>
                  Currently you can only have up to {formatNumber(maxQuota)} extra schedules. Send a
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
                    <span className="text-text-bright">{formatNumber(extraSchedules)}</span> current
                    extra
                  </Header3>
                  <Header3 className="justify-self-end font-normal text-text-bright">
                    {formatCurrency(extraSchedules * pricePerSchedule, true)}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({formatNumber(extraSchedules)}{" "}
                    {extraSchedules === 1 ? "schedule" : "schedules"})
                  </span>
                  <span className="justify-self-end text-text-dimmed">/mth</span>
                </div>
                <div className="grid grid-cols-2 pt-2">
                  <Header3 className={cn("pb-0 font-normal", changeClassName)}>
                    {state === "increase" ? "+" : null}
                    {formatNumber(amountValue - extraSchedules)}
                  </Header3>
                  <Header3 className={cn("justify-self-end font-normal", changeClassName)}>
                    {state === "increase" ? "+" : null}
                    {formatCurrency((amountValue - extraSchedules) * pricePerSchedule, true)}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({formatNumber(Math.abs(amountValue - extraSchedules))}{" "}
                    {Math.abs(amountValue - extraSchedules) === 1 ? "schedule" : "schedules"} @{" "}
                    {formatCurrency(pricePerStep, false)}/mth per {stepUnit})
                  </span>
                  <span className="justify-self-end text-text-dimmed">/mth</span>
                </div>
                <div className="grid grid-cols-2 pt-2">
                  <Header3 className="pb-0 font-normal text-text-dimmed">
                    <span className="text-text-bright">{formatNumber(amountValue)}</span> new total
                  </Header3>
                  <Header3 className="justify-self-end font-normal text-text-bright">
                    {formatCurrency(amountValue * pricePerSchedule, true)}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({formatNumber(amountValue)} {amountValue === 1 ? "schedule" : "schedules"})
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
                    <span className="tabular-nums text-text-bright">{`Send request for ${formatNumber(
                      amountValue
                    )}`}</span>
                  </Button>
                </>
              ) : state === "decrease" || state === "need_to_delete" ? (
                <>
                  <input type="hidden" name="action" value="purchase" />
                  <Button
                    variant="danger/medium"
                    type="submit"
                    disabled={isLoading || state === "need_to_delete"}
                    LeadingIcon={isLoading ? SpinnerWhite : undefined}
                  >
                    <span className="tabular-nums text-text-bright">{`Remove ${formatNumber(
                      extraSchedules - amountValue
                    )} ${extraSchedules - amountValue === 1 ? "schedule" : "schedules"}`}</span>
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
                    <span className="tabular-nums text-text-bright">{`Purchase ${formatNumber(
                      amountValue - extraSchedules
                    )} ${amountValue - extraSchedules === 1 ? "schedule" : "schedules"}`}</span>
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
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

function updateScheduleState({
  value,
  existingValue,
  quota,
  usedSchedules,
  planScheduleLimit,
}: {
  value: number;
  existingValue: number;
  quota: number;
  usedSchedules: number;
  planScheduleLimit: number;
}): "no_change" | "increase" | "decrease" | "above_quota" | "need_to_delete" {
  if (value === existingValue) return "no_change";
  if (value < existingValue) {
    const newTotalLimit = planScheduleLimit + value;
    if (usedSchedules > newTotalLimit) {
      return "need_to_delete";
    }
    return "decrease";
  }
  if (value > quota) return "above_quota";
  return "increase";
}
