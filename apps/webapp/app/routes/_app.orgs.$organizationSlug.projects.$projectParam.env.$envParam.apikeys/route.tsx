import {
  BookOpenIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  NoSymbolIcon,
  PlusIcon,
} from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useSearchParams } from "@remix-run/react";
import { useEffect, useState } from "react";
import { typedjson, useTypedFetcher, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { CopyableText } from "~/components/primitives/CopyableText";
import { CodeBlock } from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import { RegenerateApiKeyModal } from "~/components/environments/RegenerateApiKeyModal";
import {
  EnvironmentCombo,
  environmentFullTitle,
  environmentTextClassName,
} from "~/components/environments/EnvironmentLabel";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { PermissionDenied } from "~/components/PermissionDenied";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/primitives/Accordion";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Select, SelectItem } from "~/components/primitives/Select";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { CopyButton } from "~/components/primitives/CopyButton";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { RadioGroup, RadioGroupItem } from "~/components/primitives/RadioButton";
import SegmentedControl from "~/components/primitives/SegmentedControl";
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
import { MAX_API_KEY_TASK_IDENTIFIERS } from "~/consts";
import { createEnvironmentApiKey, revokeEnvironmentApiKey } from "~/models/api-key.server";
import {
  redirectWithErrorMessage,
  redirectWithSuccessMessage,
  typedJsonWithErrorMessage,
  typedJsonWithSuccessMessage,
} from "~/models/message.server";
import { resolveOrgIdFromSlug } from "~/models/organization.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { ApiKeysPresenter } from "~/presenters/v3/ApiKeysPresenter.server";
import { canIssueAdditionalApiKeys } from "~/services/additionalApiKeyIssuance.server";
import {
  validateCreateApiKeyPreset,
  type ApiKeyPreset,
} from "~/services/apiKeyPresetValidation.server";
import { rbac } from "~/services/rbac.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { cn } from "~/utils/cn";
import { docsPath, EnvironmentParamSchema } from "~/utils/pathBuilder";
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta("API keys");

const ApiKeySearchParams = z.object({
  showRevoked: z.preprocess((value) => value === "true" || value === true, z.boolean()).optional(),
});

const CreateApiKeySchema = z.object({
  action: z.literal("create"),
  name: z.string().trim().min(1).max(64),
  expiresAt: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z.coerce
      .date()
      .refine((date) => date.getTime() > Date.now(), "Expiration must be in the future")
      .optional()
  ),
  presetId: z.string().trim().min(1),
  taskScope: z.enum(["all", "selected"]).optional(),
  taskIdentifiers: z
    .array(z.string().trim().min(1, "Task identifiers cannot be blank"))
    .max(MAX_API_KEY_TASK_IDENTIFIERS, {
      message: `You can select at most ${MAX_API_KEY_TASK_IDENTIFIERS} tasks`,
    })
    .default([]),
});

const ApiKeyActionSchema = z.discriminatedUnion("action", [
  CreateApiKeySchema,
  z.object({ action: z.literal("revoke"), apiKeyId: z.string().min(1) }),
]);

