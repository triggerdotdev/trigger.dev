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
import { EnvironmentCombo, environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Feedback } from "~/components/Feedback";
import { PermissionDenied } from "~/components/PermissionDenied";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Select, SelectItem } from "~/components/primitives/Select";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { CopyButton } from "~/components/primitives/CopyButton";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
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
import { useFeatures } from "~/hooks/useFeatures";
import { useOrganization } from "~/hooks/useOrganizations";
import { useShowSelfServe } from "~/hooks/useShowSelfServe";
import { canIssueAdditionalApiKeys } from "~/services/additionalApiKeyIssuance.server";
import {
  validateCreateApiKeyPreset,
  type ApiKeyPreset,
} from "~/services/apiKeyPresetValidation.server";
import { rbac } from "~/services/rbac.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { cn } from "~/utils/cn";
import { docsPath, EnvironmentParamSchema, v3BillingPath } from "~/utils/pathBuilder";
import { sectionAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import { WhenAgentUnavailable } from "~/components/dashboard-agent/WhenAgentUnavailable";
import type { Handle } from "~/utils/handle";

export const handle: Handle = {
  agentPageContext: () => sectionAgentPageContext("apikeys"),
};

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
      const [data, additionalApiKeyIssuanceEnabled, isRbacPluginAvailable] = await Promise.all([
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
        rbac.isUsingPlugin(),
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
        isRbacPluginAvailable,
        showRevoked: searchParams.showRevoked ?? false,
        loadedAt: Date.now(),
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
    isRbacPluginAvailable,
    showRevoked,
    hasVercelIntegration,
    availableTasks,
    presets,
    loadedAt,
  } = useTypedLoaderData<typeof loader>();

  const apiKeyEnvironmentLabel = {
    ...environment,
    branchName:
      environment.type === "DEVELOPMENT" || environment.type === "PREVIEW"
        ? null
        : environment.branchName,
  };

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

          <WhenAgentUnavailable>
            <LinkButton
              variant="docs/small"
              LeadingIcon={BookOpenIcon}
              to={docsPath("/v3/apikeys")}
            >
              API keys docs
            </LinkButton>
          </WhenAgentUnavailable>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        {canReadApiKeys ? (
          <div className="max-h-full min-h-full overflow-y-auto border-t border-grid-dimmed">
            <div className="flex h-fit items-center justify-end gap-2 p-2">
              <div className="flex items-center gap-2">
                <EnvironmentVariablesDialog
                  environmentType={environment.type}
                  envBlock={envBlock}
                />
                <RevokedFilter checked={showRevoked} />
                {additionalApiKeyIssuanceEnabled ? (
                  <NewApiKeyDialog
                    canWrite={canWriteApiKeys}
                    availableTasks={availableTasks}
                    presets={presets}
                    isRbacPluginAvailable={isRbacPluginAvailable}
                    environment={apiKeyEnvironmentLabel}
                  />
                ) : null}
              </div>
            </div>

            <Table>
              <ApiKeyTableHeader />
              <TableBody>
                <TableRow className="h-[3.25rem] [&_td]:py-2">
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
                    <ApiKeyStatus now={loadedAt} />
                  </TableCell>
                  <TableCell>
                    <ApiKeyAccess label="No restrictions" />
                  </TableCell>
                  <TableCell>–</TableCell>
                  <TableCell>–</TableCell>
                  <TableCell>–</TableCell>
                  <TableCellMenu
                    isSticky
                    className="w-32"
                    hiddenButtons={
                      canWriteApiKeys ? (
                        <RegenerateApiKeyModal
                          id={environment.keyEnvironmentId}
                          title={environmentFullTitle(apiKeyEnvironmentLabel)}
                          hasVercelIntegration={hasVercelIntegration}
                          isDevelopment={environment.type === "DEVELOPMENT"}
                        />
                      ) : null
                    }
                  />
                </TableRow>

                {apiKeys.map((apiKey) => {
                  const isExpired = apiKey.expiresAt
                    ? new Date(apiKey.expiresAt).getTime() <= loadedAt
                    : false;
                  const cannotAuthenticate = Boolean(apiKey.revokedAt) || isExpired;
                  const cannotRevoke = Boolean(apiKey.revokedAt) || isExpired;
                  const creator =
                    apiKey.createdBy?.displayName ??
                    apiKey.createdBy?.name ??
                    apiKey.createdBy?.email ??
                    "–";

                  return (
                    <TableRow
                      key={apiKey.id}
                      disabled={cannotAuthenticate}
                      className="h-[3.25rem] [&_td]:py-2"
                    >
                      <TableCell>{apiKey.name}</TableCell>
                      <TableCell>
                        <span className="font-mono text-text-dimmed">{apiKey.obfuscated}</span>
                      </TableCell>
                      <TableCell>
                        <ApiKeyStatus
                          revokedAt={apiKey.revokedAt}
                          expiresAt={apiKey.expiresAt}
                          now={loadedAt}
                        />
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
                        hiddenButtons={
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
        ) : (
          <MainHorizontallyCenteredContainer className="py-6">
            <PermissionDenied
              message={`With your current role, you can't view the API keys for ${environmentFullTitle(
                apiKeyEnvironmentLabel
              )}.`}
            />
          </MainHorizontallyCenteredContainer>
        )}
      </PageBody>
    </PageContainer>
  );
}

function ApiKeyTableHeader() {
  return (
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
  );
}

function EnvironmentVariablesDialog({
  environmentType,
  envBlock,
}: {
  environmentType: string;
  envBlock: string | null;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary/small">How to set env vars</Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>Set environment variables</DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          {environmentType === "DEVELOPMENT" ? (
            <Callout variant="info">
              Every team member gets their own dev API keys. Make sure you're using one from this
              page, otherwise you will trigger runs on your team member's machine.
            </Callout>
          ) : null}
          <Paragraph>
            Set these environment variables in your backend so the SDK can authenticate with
            Trigger.dev.
          </Paragraph>
          {envBlock ? (
            <CodeBlock
              language="javascript"
              code={envBlock}
              showOpenInModal={false}
              showLineNumbers={false}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
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
  isRbacPluginAvailable,
  environment,
}: {
  canWrite: boolean;
  availableTasks: string[];
  presets: ApiKeyPreset[] | null;
  isRbacPluginAvailable: boolean;
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
  const additionalPresetIds =
    presets?.filter((preset) => !KNOWN_PRESET_IDS.has(preset.id)).map((preset) => preset.id) ?? [];
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
      // oxlint-disable-next-line react/react-compiler -- This effect intentionally synchronizes route state after an external or lifecycle change.
      setCreatedApiKey(actionData.apiKey);
    } else if (actionData && !actionData.ok) {
      setShowError(true);
    }
  }, [actionData, fetcher.state]);

  const selectedPreset = presets?.find((preset) => preset.id === presetId);
  const showAccessControls = isRbacPluginAvailable && presets !== null;
  const selectedPresetIsAvailable = !showAccessControls || selectedPreset?.available === true;
  const scopeDetail = scopeDetailForPreset(selectedPreset);
  const usesTaskSelection = showAccessControls && (selectedPreset?.usesTaskSelection ?? false);
  const showTaskAccess = selectedPresetIsAvailable && usesTaskSelection;
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
      <DialogContent
        className={cn(
          "max-h-[80vh] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 pt-2.5",
          showAccessControls ? "lg:max-w-[62rem]" : "lg:max-w-[40rem]"
        )}
      >
        <DialogHeader className="flex flex-row items-center gap-2.5 px-5 pb-3">
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
          <fetcher.Form
            method="post"
            onSubmit={() => setShowError(false)}
            className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]"
          >
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
            <div
              className={cn(
                "grid min-h-0 grid-cols-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control",
                showAccessControls && "lg:grid-cols-[minmax(0,1fr)_21rem]"
              )}
            >
              <div className={cn("min-w-0 px-5 pb-6 pt-4", showAccessControls && "space-y-5")}>
                <div
                  className={cn(
                    "grid gap-4 pb-5 sm:grid-cols-[minmax(0,1fr)_12rem]",
                    showAccessControls && "border-b border-grid-dimmed"
                  )}
                >
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

                {showAccessControls && presets ? (
                  <RadioGroup value={presetId} onValueChange={setPresetId} className="space-y-4">
                    <PresetOptions presets={presets} ids={["FULL_ACCESS"]} className="grid" />
                    <PresetGroup
                      title="Trigger and operate tasks"
                      presets={presets}
                      ids={["TRIGGER_ONLY", "TASK_OPERATOR"]}
                    />
                    <div
                      className={cn(
                        "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                        showTaskAccess
                          ? "grid-rows-[1fr] opacity-100"
                          : "pointer-events-none grid-rows-[0fr] opacity-0"
                      )}
                    >
                      <div className="min-h-0 overflow-hidden">
                        <TaskAccessPanel
                          scopable={usesTaskSelection}
                          taskLabel={scopeDetail?.taskLabel ?? "Scope details unavailable"}
                          taskScope={taskScope}
                          setTaskScope={setTaskScope}
                          selectedTasks={selectedTasks}
                          setSelectedTasks={setSelectedTasks}
                          availableTasks={availableTasks}
                        />
                      </div>
                    </div>
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
                    {additionalPresetIds.length > 0 ? (
                      <PresetGroup
                        title="Other access"
                        presets={presets}
                        ids={additionalPresetIds}
                      />
                    ) : null}
                  </RadioGroup>
                ) : null}
              </div>

              {showAccessControls ? (
                <ApiKeyScopePanel
                  preset={selectedPreset}
                  taskScope={usesTaskSelection ? taskScope : undefined}
                  selectedTasks={selectedTasks}
                  showUpgradeCta={selectedPreset ? !selectedPreset.available : false}
                />
              ) : null}
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
                    !selectedPresetIsAvailable ||
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

const KNOWN_PRESET_IDS = new Set([
  "FULL_ACCESS",
  "TRIGGER_ONLY",
  "TASK_OPERATOR",
  "ENVIRONMENT_OBSERVER",
  "ENVIRONMENT_OPERATOR",
  "DEPLOY_ONLY",
  "ENV_VARS_ONLY",
]);

const API_KEY_EXPIRATIONS = [
  { value: "30-days", label: "In 30 days" },
  { value: "90-days", label: "In 90 days" },
  { value: "1-year", label: "In 1 year" },
  { value: "never", label: "Never" },
];

type CapId = "tasks" | "runs" | "batches" | "queues" | "deployments" | "branches" | "envvars";

// Capability rows shown in the scope pane, in a fixed order so two presets read
// as a diff of the same list rather than a reshuffled one.
const SCOPE_CAPABILITIES: [CapId, string][] = [
  ["tasks", "Tasks"],
  ["runs", "Runs"],
  ["batches", "Batches"],
  ["queues", "Queues"],
  ["deployments", "Deployments"],
  ["branches", "Preview branches"],
  ["envvars", "Environment variables"],
];

// 0 none · 1 read · 2 read & write · 3 allowed (an action) · 4 full
const SCOPE_LEVEL_WORDS = ["No access", "Read", "Read & write", "Allowed", "Full access"] as const;
const SCOPE_LEVEL_TONES = ["none", "read", "write", "write", "write"] as const;

type ScopeTone = (typeof SCOPE_LEVEL_TONES)[number];

// The second entry retains the plugin-provided raw scope strings.
type PresetCapability = [level: number, rawScopes: string[]];

type PresetScopeDetail = {
  /** A single `admin` scope grants everything, so every row reads "Full access". */
  admin?: boolean;
  /** Task-scopable presets expand task scopes into the selected task identifiers. */
  scopable?: boolean;
  /** Shown in the task-access panel for presets that aren't task-scopable. */
  taskLabel?: string;
  caps: Partial<Record<CapId, PresetCapability>>;
};

const SCOPE_CAPABILITY_BY_SCOPE: Record<string, [CapId, number]> = {
  "trigger:tasks": ["tasks", 3],
  "batchTrigger:tasks": ["batches", 3],
  "batchTrigger:batch": ["batches", 3],
  "read:tasks": ["tasks", 1],
  "write:tasks": ["tasks", 2],
  "read:runs": ["runs", 1],
  "write:runs": ["runs", 2],
  "read:batch": ["batches", 1],
  "write:batch": ["batches", 2],
  "read:queues": ["queues", 1],
  "write:queues": ["queues", 2],
  "read:deployments": ["deployments", 1],
  "write:deployments": ["deployments", 2],
  "write:branches": ["branches", 3],
  "read:envvars": ["envvars", 1],
  "write:envvars": ["envvars", 2],
};

function scopeDetailForPreset(preset?: ApiKeyPreset): PresetScopeDetail | undefined {
  const scopes = preset?.scopes;
  if (!scopes) return;
  if (scopes.includes("admin")) {
    return { admin: true, taskLabel: "All tasks", caps: {} };
  }

  const caps: PresetScopeDetail["caps"] = {};
  for (const scope of scopes) {
    const [action, resource] = scope.split(":");
    const capability = SCOPE_CAPABILITY_BY_SCOPE[`${action}:${resource}`];
    if (!capability) continue;

    const [key, level] = capability;
    const current = caps[key];
    caps[key] = [Math.max(current?.[0] ?? 0, level), [...(current?.[1] ?? []), scope]];
  }

  return {
    scopable: preset.usesTaskSelection,
    taskLabel: scopes.some((scope) => scope.split(":")[1] === "tasks") ? "All tasks" : "No tasks",
    caps,
  };
}

function expandScopeString(raw: string, scoped: boolean, tasks: string[]): string[] {
  const parts = raw.split(":");
  if (!scoped || parts.length !== 2 || parts[1] !== "tasks") {
    return [raw];
  }

  const shown = tasks.slice(0, 3).map((task) => `${raw}:${task}`);
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
            className="h-full min-h-[3.5rem] items-start border-grid-bright bg-background-bright p-3 shadow-none [&_p]:mt-0.5 [&_p]:text-xs [&_p]:leading-snug hover:border-border-bright hover:bg-background-hover data-[state=checked]:border-indigo-500/70 data-[state=checked]:bg-indigo-500/10 hover:data-[state=checked]:bg-indigo-500/15"
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
  showUpgradeCta,
}: {
  preset?: ApiKeyPreset;
  taskScope?: "all" | "selected";
  selectedTasks: string[];
  showUpgradeCta: boolean;
}) {
  const detail = scopeDetailForPreset(preset);
  const scoped = Boolean(detail?.scopable && taskScope === "selected" && selectedTasks.length > 0);

  if (showUpgradeCta) {
    return (
      <aside className="border-t border-grid-bright bg-background-deep lg:border-l lg:border-t-0">
        <div className="px-5 pb-6 pt-4">
          <ApiKeyScopeUpgradeCta show />
        </div>
      </aside>
    );
  }

  if (!detail) {
    return (
      <aside className="border-t border-grid-bright bg-background-deep lg:border-l lg:border-t-0">
        <div className="px-5 pb-6 pt-4">
          <p className="text-xs text-text-dimmed">
            Scope details are unavailable for this access preset.
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="border-t border-grid-bright bg-background-deep lg:border-l lg:border-t-0">
      <div className="px-5 pb-6 pt-4">
        <div className="space-y-4">
          <ul className="flex flex-col">
            {SCOPE_CAPABILITIES.map(([key, label]) => {
              const cap = detail.admin ? undefined : detail.caps[key];
              const level = detail.admin ? 4 : cap ? cap[0] : 0;
              const rawScopes = cap?.[1];
              const tone: ScopeTone = SCOPE_LEVEL_TONES[level] ?? "none";
              const rows = rawScopes?.flatMap((raw) =>
                expandScopeString(raw, scoped, selectedTasks)
              );

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
      </div>
    </aside>
  );
}

function ApiKeyScopeUpgradeCta({ show }: { show: boolean }) {
  const { isManagedCloud } = useFeatures();
  const organization = useOrganization();
  const showSelfServe = useShowSelfServe();

  if (!show) return null;

  if (!isManagedCloud) {
    return (
      <div className="text-right">
        <Paragraph variant="small">
          Restricted API keys aren't available on your current plan. Contact your administrator to
          enable them.
        </Paragraph>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end text-right">
      <Paragraph variant="small" className="mb-3">
        Upgrade to create restricted keys.
      </Paragraph>
      {showSelfServe ? (
        <LinkButton variant="primary/small" to={v3BillingPath(organization)}>
          View plans
        </LinkButton>
      ) : (
        <Feedback
          defaultValue="enterprise"
          button={<Button variant="secondary/small">Contact us</Button>}
        />
      )}
    </div>
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
  now,
}: {
  revokedAt?: Date | string | null;
  expiresAt?: Date | string | null;
  now: number;
}) {
  if (revokedAt) {
    return (
      <div className="flex items-center gap-1 text-xs text-text-dimmed">
        <NoSymbolIcon className="size-4" />
        Revoked
      </div>
    );
  }

  if (expiresAt && new Date(expiresAt).getTime() <= now) {
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
