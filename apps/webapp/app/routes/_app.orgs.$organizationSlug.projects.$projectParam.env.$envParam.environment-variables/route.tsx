import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import {
  BookOpenIcon,
  InformationCircleIcon,
  LockClosedIcon,
  NoSymbolIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import {
  Form,
  type MetaFunction,
  Outlet,
  useActionData,
  useFetcher,
  useNavigation,
  useRevalidator,
} from "@remix-run/react";
import { json } from "@remix-run/server-runtime";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { VercelLogo } from "~/components/integrations/VercelLogo";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { SearchInput } from "~/components/primitives/SearchInput";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Switch } from "~/components/primitives/Switch";
import {
  Table,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { prisma } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useFuzzyFilter } from "~/hooks/useFuzzyFilter";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import {
  type EnvironmentVariableWithSetValues,
  EnvironmentVariablesPresenter,
} from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import { type EnvironmentVariablesEnvironment } from "~/presenters/v3/environmentVariablesEnvironments.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { cn } from "~/utils/cn";
import {
  EnvironmentParamSchema,
  docsPath,
  v3EnvironmentVariablesPath,
  v3NewEnvironmentVariablesPath,
} from "~/utils/pathBuilder";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  DeleteEnvironmentVariableValue,
  EditEnvironmentVariableValue,
  EnvironmentVariable,
} from "~/v3/environmentVariables/repository";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { VercelIntegrationService } from "~/services/vercelIntegration.server";
import { fromPromise } from "neverthrow";
import { logger } from "~/services/logger.server";
import {
  shouldSyncEnvVar,
  isPullEnvVarsEnabledForEnvironment,
  type TriggerEnvironmentType,
} from "~/v3/vercel/vercelProjectIntegrationSchema";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Environment variables | Trigger.dev`,
    },
  ];
};

type PageVercelIntegration = NonNullable<
  Awaited<ReturnType<EnvironmentVariablesPresenter["call"]>>["vercelIntegration"]
>;

// A value the current role can't read for its environment tier is masked
// server-side: the value is withheld and the cell renders "Permission denied".
export type MaskedEnvironmentVariable = EnvironmentVariableWithSetValues & {
  permissionDenied?: boolean;
};

export type EnvironmentVariablesPageLoaderData = {
  environmentVariables: MaskedEnvironmentVariable[];
  environments: EnvironmentVariablesEnvironment[];
  hasStaging: boolean;
  vercelIntegration: PageVercelIntegration | null;
  // Environment ids whose env vars the current role can read.
  accessibleEnvironmentIds: string[];
};

export const environmentVariablesRouteId =
  "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables";

async function resolveOrgIdFromSlug(slug: string): Promise<string | null> {
  const org = await prisma.organization.findFirst({ where: { slug }, select: { id: true } });
  return org?.id ?? null;
}

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    // No hard authorization: the page lists every environment. Values in
    // environments the role can't read are masked per-tier below.
  },
  async ({ params, user, ability }) => {
    const { projectParam } = params;

    try {
      const presenter = new EnvironmentVariablesPresenter();
      const { environmentVariables, environments, hasStaging, vercelIntegration } =
        await presenter.call({
          userId: user.id,
          projectSlug: projectParam,
        });

      const accessibleEnvironmentIds = environments
        .filter((env) => ability.can("read", { type: "envvars", envType: env.type }))
        .map((env) => env.id);
      const accessible = new Set(accessibleEnvironmentIds);

      // Withhold values (and the "who/when" metadata) for environments the
      // role can't read — never serialize them to the client.
      const masked: MaskedEnvironmentVariable[] = environmentVariables.map((variable) =>
        accessible.has(variable.environment.id)
          ? variable
          : {
              ...variable,
              value: "",
              isSecret: false,
              permissionDenied: true,
              lastUpdatedBy: null,
              updatedByUser: null,
            }
      );

      return typedjson({
        environmentVariables: masked,
        environments,
        hasStaging,
        vercelIntegration,
        accessibleEnvironmentIds,
      });
    } catch (error) {
      console.error(error);
      throw new Response(undefined, {
        status: 400,
        statusText: "Something went wrong, if this problem persists please contact support.",
      });
    }
  }
);

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit"), ...EditEnvironmentVariableValue.shape }),
  z.object({
    action: z.literal("delete"),
    key: z.string(),
    ...DeleteEnvironmentVariableValue.shape,
  }),
  z.object({
    action: z.literal("update-vercel-sync"),
    key: z.string(),
    environmentType: z.enum(["PRODUCTION", "STAGING", "PREVIEW", "DEVELOPMENT"]),
    syncEnabled: z
      .union([z.literal("true"), z.literal("false")])
      .transform((val) => val === "true"),
  }),
]);

export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    // Per-environment write:envvars is enforced in the handler — the target
    // environment tier comes from the submission, not the route params.
  },
  async ({ request, params, user, ability }) => {
    const userId = user.id;
    const { organizationSlug, projectParam, envParam } = params;

    if (request.method.toUpperCase() !== "POST") {
      throw new Response("Method Not Allowed", { status: 405 });
    }

    const formData = await request.formData();
    const submission = parse(formData, { schema });

    if (!submission.value) {
      return json(submission);
    }

    // Enforce env-tier write:envvars on the targeted environment, so a role
    // that can't write a deployed tier can't mutate it via a direct POST.
    const targetEnvType =
      submission.value.action === "update-vercel-sync"
        ? submission.value.environmentType
        : (
            await prisma.runtimeEnvironment.findFirst({
              where: { id: submission.value.environmentId },
              select: { type: true },
            })
          )?.type;
    if (targetEnvType && !ability.can("write", { type: "envvars", envType: targetEnvType })) {
      submission.error.key = [
        "You don't have permission to manage environment variables in this environment.",
      ];
      return json(submission);
    }

    const project = await prisma.project.findUnique({
      where: {
        slug: params.projectParam,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
      select: {
        id: true,
      },
    });
    if (!project) {
      submission.error.key = ["Project not found"];
      return json(submission);
    }

    switch (submission.value.action) {
      case "edit": {
        const repository = new EnvironmentVariablesRepository(prisma);
        const result = await repository.editValue(project.id, {
          ...submission.value,
          lastUpdatedBy: {
            type: "user",
            userId,
          },
        });

        if (!result.success) {
          submission.error.key = [result.error];
          return json(submission);
        }

        return json({ ...submission, success: true });
      }
      case "delete": {
        const repository = new EnvironmentVariablesRepository(prisma);
        const result = await repository.deleteValue(project.id, submission.value);

        if (!result.success) {
          submission.error.key = [result.error];
          return json(submission);
        }

        // Clean up syncEnvVarsMapping if Vercel integration exists (best-effort)
        const { environmentId, key } = submission.value;
        const vercelService = new VercelIntegrationService();
        await fromPromise(
          (async () => {
            const integration = await vercelService.getVercelProjectIntegration(project.id);
            if (integration) {
              const runtimeEnv = await prisma.runtimeEnvironment.findUnique({
                where: { id: environmentId },
                select: { type: true },
              });
              if (runtimeEnv) {
                await vercelService.removeSyncEnvVarForEnvironment(
                  project.id,
                  key,
                  runtimeEnv.type as TriggerEnvironmentType
                );
              }
            }
          })(),
          (error) => error
        ).mapErr((error) => {
          logger.error("Failed to remove Vercel sync mapping", { error });
          return error;
        });

        return redirectWithSuccessMessage(
          v3EnvironmentVariablesPath(
            { slug: organizationSlug },
            { slug: projectParam },
            { slug: envParam }
          ),
          request,
          `Deleted ${submission.value.key} environment variable`
        );
      }
      case "update-vercel-sync": {
        const vercelService = new VercelIntegrationService();
        const integration = await vercelService.getVercelProjectIntegration(project.id);

        if (!integration) {
          submission.error.key = ["Vercel integration not found"];
          return json(submission);
        }

        // Update the sync mapping for the specific env var and environment
        await vercelService.updateSyncEnvVarForEnvironment(
          project.id,
          submission.value.key,
          submission.value.environmentType,
          submission.value.syncEnabled
        );

        return json({ success: true });
      }
    }
  }
);

const SSR_ROW_WINDOW = 50;
const ROW_ESTIMATE_HEIGHT = 44;
const VIRTUAL_OVERSCAN = 10;

type GroupedEnvironmentVariable = MaskedEnvironmentVariable & {
  isFirstTime: boolean;
  isLastTime: boolean;
  occurences: number;
};

export default function Page() {
  const loaderData = useTypedLoaderData<EnvironmentVariablesPageLoaderData>();

  return <EnvironmentVariablesListPage loaderData={loaderData} />;
}

function EnvironmentVariablesListPage({
  loaderData,
}: {
  loaderData: EnvironmentVariablesPageLoaderData;
}) {
  const [revealAll, setRevealAll] = useState(false);
  const { environmentVariables, vercelIntegration } = loaderData;
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { value } = useSearchParams();
  const urlSearch = value("search") ?? "";
  const { filteredItems } = useFuzzyFilter<EnvironmentVariableWithSetValues>({
    items: environmentVariables,
    keys: ["key", "value", "environment.type", "environment.branchName"],
    filterText: urlSearch,
  });

  const tableScrollRef = useRef<HTMLDivElement>(null);

  // Add isFirst and isLast to each environment variable
  // They're set based on if they're the first or last time that `key` has been seen in the list
  const groupedEnvironmentVariables = useMemo((): GroupedEnvironmentVariable[] => {
    // Create a map to track occurrences of each key
    const keyOccurrences = new Map<string, number>();

    // First pass: count total occurrences of each key
    filteredItems.forEach((variable) => {
      keyOccurrences.set(variable.key, (keyOccurrences.get(variable.key) || 0) + 1);
    });

    // Second pass: add isFirstTime, isLastTime, and occurrences flags
    const seenKeys = new Set<string>();
    const currentOccurrences = new Map<string, number>();

    return filteredItems.map((variable) => {
      // Track current occurrence number for this key
      const currentCount = (currentOccurrences.get(variable.key) || 0) + 1;
      currentOccurrences.set(variable.key, currentCount);

      const totalOccurrences = keyOccurrences.get(variable.key) || 1;
      const isFirstTime = !seenKeys.has(variable.key);
      const isLastTime = currentCount === totalOccurrences;

      if (isFirstTime) {
        seenKeys.add(variable.key);
      }

      return {
        ...variable,
        isFirstTime,
        isLastTime,
        occurences: totalOccurrences,
      };
    });
  }, [filteredItems]);

  const shouldVirtualize = groupedEnvironmentVariables.length > SSR_ROW_WINDOW;
  const [isVirtualized, setIsVirtualized] = useState(false);

  useLayoutEffect(() => {
    setIsVirtualized(shouldVirtualize);
  }, [shouldVirtualize]);

  const staticRows = useMemo(() => {
    if (shouldVirtualize) {
      return groupedEnvironmentVariables.slice(0, SSR_ROW_WINDOW);
    }
    return groupedEnvironmentVariables;
  }, [groupedEnvironmentVariables, shouldVirtualize]);

  const vercelColumnCount = vercelIntegration?.enabled ? 6 : 5;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Environment variables" />
        <PageAccessories>
          <LinkButton
            LeadingIcon={BookOpenIcon}
            to={docsPath("v3/deploy-environment-variables")}
            variant="docs/small"
          >
            Environment variables docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className={cn("flex h-full min-h-0 flex-col")}>
          {environmentVariables.length > 0 && (
            <div className="flex items-center justify-between gap-2 px-2 py-2">
              <SearchInput placeholder="Search variables…" autoFocus />
              <div className="flex items-center justify-end gap-1.5">
                <Switch
                  variant="secondary/small"
                  label="Reveal values"
                  checked={revealAll}
                  onCheckedChange={(e) => setRevealAll(e.valueOf())}
                />
                <LinkButton
                  to={v3NewEnvironmentVariablesPath(organization, project, environment)}
                  variant="primary/small"
                  LeadingIcon={PlusIcon}
                  shortcut={{ key: "n" }}
                >
                  Add new
                </LinkButton>
              </div>
            </div>
          )}
          <div
            ref={tableScrollRef}
            className="min-h-0 flex-1 overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
          >
            <Table
              containerClassName={cn(
                filteredItems.length === 0 && "border-t-0",
                "overflow-visible"
              )}
            >
              <TableHeader>
                <TableRow>
                  <TableHeaderCell className={vercelIntegration?.enabled ? "w-[22%]" : "w-[25%]"}>
                    Key
                  </TableHeaderCell>
                  <TableHeaderCell className={vercelIntegration?.enabled ? "w-[32%]" : "w-[37%]"}>
                    Value
                  </TableHeaderCell>
                  <TableHeaderCell className={vercelIntegration?.enabled ? "w-[13%]" : "w-[15%]"}>
                    <SimpleTooltip
                      button={
                        <span className="flex items-center gap-1">
                          Environment
                          <InformationCircleIcon className="size-4 text-text-dimmed" />
                        </span>
                      }
                      content="Dev environment variables specified here will be overridden by ones in your .env file when running locally."
                      className="max-w-60"
                    />
                  </TableHeaderCell>
                  {vercelIntegration?.enabled && (
                    <TableHeaderCell className="w-[8%]">
                      <SimpleTooltip
                        button={
                          <span className="flex items-center gap-1">
                            Sync
                            <InformationCircleIcon className="size-4 text-text-dimmed" />
                          </span>
                        }
                        content="When enabled, this variable will be pulled from Vercel during builds. Requires 'Pull env vars before build' to be enabled in settings."
                      />
                    </TableHeaderCell>
                  )}
                  <TableHeaderCell className={vercelIntegration?.enabled ? "w-[24%]" : "w-[22%]"}>
                    Updated
                  </TableHeaderCell>
                  <TableHeaderCell hiddenLabel className="w-0">
                    Actions
                  </TableHeaderCell>
                </TableRow>
              </TableHeader>
              {groupedEnvironmentVariables.length > 0 ? (
                isVirtualized && shouldVirtualize ? (
                  <EnvironmentVariablesVirtualTableBody
                    groupedEnvironmentVariables={groupedEnvironmentVariables}
                    scrollRef={tableScrollRef}
                    revealAll={revealAll}
                    vercelIntegration={vercelIntegration}
                    columnCount={vercelColumnCount}
                  />
                ) : (
                  <TableBody>
                    {staticRows.map((variable) => (
                      <EnvironmentVariableTableRow
                        key={`${variable.id}-${variable.environment.id}`}
                        variable={variable}
                        revealAll={revealAll}
                        vercelIntegration={vercelIntegration}
                      />
                    ))}
                  </TableBody>
                )
              ) : (
                <TableBody>
                  <TableRow>
                    <TableCell colSpan={vercelColumnCount}>
                      {environmentVariables.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-y-4 py-8">
                          <Header2>You haven't set any environment variables yet.</Header2>
                          <LinkButton
                            to={v3NewEnvironmentVariablesPath(organization, project, environment)}
                            variant="primary/medium"
                            LeadingIcon={PlusIcon}
                            shortcut={{ key: "n" }}
                          >
                            Add new
                          </LinkButton>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center gap-y-4 py-8">
                          <Paragraph>No variables match your search.</Paragraph>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                </TableBody>
              )}
            </Table>
          </div>
        </div>
      </PageBody>
      <Outlet />
    </PageContainer>
  );
}

function getBorderedCellClassName(variable: GroupedEnvironmentVariable) {
  if (variable.occurences <= 1) {
    return "";
  }

  if (variable.isLastTime) {
    return "";
  }

  return "relative after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-grid-bright group-hover/table-row:after:bg-grid-bright group-hover/table-row:before:bg-grid-bright";
}

function EnvironmentVariableTableRow({
  variable,
  revealAll,
  vercelIntegration,
}: {
  variable: GroupedEnvironmentVariable;
  revealAll: boolean;
  vercelIntegration: PageVercelIntegration | null;
}) {
  const cellClassName = "py-2";
  const borderedCellClassName = getBorderedCellClassName(variable);

  return (
    <TableRow className={variable.isLastTime ? "after:bg-charcoal-600" : "after:bg-transparent"}>
      <TableCell className={cellClassName}>
        {variable.isFirstTime ? <CopyableText value={variable.key} className="font-mono" /> : null}
      </TableCell>
      <TableCell className={cn(cellClassName, borderedCellClassName, "after:left-3")}>
        {variable.permissionDenied ? (
          <SimpleTooltip
            button={
              <div className="flex items-center gap-x-1">
                <NoSymbolIcon className="size-3 text-text-dimmed" />
                <span className="text-xs text-text-dimmed">Permission denied</span>
              </div>
            }
            content="With your current role, you can't view this environment's variables."
          />
        ) : variable.isSecret ? (
          <SimpleTooltip
            button={
              <div className="flex items-center gap-x-1">
                <LockClosedIcon className="size-3 text-text-dimmed" />
                <span className="text-xs text-text-dimmed">Secret</span>
              </div>
            }
            content="This variable is secret and cannot be revealed."
          />
        ) : (
          <ClipboardField
            secure={!revealAll}
            value={variable.value}
            variant={"secondary/small"}
            fullWidth={true}
          />
        )}
      </TableCell>

      <TableCell className={cn(cellClassName, borderedCellClassName)}>
        <EnvironmentCombo environment={variable.environment} className="text-sm" />
      </TableCell>
      {vercelIntegration?.enabled && (
        <TableCell className={cn(cellClassName, borderedCellClassName)}>
          {variable.environment.type !== "DEVELOPMENT" && (
            <VercelSyncCheckbox
              envVarKey={variable.key}
              environmentType={variable.environment.type as TriggerEnvironmentType}
              syncEnabled={shouldSyncEnvVar(
                vercelIntegration.syncEnvVarsMapping,
                variable.key,
                variable.environment.type as TriggerEnvironmentType
              )}
              pullEnvVarsEnabledForEnv={isPullEnvVarsEnabledForEnvironment(
                vercelIntegration.pullEnvVarsBeforeBuild,
                variable.environment.type as TriggerEnvironmentType
              )}
            />
          )}
        </TableCell>
      )}
      <TableCell className={cn(cellClassName, borderedCellClassName)}>
        <div className="flex items-center gap-3">
          {variable.updatedAt ? (
            <span className="shrink-0 text-sm tabular-nums text-text-dimmed">
              <DateTime date={variable.updatedAt} includeSeconds={false} />
            </span>
          ) : null}
          {variable.updatedByUser ? (
            <div className="flex min-w-0 items-center gap-2">
              <UserAvatar
                avatarUrl={variable.updatedByUser.avatarUrl}
                name={variable.updatedByUser.name}
                className="size-5 shrink-0"
              />
              <span className="truncate text-sm">{variable.updatedByUser.name}</span>
            </div>
          ) : variable.lastUpdatedBy?.type === "integration" &&
            variable.lastUpdatedBy?.integration === "vercel" ? (
            <div className="flex min-w-0 items-center gap-2">
              <VercelLogo className="size-4 shrink-0 text-text-dimmed transition-colors group-hover/table-row:text-text-bright" />
              <span className="truncate text-sm capitalize text-text-dimmed transition-colors group-hover/table-row:text-text-bright">
                {variable.lastUpdatedBy.integration}
              </span>
            </div>
          ) : null}
        </div>
      </TableCell>
      <TableCellMenu
        isSticky
        className="[&:has(.group-hover/table-row:block)]:w-auto w-0"
        hiddenButtons={
          // No edit/delete for environments the role can't manage — the value
          // is withheld, and the action enforces write:envvars independently.
          variable.permissionDenied ? undefined : (
            <>
              <EditEnvironmentVariablePanel variable={variable} revealAll={revealAll} />
              <DeleteEnvironmentVariableButton variable={variable} />
            </>
          )
        }
      />
    </TableRow>
  );
}

function EnvironmentVariablesVirtualTableBody({
  groupedEnvironmentVariables,
  scrollRef,
  revealAll,
  vercelIntegration,
  columnCount,
}: {
  groupedEnvironmentVariables: GroupedEnvironmentVariable[];
  scrollRef: RefObject<HTMLDivElement | null>;
  revealAll: boolean;
  vercelIntegration: PageVercelIntegration | null;
  columnCount: number;
}) {
  const rowVirtualizer = useVirtualizer({
    count: groupedEnvironmentVariables.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_HEIGHT,
    overscan: VIRTUAL_OVERSCAN,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const topSpacerHeight = virtualItems[0]?.start ?? 0;
  const bottomSpacerHeight = rowVirtualizer.getTotalSize() - (virtualItems.at(-1)?.end ?? 0);

  return (
    <TableBody>
      {topSpacerHeight > 0 && (
        <tr aria-hidden style={{ height: topSpacerHeight }}>
          <td colSpan={columnCount} />
        </tr>
      )}
      {virtualItems.map((virtualRow) => {
        const variable = groupedEnvironmentVariables[virtualRow.index];
        if (!variable) {
          return null;
        }

        return (
          <EnvironmentVariableTableRow
            key={`${variable.id}-${variable.environment.id}`}
            variable={variable}
            revealAll={revealAll}
            vercelIntegration={vercelIntegration}
          />
        );
      })}
      {bottomSpacerHeight > 0 && (
        <tr aria-hidden style={{ height: bottomSpacerHeight }}>
          <td colSpan={columnCount} />
        </tr>
      )}
    </TableBody>
  );
}

function EditEnvironmentVariablePanel({
  variable,
  revealAll,
}: {
  variable: EnvironmentVariableWithSetValues;
  revealAll: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const fetcher = useFetcher<typeof action>();
  const lastSubmission = fetcher.data as any;

  const isLoading = fetcher.state !== "idle";

  // Close dialog on successful submission
  useEffect(() => {
    if (lastSubmission?.success && fetcher.state === "idle") {
      setIsOpen(false);
    }
  }, [lastSubmission?.success, fetcher.state]);

  const [form, { id, environmentId, value }] = useForm({
    id: `edit-environment-variable-${variable.id}-${variable.environment.id}`,
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onSubmit",
  });

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button
          variant="small-menu-item"
          LeadingIcon={PencilSquareIcon}
          fullWidth
          textAlignLeft
        ></Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>Edit environment variable</DialogHeader>
        <fetcher.Form method="post" {...form.props}>
          <input type="hidden" name="action" value="edit" />
          <input {...conform.input(id, { type: "hidden" })} value={variable.id} />
          <input
            {...conform.input(environmentId, { type: "hidden" })}
            value={variable.environment.id}
          />
          <FormError id={id.errorId}>{id.error}</FormError>
          <FormError id={environmentId.errorId}>{environmentId.error}</FormError>
          <Fieldset>
            <InputGroup fullWidth className="mt-2 gap-0">
              <Label>Key</Label>
              <CopyableText value={variable.key} className="w-fit font-mono text-sm" />
            </InputGroup>

            <InputGroup fullWidth>
              <Label>Environment</Label>
              <EnvironmentCombo environment={variable.environment} className="text-sm" />
            </InputGroup>

            <InputGroup fullWidth>
              <Label>Value</Label>
              <Input
                {...conform.input(value, { type: "text" })}
                placeholder={variable.isSecret ? "Set new secret value" : "Not set"}
                defaultValue={variable.value}
                type={"text"}
              />
              <FormError id={value.errorId}>{value.error}</FormError>
            </InputGroup>

            <FormError>{form.error}</FormError>

            <FormButtons
              confirmButton={
                <Button type="submit" variant="primary/medium" disabled={isLoading}>
                  {isLoading ? "Saving…" : "Save"}
                </Button>
              }
              cancelButton={
                <Button onClick={() => setIsOpen(false)} variant="tertiary/medium" type="button">
                  Cancel
                </Button>
              }
            />
          </Fieldset>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteEnvironmentVariableButton({
  variable,
}: {
  variable: EnvironmentVariableWithSetValues;
}) {
  const lastSubmission = useActionData();
  const navigation = useNavigation();

  const isLoading =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("action") === "delete";

  const [form, { id }] = useForm({
    id: "delete-environment-variable",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onSubmit",
  });

  return (
    <Form method="post" {...form.props}>
      <input type="hidden" name="id" value={variable.id} />
      <input type="hidden" name="key" value={variable.key} />
      <input type="hidden" name="environmentId" value={variable.environment.id} />
      <Button
        name="action"
        value="delete"
        type="submit"
        variant="small-menu-item"
        fullWidth
        textAlignLeft
        LeadingIcon={TrashIcon}
        leadingIconClassName="text-rose-500 group-hover/button:text-text-bright transition-colors"
        className="ml-0.5 transition-colors group-hover/button:bg-error"
      >
        {isLoading ? "Deleting" : ""}
      </Button>
    </Form>
  );
}

/**
 * Toggle component for controlling whether an environment variable is pulled from Vercel.
 *
 * When enabled, the variable will be pulled from Vercel during builds.
 * By default, all variables are pulled unless explicitly disabled.
 *
 * Note: If the env slug is missing from syncEnvVarsMapping, all vars are pulled by default.
 * Only when syncEnvVarsMapping[envSlug][envVarName] = false, the env var is skipped during builds.
 */
function VercelSyncCheckbox({
  envVarKey,
  environmentType,
  syncEnabled,
  pullEnvVarsEnabledForEnv,
}: {
  envVarKey: string;
  environmentType: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT";
  syncEnabled: boolean;
  pullEnvVarsEnabledForEnv: boolean;
}) {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

  const isLoading = fetcher.state !== "idle";

  // Revalidate loader data after successful submission (without full page reload)
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      const data = fetcher.data as { success?: boolean };
      if (data.success) {
        revalidator.revalidate();
      }
    }
  }, [fetcher.state, fetcher.data, revalidator]);

  const handleChange = (checked: boolean) => {
    fetcher.submit(
      {
        action: "update-vercel-sync",
        key: envVarKey,
        environmentType,
        syncEnabled: checked.toString(),
      },
      { method: "post" }
    );
  };

  // If pull env vars is disabled for this environment, show disabled state
  if (!pullEnvVarsEnabledForEnv) {
    return (
      <SimpleTooltip
        button={<Switch variant="small" checked={false} disabled onCheckedChange={() => {}} />}
        content="Enable 'Pull env vars before build' for this environment in Vercel settings."
      />
    );
  }

  return (
    <Switch
      variant="small"
      checked={syncEnabled}
      disabled={isLoading}
      onCheckedChange={handleChange}
    />
  );
}
