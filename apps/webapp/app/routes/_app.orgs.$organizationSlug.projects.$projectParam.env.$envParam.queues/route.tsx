import {
  AdjustmentsHorizontalIcon,
  ArrowUpCircleIcon,
  BookOpenIcon,
  ChatBubbleLeftEllipsisIcon,
  MagnifyingGlassIcon,
  PauseIcon,
  PlayIcon,
  RectangleStackIcon,
} from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useNavigation, useSearchParams, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import type { QueueItem } from "@trigger.dev/core/v3/schemas";
import { useEffect, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { TaskIconSmall } from "~/assets/icons/TaskIcon";
import upgradeForQueuesPath from "~/assets/images/queues-dashboard.png";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { QueuesHasNoTasks } from "~/components/BlankStatePanels";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { Feedback } from "~/components/Feedback";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BigNumber } from "~/components/metrics/BigNumber";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton, type ButtonVariant } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import {
  InfoIconTooltip,
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { env } from "~/env.server";
import { useAutoRevalidate } from "~/hooks/useAutoRevalidate";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useThrottle } from "~/hooks/useThrottle";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getUserById } from "~/models/user.server";
import { EnvironmentQueuePresenter } from "~/presenters/v3/EnvironmentQueuePresenter.server";
import { QueueListPresenter } from "~/presenters/v3/QueueListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { docsPath, EnvironmentParamSchema, v3BillingPath, v3RunsPath } from "~/utils/pathBuilder";
import { concurrencySystem } from "~/v3/services/concurrencySystemInstance.server";
import { PauseEnvironmentService } from "~/v3/services/pauseEnvironment.server";
import { PauseQueueService } from "~/v3/services/pauseQueue.server";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

const SearchParamsSchema = z.object({
  query: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
});