type ApiKeyActionData =
  | { ok: true; action: "create"; apiKey: string }
  | { ok: false; error: string };

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    searchParams: ApiKeySearchParams,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
  },
  async ({ params, searchParams, user, ability, context }) => {
    try {
      const presenter = new ApiKeysPresenter();
      const [data, additionalApiKeyIssuanceEnabled] = await Promise.all([
        presenter.call({
          userId: user.id,
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectParam,
          environmentSlug: params.envParam,
          showRevoked: searchParams.showRevoked,
        }),
        context.organizationId
          ? canIssueAdditionalApiKeys(context.organizationId)
          : Promise.resolve(false),
      ]);

      const canReadApiKeys = ability.can("read", {
        type: "apiKeys",
        envType: data.environment.type,
      });
      const canWriteApiKeys = ability.can("write", {
        type: "apiKeys",
        envType: data.environment.type,
      });

      return typedjson({
        ...data,
        environment: {
          ...data.environment,
          apiKey: canReadApiKeys ? data.environment.apiKey : null,
        },
        rootApiKey: {
          ...data.rootApiKey,
          value: canReadApiKeys ? data.rootApiKey.value : null,
          obfuscated: canReadApiKeys ? data.rootApiKey.obfuscated : null,
        },
        apiKeys: canReadApiKeys ? data.apiKeys : [],
        canReadApiKeys,
        canWriteApiKeys,
        additionalApiKeyIssuanceEnabled,
        showRevoked: searchParams.showRevoked ?? false,
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

export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    // The environment tier is only known after resolving the route params,
    // so write:apiKeys is enforced in the handler before any mutation.
  },
  async ({ request, params, user, ability }) => {
    if (request.method.toUpperCase() !== "POST") {
      throw new Response("Method Not Allowed", { status: 405 });
    }

    const project = await findProjectBySlug(params.organizationSlug, params.projectParam, user.id);
    if (!project) {
      throw new Response("Project not found", { status: 404 });
    }

    const environment = await findEnvironmentBySlug(project.id, params.envParam, user.id);
    if (!environment) {
      throw new Response("Environment not found", { status: 404 });
    }

    if (!ability.can("write", { type: "apiKeys", envType: environment.type })) {
      return typedJsonWithErrorMessage(
        { ok: false as const, error: "You don't have permission to manage these API keys." },
        request,
        "You don't have permission to manage these API keys."
      );
    }

    const formData = await request.formData();
    const hasTaskParameters = formData.has("taskScope") || formData.has("taskIdentifiers");
    const submission = ApiKeyActionSchema.safeParse({
      ...Object.fromEntries(formData),
      taskIdentifiers: formData.getAll("taskIdentifiers"),
    });
    if (!submission.success) {
      const error = submission.error.issues[0]?.message ?? "Invalid API key request";
      return typedJsonWithErrorMessage({ ok: false as const, error }, request, error);
    }

    const keyEnvironmentId = environment.parentEnvironmentId ?? environment.id;
    const returnPath = `${new URL(request.url).pathname}${new URL(request.url).search}`;

    try {
      switch (submission.data.action) {
        case "create": {
          if (!(await canIssueAdditionalApiKeys(project.organizationId))) {
            const message = "Creating additional API keys is not enabled.";
            return typedJsonWithErrorMessage(
              { ok: false as const, error: message },
              request,
              message
            );
          }

          const presets = await rbac.apiKeyPresets(project.organizationId);
          const preset = validateCreateApiKeyPreset({
            presets,
            presetId: submission.data.presetId,
            taskScope: submission.data.taskScope,
            taskIdentifiers: submission.data.taskIdentifiers,
            hasTaskParameters,
          });
          const result = await createEnvironmentApiKey({
            environmentId: keyEnvironmentId,
            taskEnvironmentId: environment.id,
            userId: user.id,
            name: submission.data.name,
            expiresAt: submission.data.expiresAt,
            presetId: preset.presetId,
            taskIdentifiers:
              preset.usesTaskSelection && submission.data.taskScope === "selected"
                ? submission.data.taskIdentifiers
                : undefined,
          });

          return typedJsonWithSuccessMessage(
            {
              ok: true as const,
              action: "create" as const,
              apiKey: result.plaintext,
            },
            request,
            `Created ${submission.data.name} API key`
          );
        }
        case "revoke": {
          await revokeEnvironmentApiKey({
            environmentId: keyEnvironmentId,
            apiKeyId: submission.data.apiKeyId,
          });

          return redirectWithSuccessMessage(returnPath, request, "API key revoked");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update API keys";

      if (submission.data.action === "create") {
        return typedJsonWithErrorMessage({ ok: false as const, error: message }, request, message);
      }

      return redirectWithErrorMessage(returnPath, request, message);
    }
  }
);

export default function Page() {
  const {
    environment,
    rootApiKey,
    apiKeys,
    canReadApiKeys,
    canWriteApiKeys,
    additionalApiKeyIssuanceEnabled,
    showRevoked,
    hasVercelIntegration,
    availableTasks,
    presets,
  } = useTypedLoaderData<typeof loader>();

  const envBlock = environment.apiKey
    ? [
        `TRIGGER_SECRET_KEY="${environment.apiKey}"`,
        environment.branchName ? `TRIGGER_PREVIEW_BRANCH="${environment.branchName}"` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : null;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="API keys" />
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              <Property.Item>
                <Property.Label>{environment.slug}</Property.Label>
                <Property.Value>
                  <CopyableText value={environment.id} asChild hideTooltip />
                </Property.Value>
              </Property.Item>
            </Property.Table>
          </AdminDebugTooltip>

          <LinkButton variant="docs/small" LeadingIcon={BookOpenIcon} to={docsPath("/v3/apikeys")}>
            API keys docs
          </LinkButton>

          {canReadApiKeys && additionalApiKeyIssuanceEnabled ? (
            <NewApiKeyDialog
              canWrite={canWriteApiKeys}
              availableTasks={availableTasks}
              presets={presets}
              environment={environment}
            />
          ) : null}
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        {canReadApiKeys ? (
          <div className="grid max-h-full min-h-full grid-rows-[auto_auto_1fr]">
            <MainHorizontallyCenteredContainer className="w-full py-3">
              <div className="mb-3 border-b border-grid-dimmed pb-1">
                <Header2
                  className={cn(
                    "inline-flex items-center gap-1 font-normal",
                    environmentTextClassName(environment)
                  )}
                >
                  <EnvironmentCombo
                    environment={environment}
                    className="text-base"
                    iconClassName="size-5"
                  />
                  API keys
                </Header2>
              </div>

              {environment.type === "DEVELOPMENT" ? (
                <Callout variant="info" className="mb-3">
                  Every team member gets their own dev API keys. Make sure you're using one from
                  this page, otherwise you will trigger runs on your team member's machine.
                </Callout>
              ) : null}

              <Accordion type="single" collapsible>
                <AccordionItem
                  value="environment-variables"
                  className="bg-white dark:bg-transparent"
                >
                  <AccordionTrigger>How to set these environment variables</AccordionTrigger>
                  <AccordionContent>
                    <div className="flex flex-col gap-2">
                      <div>
                        Set these environment variables in your backend so the SDK can authenticate
                        with Trigger.dev.
                      </div>
                      {envBlock ? (
                        <CodeBlock
                          language="javascript"
                          code={envBlock}
                          showOpenInModal={false}
                          showLineNumbers={false}
                        />
                      ) : null}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </MainHorizontallyCenteredContainer>

            <div className="flex items-center justify-end border-t border-grid-dimmed p-2">
              <RevokedFilter checked={showRevoked} />
            </div>

            <div className="overflow-x-auto">
              <Table showTopBorder={false}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Secret key</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Access</TableHeaderCell>
                    <TableHeaderCell>Created by</TableHeaderCell>
                    <TableHeaderCell>Created</TableHeaderCell>
                    <TableHeaderCell>Last used</TableHeaderCell>
                    <TableHeaderCell className="w-32" hiddenLabel>
                      Actions
                    </TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow isSelected>
                    <TableCell>
                      <div className="flex items-center gap-1.5 text-text-bright">
                        <KeyIcon className="size-4" />
                        {rootApiKey.name}
                        <Badge variant="extra-small">Root</Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex w-64 items-center justify-between gap-2">
                        <span className="font-mono text-text-dimmed">
                          {rootApiKey.obfuscated ?? "–"}
                        </span>
                        {rootApiKey.value ? (
                          <CopyButton value={rootApiKey.value} variant="icon" size="small" />
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <ApiKeyStatus />
                    </TableCell>
                    <TableCell>
                      <ApiKeyAccess label="No restrictions" />
                    </TableCell>
                    <TableCell>–</TableCell>
                    <TableCell>
                      <DateTime date={rootApiKey.createdAt} />
                    </TableCell>
                    <TableCell>–</TableCell>
                    <TableCellMenu
                      isSticky
                      className="w-32 bg-background-hover group-hover/table-row:bg-background-bright"
                      visibleButtons={
                        canWriteApiKeys ? (
                          <RegenerateApiKeyModal
                            id={environment.keyEnvironmentId}
                            title={environmentFullTitle(environment)}
                            hasVercelIntegration={hasVercelIntegration}
                            isDevelopment={environment.type === "DEVELOPMENT"}
                          />
                        ) : null
                      }
                    />
                  </TableRow>

                  {apiKeys.map((apiKey) => {
                    const isExpired = apiKey.expiresAt
                      ? new Date(apiKey.expiresAt).getTime() <= Date.now()
                      : false;
                    const cannotAuthenticate = Boolean(apiKey.revokedAt) || isExpired;
                    const cannotRevoke = Boolean(apiKey.revokedAt) || isExpired;
                    const creator =
                      apiKey.createdBy?.displayName ??
                      apiKey.createdBy?.name ??
                      apiKey.createdBy?.email ??
                      "–";

                    return (
                      <TableRow key={apiKey.id} disabled={cannotAuthenticate}>
                        <TableCell>{apiKey.name}</TableCell>
                        <TableCell>
                          <span className="font-mono text-text-dimmed">{apiKey.obfuscated}</span>
                        </TableCell>
                        <TableCell>
                          <ApiKeyStatus revokedAt={apiKey.revokedAt} expiresAt={apiKey.expiresAt} />
                        </TableCell>
                        <TableCell>
                          <ApiKeyAccess
                            label={apiKey.access.label}
                            taskIdentifiers={apiKey.access.taskIdentifiers}
                            usesTaskSelection={apiKey.access.usesTaskSelection}
                          />
                        </TableCell>
                        <TableCell>{creator}</TableCell>
                        <TableCell>
                          <DateTime date={apiKey.createdAt} />
                        </TableCell>
                        <TableCell>
                          {apiKey.lastUsedAt ? <DateTime date={apiKey.lastUsedAt} /> : "Never"}
                        </TableCell>
                        <TableCellMenu
                          isSticky
                          className="w-32"
                          visibleButtons={
                            cannotRevoke ? null : (
                              <RevokeApiKeyButton
                                id={apiKey.id}
                                name={apiKey.name}
                                canWrite={canWriteApiKeys}
                              />
                            )
                          }
                        />
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : (
          <MainHorizontallyCenteredContainer className="py-6">
            <PermissionDenied
              message={`With your current role, you can't view the API keys for ${environmentFullTitle(
                environment
              )}.`}
            />
          </MainHorizontallyCenteredContainer>
        )}
      </PageBody>
    </PageContainer>
  );
}

function RevokedFilter({ checked }: { checked: boolean }) {
  const [, setSearchParams] = useSearchParams();

  return (
    <Switch
      checked={checked}
      onCheckedChange={(showRevoked) => {
        setSearchParams((searchParams) => {
          if (showRevoked) {
            searchParams.set("showRevoked", "true");
          } else {
            searchParams.delete("showRevoked");
          }
          return searchParams;
        });
      }}
      label="Show revoked"
      variant="secondary/small"
    />
  );
}

function NewApiKeyDialog({
  canWrite,
  availableTasks,
  presets,
  environment,
}: {
  canWrite: boolean;
  availableTasks: string[];
  presets: ApiKeyPreset[] | null;
  environment: React.ComponentProps<typeof EnvironmentCombo>["environment"];
}) {
  const fetcher = useTypedFetcher<typeof action>();
  const actionData = fetcher.data as ApiKeyActionData | undefined;
  const [showError, setShowError] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiration, setExpiration] = useState("90-days");
  const defaultPresetId =
    presets?.find((preset) => preset.id === "FULL_ACCESS" && preset.available)?.id ??
    presets?.find((preset) => preset.available)?.id ??
    "FULL_ACCESS";
  const expiresAt = expirationDate(expiration);
  const [presetId, setPresetId] = useState(defaultPresetId);
  const [taskScope, setTaskScope] = useState<"all" | "selected">("all");
  const [selectedTasks, setSelectedTasks] = useState<string[]>([]);
  const [createdApiKey, setCreatedApiKey] = useState<string>();

  useEffect(() => {
    if (fetcher.state !== "idle") {
      return;
    }

    if (actionData?.ok && actionData.action === "create") {
      setCreatedApiKey(actionData.apiKey);
    } else if (actionData && !actionData.ok) {
      setShowError(true);
    }
  }, [actionData, fetcher.state]);

  const selectedPreset = presets?.find((preset) => preset.id === presetId);
  const usesTaskSelection = selectedPreset?.usesTaskSelection ?? false;
  const needsSelectedTask = usesTaskSelection && taskScope === "selected";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setName("");
          setExpiration("90-days");
          setPresetId(defaultPresetId);
          setTaskScope("all");
          setSelectedTasks([]);
          setCreatedApiKey(undefined);
          setShowError(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="primary/small"
          LeadingIcon={PlusIcon}
          shortcut={{ key: "n" }}
          disabled={!canWrite}
          tooltip={canWrite ? undefined : "You don't have permission to create API keys"}
        >
          New API key
        </Button>
      </DialogTrigger>
      <DialogContent className="gap-0 overflow-hidden p-0 pt-2.5 lg:max-w-[62rem]">
        <DialogHeader className="flex flex-row items-center gap-2.5 px-5">
          New API key
          <EnvironmentCombo environment={environment} className="text-xs" iconClassName="size-4" />
        </DialogHeader>
        {createdApiKey ? (
          <div className="flex flex-col gap-3 p-4">
            <Callout variant="success">
              Copy this API key and store it in a secure place. You won't be able to see it again.
            </Callout>
            <ClipboardField
              secure
              value={createdApiKey}
              variant="secondary/medium"
              className="w-full"
            />
            <Callout variant="warning">
              Use <InlineCode variant="extra-small">@trigger.dev/sdk</InlineCode> v4.5.8 or later.
              Older SDK versions mint an unusable token when{" "}
              <InlineCode variant="extra-small">auth.createPublicToken()</InlineCode> is called with
              this API key.
            </Callout>
            <FormButtons
              confirmButton={
                <DialogClose asChild>
                  <Button variant="primary/small">Done</Button>
                </DialogClose>
              }
            />
          </div>
        ) : (
          <fetcher.Form method="post" onSubmit={() => setShowError(false)}>
            <input type="hidden" name="action" value="create" />
            {expiresAt ? (
              <input type="hidden" name="expiresAt" value={expiresAt.toISOString()} />
            ) : null}
            {presetId ? <input type="hidden" name="presetId" value={presetId} /> : null}
            {usesTaskSelection ? <input type="hidden" name="taskScope" value={taskScope} /> : null}
            {usesTaskSelection && taskScope === "selected"
              ? selectedTasks.map((taskIdentifier) => (
                  <input
                    key={taskIdentifier}
                    type="hidden"
                    name="taskIdentifiers"
                    value={taskIdentifier}
                  />
                ))
              : null}
            <div className="grid max-h-[68vh] grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_21rem]">
              <div className="min-w-0 space-y-5 px-5 pb-6 pt-4">
                <div className="grid gap-4 border-b border-grid-dimmed pb-5 sm:grid-cols-[minmax(0,1fr)_12rem]">
                  <InputGroup fullWidth>
                    <Label htmlFor="api-key-name">Name</Label>
                    <Input
                      id="api-key-name"
                      name="name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="e.g. Stripe webhooks"
                      maxLength={64}
                      autoComplete="off"
                      fullWidth
                    />
                    <Hint>Use a name that identifies where this key will be used.</Hint>
                  </InputGroup>

                  <InputGroup fullWidth>
                    <Label>Expires</Label>
                    <Select<string, { value: string; label: string }>
                      value={expiration}
                      setValue={setExpiration}
                      items={API_KEY_EXPIRATIONS}
                      variant="secondary/medium"
                      dropdownIcon
                      className="w-full justify-between"
                      text={(value) =>
                        API_KEY_EXPIRATIONS.find((option) => option.value === value)?.label
                      }
                    >
                      {(options) =>
                        options.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))
                      }
                    </Select>
                    <Hint>{formatExpiryHint(expiresAt)}</Hint>
                  </InputGroup>
                </div>

                {presets ? (
                  <RadioGroup value={presetId} onValueChange={setPresetId} className="space-y-4">
                    <PresetOptions presets={presets} ids={["FULL_ACCESS"]} className="grid" />
                    <PresetGroup
                      title="Trigger and operate tasks"
                      presets={presets}
                      ids={["TRIGGER_ONLY", "TASK_OPERATOR"]}
                    />
                    <PresetGroup
                      title="Environment capabilities"
                      presets={presets}
                      ids={["ENVIRONMENT_OBSERVER", "ENVIRONMENT_OPERATOR"]}
                    />
                    <PresetGroup
                      title="Deployment and configuration"
                      presets={presets}
                      ids={["DEPLOY_ONLY", "ENV_VARS_ONLY"]}
                    />
                  </RadioGroup>
                ) : null}

                <TaskAccessPanel
                  scopable={usesTaskSelection}
                  taskLabel={PRESET_SCOPE_DETAILS[presetId]?.taskLabel ?? "All tasks"}
                  taskScope={taskScope}
                  setTaskScope={setTaskScope}
                  selectedTasks={selectedTasks}
                  setSelectedTasks={setSelectedTasks}
                  availableTasks={availableTasks}
                />
              </div>

              <ApiKeyScopePanel
                preset={selectedPreset}
                taskScope={usesTaskSelection ? taskScope : undefined}
                selectedTasks={selectedTasks}
              />
            </div>

            <div className="flex items-center gap-3 border-t border-grid-bright px-5 py-3">
              {(() => {
                const error = showError && actionData && !actionData.ok ? actionData.error : null;
                const hint =
                  needsSelectedTask && selectedTasks.length === 0
                    ? "Pick at least one task, or switch to all tasks."
                    : "";
                return (
                  <span
                    className={cn(
                      "min-w-0 truncate text-xs",
                      error ? "text-error" : "text-text-dimmed"
                    )}
                  >
                    {error ?? hint}
                  </span>
                );
              })()}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <DialogClose asChild>
                  <Button variant="tertiary/small">Cancel</Button>
                </DialogClose>
                <Button
                  type="submit"
                  variant="primary/small"
                  disabled={
                    !name.trim() ||
                    (needsSelectedTask &&
                      (selectedTasks.length === 0 ||
                        selectedTasks.length > MAX_API_KEY_TASK_IDENTIFIERS)) ||
                    fetcher.state !== "idle"
                  }
                  isLoading={fetcher.state !== "idle"}
                >
                  Create API key
                </Button>
              </div>
            </div>
          </fetcher.Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

const API_KEY_EXPIRATIONS = [
  { value: "30-days", label: "In 30 days" },
  { value: "90-days", label: "In 90 days" },
  { value: "1-year", label: "In 1 year" },
  { value: "never", label: "Never" },
];

type CapId =
  | "triggerTasks"
  | "triggerBatch"
  | "tasks"
  | "runs"
  | "batches"
  | "queues"
  | "deployments"
  | "envvars";

// Capability rows shown in the scope pane, in a fixed order so two presets read
// as a diff of the same list rather than a reshuffled one.
const SCOPE_CAPABILITIES: [CapId, string][] = [
  ["triggerTasks", "Trigger tasks"],
  ["triggerBatch", "Trigger batches"],
  ["tasks", "Tasks"],
  ["runs", "Runs"],
  ["batches", "Batches"],
  ["queues", "Queues"],
  ["deployments", "Deployments"],
  ["envvars", "Environment variables"],
];

// 0 none · 1 read · 2 read & write · 3 allowed (an action) · 4 full
const SCOPE_LEVEL_WORDS = ["No access", "Read", "Read & write", "Allowed", "Full access"] as const;
const SCOPE_LEVEL_TONES = ["none", "read", "write", "write", "write"] as const;

type ScopeTone = (typeof SCOPE_LEVEL_TONES)[number];

// The second entry is the raw scope strings, where `%T` marks the optional
// per-task suffix (e.g. `trigger:tasks[:task]`).
type PresetCapability = [level: number, rawScopes: string[]];

type PresetScopeDetail = {
  /** A single `admin` scope grants everything, so every row reads "Full access". */
  admin?: boolean;
  /** Task-scopable presets expand `%T` into the selected task identifiers. */
  scopable?: boolean;
  /** Shown in the task-access panel for presets that aren't task-scopable. */
  taskLabel?: string;
  caps: Partial<Record<CapId, PresetCapability>>;
};

const PRESET_SCOPE_DETAILS: Record<string, PresetScopeDetail> = {
  FULL_ACCESS: { admin: true, taskLabel: "All tasks", caps: {} },
  TRIGGER_ONLY: {
    scopable: true,
    caps: {
      triggerTasks: [3, ["trigger:tasks%T"]],
      triggerBatch: [3, ["batchTrigger:tasks%T", "batchTrigger:batch"]],
    },
  },
  TASK_OPERATOR: {
    scopable: true,
    caps: {
      triggerTasks: [3, ["trigger:tasks%T"]],
      triggerBatch: [3, ["batchTrigger:tasks%T", "batchTrigger:batch"]],
      tasks: [2, ["read:tasks%T", "write:tasks%T"]],
    },
  },
  ENVIRONMENT_OBSERVER: {
    taskLabel: "All tasks",
    caps: {
      tasks: [1, ["read:tasks"]],
      runs: [1, ["read:runs"]],
      batches: [1, ["read:batch"]],
      queues: [1, ["read:queues"]],
    },
  },
  ENVIRONMENT_OPERATOR: {
    taskLabel: "All tasks",
    caps: {
      triggerTasks: [3, ["trigger:tasks"]],
      triggerBatch: [3, ["batchTrigger:tasks", "batchTrigger:batch"]],
      tasks: [1, ["read:tasks"]],
      runs: [2, ["read:runs", "write:runs"]],
      batches: [1, ["read:batch"]],
      queues: [2, ["read:queues", "write:queues"]],
    },
  },
  DEPLOY_ONLY: {
    taskLabel: "All tasks",
    caps: {
      deployments: [2, ["read:deployments", "write:deployments"]],
      envvars: [1, ["read:envvars"]],
    },
  },
  ENV_VARS_ONLY: {
    taskLabel: "No tasks",
    caps: {
      envvars: [2, ["read:envvars", "write:envvars"]],
    },
  },
};

function expandScopeString(raw: string, scoped: boolean, tasks: string[]): string[] {
  if (!raw.includes("%T")) {
    return [raw];
  }
  if (!scoped) {
    return [raw.replace("%T", "")];
  }
  const shown = tasks.slice(0, 3).map((task) => raw.replace("%T", `:${task}`));
  if (tasks.length > 3) {
    shown.push(`… +${tasks.length - 3} more`);
  }
  return shown;
}

function formatExpiryHint(expiresAt?: Date): string {
  if (!expiresAt) {
    return "Works until you revoke it";
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(expiresAt);
}

function expirationDate(expiration: string): Date | undefined {
  const days = { "30-days": 30, "90-days": 90, "1-year": 365 }[expiration];
  return days ? new Date(Date.now() + days * 24 * 60 * 60 * 1_000) : undefined;
}

function PresetGroup({
  title,
  presets,
  ids,
}: {
  title: string;
  presets: ApiKeyPreset[];
  ids: string[];
}) {
  return (
    <div className="space-y-2.5">
      <div className="text-xxs font-semibold uppercase tracking-wider text-indigo-400">{title}</div>
      <PresetOptions presets={presets} ids={ids} className="grid gap-2.5 sm:grid-cols-2" />
    </div>
  );
}

function PresetOptions({
  presets,
  ids,
  className,
}: {
  presets: ApiKeyPreset[];
  ids: string[];
  className?: string;
}) {
  return (
    <div className={className}>
      {ids
        .flatMap((id) => presets.filter((preset) => preset.id === id))
        .map((preset) => (
          <RadioGroupItem
            key={preset.id}
            id={`api-key-access-${preset.id}`}
            value={preset.id}
            variant="description"
            className="h-full min-h-[3.5rem] items-start border-grid-bright bg-background-bright p-3 shadow-none [&_p]:mt-0.5 [&_p]:text-xs [&_p]:leading-snug hover:border-border-bright hover:bg-background-hover data-[state=checked]:border-indigo-500/70 data-[state=checked]:bg-indigo-500/10"
            label={
              preset.id === "FULL_ACCESS" ? (
                <span className="flex items-center gap-2">
                  {preset.label}
                  <span className="rounded-[3px] bg-amber-500/15 px-1.5 py-0.5 text-xxs font-semibold uppercase tracking-wide text-amber-400">
                    Full access
                  </span>
                </span>
              ) : (
                preset.label
              )
            }
            description={preset.description}
            disabled={!preset.available}
            badges={preset.available ? undefined : ["Upgrade"]}
          />
        ))}
    </div>
  );
}

function ApiKeyScopePanel({
  preset,
  taskScope,
  selectedTasks,
}: {
  preset?: ApiKeyPreset;
  taskScope?: "all" | "selected";
  selectedTasks: string[];
}) {
  const detail = (preset && PRESET_SCOPE_DETAILS[preset.id]) ?? PRESET_SCOPE_DETAILS.FULL_ACCESS;
  const scoped = Boolean(detail.scopable && taskScope === "selected" && selectedTasks.length > 0);

  return (
    <aside className="border-t border-grid-bright bg-background-deep lg:border-l lg:border-t-0">
      <div className="sticky top-0 space-y-4 px-5 pb-6 pt-4">
        <div>
          <div className="text-xxs font-semibold uppercase tracking-wider text-text-dimmed">
            Scopes
          </div>
          <div className="mt-1 text-sm font-semibold text-text-bright">
            {preset?.label ?? "No restrictions"}
          </div>
        </div>

        {detail.admin ? (
          <div className="rounded-md border border-amber-500/25 bg-amber-500/[0.08] p-3">
            <code className="font-mono text-xs text-amber-400">admin</code>
            <p className="mt-1.5 text-xs text-text-dimmed">
              A single scope that grants everything below, including anything added to the API
              later.
            </p>
          </div>
        ) : null}

        <ul className="flex flex-col">
          {SCOPE_CAPABILITIES.map(([key, label]) => {
            const cap = detail.admin ? undefined : detail.caps[key];
            const level = detail.admin ? 4 : cap ? cap[0] : 0;
            const rawScopes = cap?.[1];
            const tone: ScopeTone = SCOPE_LEVEL_TONES[level] ?? "none";
            const rows = rawScopes?.flatMap((raw) => expandScopeString(raw, scoped, selectedTasks));

            return (
              <li key={key} className="border-t border-grid-dimmed py-2.5 first:border-t-0">
                <div className="flex items-baseline gap-2.5">
                  <span
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-[2px]",
                      tone === "read"
                        ? "bg-blue-500"
                        : tone === "write"
                          ? "bg-amber-500"
                          : "bg-charcoal-600"
                    )}
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 text-sm",
                      level === 0 ? "text-text-dimmed" : "text-text-bright"
                    )}
                  >
                    {label}
                  </span>
                  <span className="whitespace-nowrap text-xs text-text-dimmed">
                    {SCOPE_LEVEL_WORDS[level] ?? "No access"}
                  </span>
                </div>
                {rows && rows.length > 0 ? (
                  <div className="ml-4 mt-1 flex flex-col gap-0.5">
                    {rows.map((row) => (
                      <code
                        key={row}
                        className={cn(
                          "break-all font-mono text-xxs leading-relaxed",
                          row.startsWith("…")
                            ? "text-text-dimmed"
                            : tone === "read"
                              ? "text-blue-400/80"
                              : "text-amber-400/80"
                        )}
                      >
                        {row}
                      </code>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}

function TaskAccessPanel({
  scopable,
  taskLabel,
  taskScope,
  setTaskScope,
  selectedTasks,
  setSelectedTasks,
  availableTasks,
}: {
  scopable: boolean;
  taskLabel: string;
  taskScope: "all" | "selected";
  setTaskScope: (value: "all" | "selected") => void;
  selectedTasks: string[];
  setSelectedTasks: (value: string[]) => void;
  availableTasks: string[];
}) {
  return (
    <div className="rounded-md border border-grid-bright bg-background-bright/40 p-3.5">
      <div className="text-2sm font-medium text-text-bright">Task access</div>
      {/* Reserve room for the segmented control plus the Selected-tasks
          dropdown, so the panel keeps a constant height across presets and the
          dropdown never pushes the dialog past its bounds. */}
      <div className="mt-3 min-h-[5.5rem]">
        {!scopable ? (
          <p className="flex h-10 items-center text-2sm text-text-dimmed">{taskLabel}</p>
        ) : (
          <>
            <SegmentedControl
              name="task-scope"
              value={taskScope}
              onChange={(value) => setTaskScope(value as "all" | "selected")}
              fullWidth
              options={[
                { label: "All tasks", value: "all" },
                { label: "Selected tasks", value: "selected" },
              ]}
            />
            {taskScope === "selected" ? (
              <Select<string[], string>
                value={selectedTasks}
                setValue={setSelectedTasks}
                placeholder="Choose tasks"
                text={(tasks) =>
                  tasks.length === 0
                    ? undefined
                    : `${tasks.length} selected ${tasks.length === 1 ? "task" : "tasks"}`
                }
                variant="secondary/medium"
                dropdownIcon
                items={availableTasks}
                filter
                heading="Search tasks"
                empty={<div className="p-3 text-xs text-text-dimmed">No tasks found.</div>}
                className="mt-2 w-full justify-between"
                popoverClassName="max-h-64"
              >
                {(tasks) =>
                  tasks.map((taskIdentifier) => (
                    <SelectItem key={taskIdentifier} value={taskIdentifier} checkPosition="left">
                      <span className="font-mono text-text-bright">{taskIdentifier}</span>
                    </SelectItem>
                  ))
                }
              </Select>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function RevokeApiKeyButton({
  id,
  name,
  canWrite,
}: {
  id: string;
  name: string;
  canWrite: boolean;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="minimal/small"
          LeadingIcon={NoSymbolIcon}
          disabled={!canWrite}
          tooltip={canWrite ? undefined : "You don't have permission to revoke API keys"}
        >
          Revoke…
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>Revoke API key</DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          <Paragraph>
            Are you sure you want to revoke "{name}"? Requests using this key will stop
            authenticating, and it won't be able to mint new public tokens. Public tokens it already
            minted remain valid until they expire. This can't be reversed.
          </Paragraph>
          <FormButtons
            confirmButton={
              <Form method="post">
                <input type="hidden" name="action" value="revoke" />
                <input type="hidden" name="apiKeyId" value={id} />
                <Button type="submit" variant="danger/medium">
                  Revoke API key
                </Button>
              </Form>
            }
            cancelButton={
              <DialogClose asChild>
                <Button variant="tertiary/medium">Cancel</Button>
              </DialogClose>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ApiKeyAccess({
  label,
  taskIdentifiers,
  usesTaskSelection = false,
}: {
  label: string;
  taskIdentifiers?: string[];
  usesTaskSelection?: boolean;
}) {
  return (
    <div className="flex min-w-40 flex-col gap-0.5">
      <span className="text-xs text-text-bright">{label}</span>
      {usesTaskSelection ? (
        <span className="text-xs text-text-dimmed">
          {taskIdentifiers === undefined
            ? "All tasks"
            : `${taskIdentifiers.length} selected ${taskIdentifiers.length === 1 ? "task" : "tasks"}`}
        </span>
      ) : null}
    </div>
  );
}

function ApiKeyStatus({
  revokedAt,
  expiresAt,
}: {
  revokedAt?: Date | string | null;
  expiresAt?: Date | string | null;
}) {
  if (revokedAt) {
    return (
      <div className="flex items-center gap-1 text-xs text-text-dimmed">
        <NoSymbolIcon className="size-4" />
        Revoked
      </div>
    );
  }

  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    return (
      <div className="flex items-center gap-1 text-xs text-text-dimmed">
        <ExclamationTriangleIcon className="size-4" />
        Expired
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 text-xs text-success">
      <CheckCircleIcon className="size-4" />
      Active
    </div>
  );
}