export const meta: MetaFunction = () => {
  return [
    {
      title: `Queues | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const url = new URL(request.url);
  const { page, query } = SearchParamsSchema.parse(Object.fromEntries(url.searchParams));

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  try {
    const queueListPresenter = new QueueListPresenter();
    const queues = await queueListPresenter.call({
      environment,
      query,
      page,
    });

    const environmentQueuePresenter = new EnvironmentQueuePresenter();

    const autoReloadPollIntervalMs = env.QUEUES_AUTORELOAD_POLL_INTERVAL_MS;

    return typedjson({
      ...queues,
      environment: await environmentQueuePresenter.call(environment),
      autoReloadPollIntervalMs,
    });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  if (request.method.toLowerCase() !== "post") {
    return redirectWithErrorMessage(
      `/orgs/${params.organizationSlug}/projects/${params.projectParam}/env/${params.envParam}/queues`,
      request,
      "Wrong method"
    );
  }

  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  const formData = await request.formData();
  const action = formData.get("action");

  const url = new URL(request.url);
  const { page } = SearchParamsSchema.parse(Object.fromEntries(url.searchParams));

  const redirectPath = `/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/queues?page=${page}`;

  if (environment.archivedAt) {
    return redirectWithErrorMessage(redirectPath, request, "This branch is archived");
  }

  switch (action) {
    case "environment-pause":
      const pauseService = new PauseEnvironmentService();
      await pauseService.call(environment, "paused");
      return redirectWithSuccessMessage(redirectPath, request, "Environment paused");
    case "environment-resume":
      const resumeService = new PauseEnvironmentService();
      await resumeService.call(environment, "resumed");
      return redirectWithSuccessMessage(redirectPath, request, "Environment resumed");
    case "queue-pause":
    case "queue-resume": {
      const friendlyId = formData.get("friendlyId");
      if (!friendlyId) {
        return redirectWithErrorMessage(redirectPath, request, "Queue ID is required");
      }

      const queueService = new PauseQueueService();
      const result = await queueService.call(
        environment,
        friendlyId.toString(),
        action === "queue-pause" ? "paused" : "resumed"
      );

      if (!result.success) {
        return redirectWithErrorMessage(
          redirectPath,
          request,
          result.error ?? `Failed to ${action === "queue-pause" ? "pause" : "resume"} queue`
        );
      }

      return redirectWithSuccessMessage(
        redirectPath,
        request,
        `Queue ${action === "queue-pause" ? "paused" : "resumed"}`
      );
    }
    case "queue-override": {
      const friendlyId = formData.get("friendlyId");
      const concurrencyLimit = formData.get("concurrencyLimit");

      if (!friendlyId) {
        return redirectWithErrorMessage(redirectPath, request, "Queue ID is required");
      }

      if (!concurrencyLimit) {
        return redirectWithErrorMessage(redirectPath, request, "Concurrency limit is required");
      }

      const limitNumber = parseInt(concurrencyLimit.toString(), 10);
      if (isNaN(limitNumber) || limitNumber < 0) {
        return redirectWithErrorMessage(
          redirectPath,
          request,
          "Concurrency limit must be a valid number"
        );
      }

      const user = await getUserById(userId);
      if (!user) {
        return redirectWithErrorMessage(redirectPath, request, "User not found");
      }

      const result = await concurrencySystem.queues.overrideQueueConcurrencyLimit(
        environment,
        friendlyId.toString(),
        limitNumber,
        user
      );

      if (!result.isOk()) {
        return redirectWithErrorMessage(
          redirectPath,
          request,
          "Failed to override queue concurrency limit"
        );
      }

      return redirectWithSuccessMessage(
        redirectPath,
        request,
        "Queue concurrency limit overridden"
      );
    }
    case "queue-remove-override": {
      const friendlyId = formData.get("friendlyId");

      if (!friendlyId) {
        return redirectWithErrorMessage(redirectPath, request, "Queue ID is required");
      }

      const result = await concurrencySystem.queues.resetConcurrencyLimit(
        environment,
        friendlyId.toString()
      );

      if (!result.isOk()) {
        return redirectWithErrorMessage(
          redirectPath,
          request,
          "Failed to reset queue concurrency limit"
        );
      }

      return redirectWithSuccessMessage(redirectPath, request, "Queue concurrency limit reset");
    }
    default:
      return redirectWithErrorMessage(redirectPath, request, "Something went wrong");
  }
};

export default function Page() {
  const {
    environment,
    queues,
    success,
    pagination,
    code,
    totalQueues,
    hasFilters,
    autoReloadPollIntervalMs,
  } = useTypedLoaderData<typeof loader>();

  const organization = useOrganization();
  const project = useProject();
  const env = useEnvironment();
  const plan = useCurrentPlan();

  useAutoRevalidate({ interval: autoReloadPollIntervalMs, onFocus: true });

  const limitStatus =
    environment.running === environment.concurrencyLimit * environment.burstFactor
      ? "limit"
      : environment.running > environment.concurrencyLimit
      ? "burst"
      : "within";

  const limitClassName =
    limitStatus === "burst" ? "text-warning" : limitStatus === "limit" ? "text-error" : undefined;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Queues" />
        <PageAccessories>
          <AdminDebugTooltip />
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/queue-concurrency")}
          >
            Queues docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid max-h-full grid-rows-[auto_1fr] overflow-hidden">
          <div className="grid grid-cols-3 gap-3 p-3">
            <BigNumber
              title="Queued"
              value={environment.queued}
              suffix={env.paused && environment.queued > 0 ? "paused" : undefined}
              animate
              accessory={
                <div className="flex items-start gap-1">
                  {environment.runsEnabled ? <EnvironmentPauseResumeButton env={env} /> : null}
                  <LinkButton
                    variant="secondary/small"
                    LeadingIcon={RunsIcon}
                    leadingIconClassName="text-runs"
                    className="px-2"
                    to={v3RunsPath(organization, project, env, {
                      statuses: ["PENDING"],
                      period: "30d",
                      rootOnly: false,
                    })}
                    tooltip="View queued runs"
                  />
                </div>
              }
              valueClassName={env.paused ? "text-warning" : undefined}
              compactThreshold={1000000}
            />
            <BigNumber
              title="Running"
              value={environment.running}
              animate
              valueClassName={limitClassName}
              suffix={
                limitStatus === "burst" ? (
                  <span className={cn(limitClassName, "flex items-center gap-1")}>
                    Including {environment.running - environment.concurrencyLimit} burst runs{" "}
                    <BurstFactorTooltip environment={environment} />
                  </span>
                ) : limitStatus === "limit" ? (
                  "At concurrency limit"
                ) : undefined
              }
              accessory={
                <LinkButton
                  variant="secondary/small"
                  LeadingIcon={RunsIcon}
                  leadingIconClassName="text-runs"
                  className="px-2"
                  to={v3RunsPath(organization, project, env, {
                    statuses: ["DEQUEUED", "EXECUTING"],
                    period: "30d",
                    rootOnly: false,
                  })}
                  tooltip="View runs"
                />
              }
              compactThreshold={1000000}
            />
            <BigNumber
              title="Concurrency limit"
              value={environment.concurrencyLimit}
              animate
              valueClassName={limitClassName}
              suffix={
                environment.burstFactor > 1 ? (
                  <span className={cn(limitClassName, "flex items-center gap-1")}>
                    Burst limit {environment.burstFactor * environment.concurrencyLimit}{" "}
                    <BurstFactorTooltip environment={environment} />
                  </span>
                ) : undefined
              }
              accessory={
                plan ? (
                  plan?.v3Subscription?.plan?.limits.concurrentRuns.canExceed ? (
                    <Feedback
                      button={
                        <Button
                          variant="tertiary/small"
                          LeadingIcon={ChatBubbleLeftEllipsisIcon}
                          leadingIconClassName="text-indigo-500"
                        >
                          Increase limit…
                        </Button>
                      }
                      defaultValue="concurrency"
                    />
                  ) : (
                    <LinkButton
                      to={v3BillingPath(organization, "Upgrade your plan for more concurrency")}
                      variant="secondary/small"
                      LeadingIcon={ArrowUpCircleIcon}
                      leadingIconClassName="text-indigo-500"
                    >
                      Increase limit
                    </LinkButton>
                  )
                ) : null
              }
            />
          </div>

          {success ? (
            <div
              className={cn(
                "grid max-h-full min-h-full grid-rows-[auto_1fr] overflow-x-auto",
                pagination.totalPages > 1 && "grid-rows-[auto_1fr_auto]"
              )}
            >
              <div className="flex items-center gap-2 border-t border-grid-dimmed px-1.5 py-1.5">
                <QueueFilters />
                <PaginationControls
                  currentPage={pagination.currentPage}
                  totalPages={pagination.totalPages}
                  showPageNumbers={false}
                />
              </div>
              <Table containerClassName="border-t">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell alignment="right">Queued</TableHeaderCell>
                    <TableHeaderCell alignment="right">Running</TableHeaderCell>
                    <TableHeaderCell alignment="right">Limit</TableHeaderCell>
                    <TableHeaderCell
                      alignment="right"
                      tooltip={
                        <div className="max-w-xs space-y-2 p-1 text-left">
                          <div className="space-y-0.5">
                            <Header3>Environment</Header3>
                            <Paragraph
                              variant="small"
                              className="!text-wrap text-text-dimmed"
                              spacing
                            >
                              This queue is limited by your environment's concurrency limit of{" "}
                              {environment.concurrencyLimit}.
                            </Paragraph>
                          </div>
                          <div className="space-y-0.5">
                            <Header3>User</Header3>
                            <Paragraph
                              variant="small"
                              className="!text-wrap text-text-dimmed"
                              spacing
                            >
                              This queue is limited by a concurrency limit set in your code.
                            </Paragraph>
                          </div>
                          <div className="space-y-0.5">
                            <Header3>Override</Header3>
                            <Paragraph
                              variant="small"
                              className="!text-wrap text-text-dimmed"
                              spacing
                            >
                              This queue's concurrency limit has been manually overridden from the
                              dashboard or API.
                            </Paragraph>
                          </div>
                        </div>
                      }
                    >
                      Limited by
                    </TableHeaderCell>
                    <TableHeaderCell className="w-[1%] pl-24">
                      <span className="sr-only">Pause/resume</span>
                    </TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queues.length > 0 ? (
                    queues.map((queue) => {
                      const limit = queue.concurrencyLimit ?? environment.concurrencyLimit;
                      const isAtLimit = queue.running >= limit;
                      const queueFilterableName = `${queue.type === "task" ? "task/" : ""}${
                        queue.name
                      }`;
                      return (
                        <TableRow key={queue.name}>
                          <TableCell>
                            <span className="flex items-center gap-2">
                              {queue.type === "task" ? (
                                <SimpleTooltip
                                  button={
                                    <TaskIconSmall
                                      className={cn(
                                        "size-[1.125rem] text-blue-500",
                                        queue.paused && "opacity-50"
                                      )}
                                    />
                                  }
                                  content={`This queue was automatically created from your "${queue.name}" task`}
                                />
                              ) : (
                                <SimpleTooltip
                                  button={
                                    <RectangleStackIcon
                                      className={cn(
                                        "size-[1.125rem] text-purple-500",
                                        queue.paused && "opacity-50"
                                      )}
                                    />
                                  }
                                  content={`This is a custom queue you added in your code.`}
                                />
                              )}
                              <span className={queue.paused ? "opacity-50" : undefined}>
                                {queue.name}
                              </span>
                              {queue.concurrency?.overriddenAt ? (
                                <SimpleTooltip
                                  button={
                                    <Badge variant="extra-small" className="text-text-bright">
                                      Concurrency limit overridden
                                    </Badge>
                                  }
                                  content="This queue's concurrency limit has been manually overridden from the dashboard or API."
                                  className="max-w-xs"
                                  disableHoverableContent
                                />
                              ) : null}
                              {queue.paused ? (
                                <Badge variant="extra-small" className="text-warning">
                                  Paused
                                </Badge>
                              ) : null}
                              {isAtLimit ? (
                                <Badge variant="extra-small" className="text-warning">
                                  At concurrency limit
                                </Badge>
                              ) : null}
                            </span>
                          </TableCell>
                          <TableCell
                            alignment="right"
                            className={cn(
                              "w-[1%] tabular-nums",
                              queue.paused ? "opacity-50" : undefined
                            )}
                          >
                            {queue.queued}
                          </TableCell>
                          <TableCell
                            alignment="right"
                            className={cn(
                              "w-[1%] tabular-nums",
                              queue.paused ? "opacity-50" : undefined,
                              queue.running > 0 && "text-text-bright",
                              isAtLimit && "text-warning"
                            )}
                          >
                            {queue.running}
                          </TableCell>
                          <TableCell
                            alignment="right"
                            className={cn(
                              "w-[1%] tabular-nums",
                              queue.paused ? "opacity-50" : undefined,
                              queue.concurrency?.overriddenAt && "font-medium text-text-bright"
                            )}
                          >
                            {limit}
                          </TableCell>
                          <TableCell
                            alignment="right"
                            className={cn(
                              "w-[1%]",
                              queue.paused ? "opacity-50" : undefined,
                              isAtLimit && "text-warning",
                              queue.concurrency?.overriddenAt && "font-medium text-text-bright"
                            )}
                          >
                            {queue.concurrency?.overriddenAt ? (
                              <span className="text-text-bright">Override</span>
                            ) : queue.concurrencyLimit ? (
                              "User"
                            ) : (
                              "Environment"
                            )}
                          </TableCell>
                          <TableCellMenu
                            isSticky
                            visibleButtons={
                              queue.paused && <QueuePauseResumeButton queue={queue} />
                            }
                            hiddenButtons={
                              !queue.paused && <QueuePauseResumeButton queue={queue} />
                            }
                            popoverContent={
                              <>
                                {queue.paused ? (
                                  <QueuePauseResumeButton
                                    queue={queue}
                                    variant="minimal/small"
                                    fullWidth
                                    showTooltip={false}
                                  />
                                ) : (
                                  <QueuePauseResumeButton
                                    queue={queue}
                                    variant="minimal/small"
                                    fullWidth
                                    showTooltip={false}
                                  />
                                )}

                                <PopoverMenuItem
                                  icon={RunsIcon}
                                  leadingIconClassName="text-runs"
                                  title="View all runs"
                                  to={v3RunsPath(organization, project, env, {
                                    queues: [queueFilterableName],
                                    period: "30d",
                                    rootOnly: false,
                                  })}
                                />
                                <PopoverMenuItem
                                  icon={RectangleStackIcon}
                                  leadingIconClassName="text-queues"
                                  title="View queued runs"
                                  to={v3RunsPath(organization, project, env, {
                                    queues: [queueFilterableName],
                                    statuses: ["PENDING"],
                                    period: "30d",
                                    rootOnly: false,
                                  })}
                                />
                                <PopoverMenuItem
                                  icon={Spinner}
                                  leadingIconClassName="text-queues animate-none"
                                  title="View running runs"
                                  to={v3RunsPath(organization, project, env, {
                                    queues: [queueFilterableName],
                                    statuses: ["DEQUEUED", "EXECUTING"],
                                    period: "30d",
                                    rootOnly: false,
                                  })}
                                />
                                <QueueOverrideConcurrencyButton
                                  queue={queue}
                                  environmentConcurrencyLimit={environment.concurrencyLimit}
                                />
                              </>
                            }
                          />
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell colSpan={7}>
                        <div className="grid place-items-center py-6 text-text-dimmed">
                          <Paragraph>
                            {hasFilters
                              ? "No queues found matching your filters"
                              : "No queues found"}
                          </Paragraph>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>

              {pagination.totalPages > 1 && (
                <div
                  className={cn(
                    "grid h-fit max-h-full min-h-full overflow-x-auto",
                    pagination.totalPages > 1 ? "grid-rows-[1fr_auto]" : "grid-rows-[1fr]"
                  )}
                >
                  <div
                    className={cn(
                      "flex min-h-full",
                      pagination.totalPages > 1 &&
                        "justify-end border-t border-grid-dimmed px-2 py-3"
                    )}
                  >
                    <PaginationControls
                      currentPage={pagination.currentPage}
                      totalPages={pagination.totalPages}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="grid place-items-center py-6 text-text-dimmed">
              {totalQueues === 0 ? (
                <div className="pt-12">
                  <QueuesHasNoTasks />
                </div>
              ) : code === "engine-version" ? (
                <EngineVersionUpgradeCallout />
              ) : (
                <Callout variant="error">Something went wrong</Callout>
              )}
            </div>
          )}
        </div>
      </PageBody>
    </PageContainer>
  );
}

function EnvironmentPauseResumeButton({
  env,
}: {
  env: { type: RuntimeEnvironmentType; paused: boolean };
}) {
  const navigation = useNavigation();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (navigation.state === "loading" || navigation.state === "idle") {
      setIsOpen(false);
    }
  }, [navigation.state]);

  const isLoading = Boolean(
    navigation.formData?.get("action") === (env.paused ? "environment-resume" : "environment-pause")
  );

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <div>
        <TooltipProvider disableHoverableContent={true}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <DialogTrigger asChild>
                  <Button
                    type="button"
                    variant="secondary/small"
                    LeadingIcon={env.paused ? PlayIcon : PauseIcon}
                    leadingIconClassName={env.paused ? "text-success" : "text-warning"}
                  >
                    {env.paused ? "Resume..." : "Pause environment..."}
                  </Button>
                </DialogTrigger>
              </div>
            </TooltipTrigger>
            <TooltipContent className={"text-xs"}>
              {env.paused
                ? `Resume processing runs in ${environmentFullTitle(env)}`
                : `Pause processing runs in ${environmentFullTitle(env)}`}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <DialogContent>
        <DialogHeader>{env.paused ? "Resume environment?" : "Pause environment?"}</DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          <Paragraph>
            {env.paused
              ? `This will allow runs to be dequeued in ${environmentFullTitle(env)} again.`
              : `This will pause all runs from being dequeued in ${environmentFullTitle(
                  env
                )}. Any executing runs will continue to run.`}
          </Paragraph>
          <Form method="post" onSubmit={() => setIsOpen(false)}>
            <input
              type="hidden"
              name="action"
              value={env.paused ? "environment-resume" : "environment-pause"}
            />
            <FormButtons
              confirmButton={
                <Button
                  type="submit"
                  disabled={isLoading}
                  variant={env.paused ? "primary/medium" : "danger/medium"}
                  LeadingIcon={
                    isLoading ? <Spinner color="white" /> : env.paused ? PlayIcon : PauseIcon
                  }
                  shortcut={{ modifiers: ["mod"], key: "enter" }}
                >
                  {env.paused ? "Resume environment" : "Pause environment"}
                </Button>
              }
              cancelButton={
                <DialogClose asChild>
                  <Button type="button" variant="tertiary/medium">
                    Cancel
                  </Button>
                </DialogClose>
              }
            />
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function QueuePauseResumeButton({
  queue,
  variant = "tertiary/small",
  fullWidth = false,
  showTooltip = true,
}: {
  /** The "id" here is a friendlyId */
  queue: { id: string; name: string; paused: boolean };
  variant?: ButtonVariant;
  fullWidth?: boolean;
  showTooltip?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const trigger = showTooltip ? (
    <div>
      <TooltipProvider disableHoverableContent={true}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <DialogTrigger asChild>
                <Button
                  type="button"
                  variant={variant}
                  LeadingIcon={queue.paused ? PlayIcon : PauseIcon}
                  leadingIconClassName={queue.paused ? "text-success" : "text-warning"}
                  fullWidth={fullWidth}
                  textAlignLeft={fullWidth}
                >
                  {queue.paused ? "Resume..." : "Pause..."}
                </Button>
              </DialogTrigger>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" className={"text-xs"}>
            {queue.paused
              ? `Resume processing runs in queue "${queue.name}"`
              : `Pause processing runs in queue "${queue.name}"`}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  ) : (
    <DialogTrigger asChild>
      <PopoverMenuItem
        icon={queue.paused ? PlayIcon : PauseIcon}
        leadingIconClassName={queue.paused ? "text-success" : "text-warning"}
        title={queue.paused ? "Resume..." : "Pause..."}
      />
    </DialogTrigger>
  );

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {trigger}
      <DialogContent>
        <DialogHeader>{queue.paused ? "Resume queue?" : "Pause queue?"}</DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          <Paragraph>
            {queue.paused
              ? `This will allow runs to be dequeued in the "${queue.name}" queue again.`
              : `This will pause all runs from being dequeued in the "${queue.name}" queue. Any executing runs will continue to run.`}
          </Paragraph>
          <Form method="post" onSubmit={() => setIsOpen(false)}>
            <input
              type="hidden"
              name="action"
              value={queue.paused ? "queue-resume" : "queue-pause"}
            />
            <input type="hidden" name="friendlyId" value={queue.id} />
            <FormButtons
              confirmButton={
                <Button
                  type="submit"
                  shortcut={{ modifiers: ["mod"], key: "enter" }}
                  variant={queue.paused ? "primary/medium" : "danger/medium"}
                  LeadingIcon={queue.paused ? PlayIcon : PauseIcon}
                >
                  {queue.paused ? "Resume queue" : "Pause queue"}
                </Button>
              }
              cancelButton={
                <DialogClose asChild>
                  <Button type="button" variant="tertiary/medium">
                    Cancel
                  </Button>
                </DialogClose>
              }
            />
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function QueueOverrideConcurrencyButton({
  queue,
  environmentConcurrencyLimit,
}: {
  queue: QueueItem;
  environmentConcurrencyLimit: number;
}) {
  const navigation = useNavigation();
  const [isOpen, setIsOpen] = useState(false);
  const [concurrencyLimit, setConcurrencyLimit] = useState<string>(
    queue.concurrencyLimit?.toString() ?? environmentConcurrencyLimit.toString()
  );

  const isOverridden = !!queue.concurrency?.overriddenAt;
  const currentLimit = queue.concurrencyLimit ?? environmentConcurrencyLimit;

  useEffect(() => {
    if (navigation.state === "loading" || navigation.state === "idle") {
      setIsOpen(false);
    }
  }, [navigation.state]);

  const isLoading = Boolean(
    navigation.formData?.get("action") === "queue-override" ||
      navigation.formData?.get("action") === "queue-remove-override"
  );

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <PopoverMenuItem
          icon={AdjustmentsHorizontalIcon}
          title={isOverridden ? "Edit override…" : "Override limit…"}
        />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          {isOverridden ? "Edit concurrency override" : "Override concurrency limit"}
        </DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          {isOverridden ? (
            <Paragraph>
              This queue's concurrency limit is currently overridden to {currentLimit}.
              {typeof queue.concurrency?.base === "number" &&
                ` The original limit set in code was ${queue.concurrency.base}.`}{" "}
              You can update the override or remove it to restore the{" "}
              {typeof queue.concurrency?.base === "number"
                ? "limit set in code"
                : "environment concurrency limit"}
              .
            </Paragraph>
          ) : (
            <Paragraph>
              Override this queue's concurrency limit. The current limit is {currentLimit}, which is
              set {queue.concurrencyLimit !== null ? "in code" : "by the environment"}.
            </Paragraph>
          )}
          <Form method="post" onSubmit={() => setIsOpen(false)} className="space-y-3">
            <input type="hidden" name="friendlyId" value={queue.id} />
            <div className="space-y-2">
              <label htmlFor="concurrencyLimit" className="text-sm text-text-bright">
                Concurrency limit
              </label>
              <Input
                type="number"
                name="concurrencyLimit"
                id="concurrencyLimit"
                min="0"
                max={environmentConcurrencyLimit}
                value={concurrencyLimit}
                onChange={(e) => setConcurrencyLimit(e.target.value)}
                placeholder={currentLimit.toString()}
                autoFocus
              />
            </div>

            <FormButtons
              confirmButton={
                <Button
                  type="submit"
                  name="action"
                  value="queue-override"
                  disabled={isLoading || !concurrencyLimit}
                  variant="primary/medium"
                  LeadingIcon={isLoading && <Spinner color="white" />}
                  shortcut={{ modifiers: ["mod"], key: "enter" }}
                >
                  {isOverridden ? "Update override" : "Override limit"}
                </Button>
              }
              cancelButton={
                <div className="flex items-center justify-between gap-2">
                  {isOverridden && (
                    <Button
                      type="submit"
                      name="action"
                      value="queue-remove-override"
                      disabled={isLoading}
                      variant="danger/medium"
                    >
                      Remove override
                    </Button>
                  )}
                  <DialogClose asChild>
                    <Button type="button" variant="tertiary/medium">
                      Cancel
                    </Button>
                  </DialogClose>
                </div>
              }
            />
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EngineVersionUpgradeCallout() {
  return (
    <div className="mt-4 flex max-w-lg flex-col gap-4 rounded-sm border border-grid-bright bg-background-bright px-4">
      <div className="flex items-center justify-between gap-2 border-b border-grid-dimmed py-4">
        <h4 className="text-base text-text-bright">New queues table</h4>
        <LinkButton
          LeadingIcon={BookOpenIcon}
          to={docsPath("upgrade-to-v4")}
          variant={"docs/small"}
        >
          Upgrade guide
        </LinkButton>
      </div>
      <div className="space-y-4 pb-4">
        <Paragraph variant="small">
          Upgrade to SDK version 4+ to view the new queues table, and be able to pause and resume
          individual queues.
        </Paragraph>
        <img
          src={upgradeForQueuesPath}
          alt="Upgrade for queues"
          className="rounded-sm border border-grid-dimmed"
        />
      </div>
    </div>
  );
}

export function isEnvironmentPauseResumeFormSubmission(
  formMethod: string | undefined,
  formData: FormData | undefined
) {
  if (!formMethod || !formData) {
    return false;
  }

  return (
    formMethod.toLowerCase() === "post" &&
    (formData.get("action") === "environment-pause" ||
      formData.get("action") === "environment-resume")
  );
}

export function QueueFilters() {
  const [searchParams, setSearchParams] = useSearchParams();

  const handleSearchChange = useThrottle((value: string) => {
    if (value) {
      setSearchParams((prev) => {
        prev.set("query", value);
        prev.delete("page");
        return prev;
      });
    } else {
      setSearchParams((prev) => {
        prev.delete("query");
        prev.delete("page");
        return prev;
      });
    }
  }, 300);

  const search = searchParams.get("query") ?? "";

  return (
    <div className="flex grow">
      <Input
        name="search"
        placeholder="Search queue name"
        icon={MagnifyingGlassIcon}
        variant="tertiary"
        className="grow"
        defaultValue={search}
        onChange={(e) => handleSearchChange(e.target.value)}
      />
    </div>
  );
}

function BurstFactorTooltip({
  environment,
}: {
  environment: { burstFactor: number; concurrencyLimit: number };
}) {
  return (
    <InfoIconTooltip
      content={`Your single queue concurrency limit is capped at ${
        environment.concurrencyLimit
      }, but you can burst up to ${
        environment.burstFactor * environment.concurrencyLimit
      } when across multiple queues/tasks.`}
      contentClassName="max-w-xs"
    />
  );
}
