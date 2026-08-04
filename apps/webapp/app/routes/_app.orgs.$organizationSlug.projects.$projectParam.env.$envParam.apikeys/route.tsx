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
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { CopyButton } from "~/components/primitives/CopyButton";
import { DateTime } from "~/components/primitives/DateTime";
import { DateTimePicker } from "~/components/primitives/DateTimePicker";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
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
                    <TableHeaderCell hiddenLabel>Actions</TableHeaderCell>
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
                      className="bg-background-hover group-hover/table-row:bg-background-bright"
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
}: {
  canWrite: boolean;
  availableTasks: string[];
  presets: ApiKeyPreset[] | null;
}) {
  const fetcher = useTypedFetcher<typeof action>();
  const actionData = fetcher.data as ApiKeyActionData | undefined;
  const [showError, setShowError] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState<Date>();
  const defaultPresetId = presets?.find((preset) => preset.available)?.id ?? "FULL_ACCESS";
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

  const usesTaskSelection =
    presets?.find((preset) => preset.id === presetId)?.usesTaskSelection ?? false;
  const needsSelectedTask = usesTaskSelection && taskScope === "selected";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setName("");
          setExpiresAt(undefined);
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
      <DialogContent className="max-w-xl">
        <DialogHeader>New API key</DialogHeader>
        {createdApiKey ? (
          <div className="flex flex-col gap-3 pt-3">
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
            <Fieldset className="mt-3 max-h-[70vh] overflow-y-auto pr-1">
              <InputGroup>
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

              <InputGroup>
                <Label>Expiration</Label>
                <DateTimePicker
                  label="API key expiration"
                  value={expiresAt}
                  onChange={setExpiresAt}
                  showSeconds={false}
                  showClearButton
                />
                <Hint>Leave blank for a key that doesn&apos;t expire.</Hint>
              </InputGroup>

              {presets ? (
                <InputGroup>
                  <Label>Access</Label>
                  <RadioGroup value={presetId} onValueChange={setPresetId} className="grid gap-2">
                    {presets.map((preset) => (
                      <RadioGroupItem
                        key={preset.id}
                        id={`api-key-access-${preset.id}`}
                        value={preset.id}
                        variant="description"
                        label={preset.label}
                        description={preset.description}
                        disabled={!preset.available}
                        badges={preset.available ? undefined : ["Upgrade"]}
                      />
                    ))}
                  </RadioGroup>
                </InputGroup>
              ) : null}

              {usesTaskSelection ? (
                <InputGroup>
                  <Label>Tasks</Label>
                  <RadioGroup
                    value={taskScope}
                    onValueChange={(value) => setTaskScope(value as "all" | "selected")}
                    className="grid gap-2"
                  >
                    <RadioGroupItem
                      id="api-key-task-scope-all"
                      value="all"
                      variant="simple/small"
                      label="All tasks"
                    />
                    <RadioGroupItem
                      id="api-key-task-scope-selected"
                      value="selected"
                      variant="simple/small"
                      label="Selected tasks"
                      disabled={availableTasks.length === 0}
                    />
                  </RadioGroup>

                  {taskScope === "selected" ? (
                    <div className="max-h-48 space-y-2 overflow-y-auto rounded border border-grid-dimmed p-3">
                      {availableTasks.map((taskIdentifier) => (
                        <CheckboxWithLabel
                          key={taskIdentifier}
                          id={`api-key-task-${taskIdentifier}`}
                          name="taskIdentifiers"
                          value={taskIdentifier}
                          variant="simple/small"
                          label={<span className="font-mono">{taskIdentifier}</span>}
                          defaultChecked={selectedTasks.includes(taskIdentifier)}
                          onChange={(checked) => {
                            setSelectedTasks((current) =>
                              checked
                                ? [...new Set([...current, taskIdentifier])]
                                : current.filter((task) => task !== taskIdentifier)
                            );
                          }}
                        />
                      ))}
                    </div>
                  ) : null}
                  <Hint>
                    Task restrictions use task identifiers and continue to apply across deployments.
                  </Hint>
                </InputGroup>
              ) : null}

              {showError && actionData && !actionData.ok ? (
                <Paragraph variant="small" className="text-error">
                  {actionData.error}
                </Paragraph>
              ) : null}

              <FormButtons
                confirmButton={
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
                }
                cancelButton={
                  <DialogClose asChild>
                    <Button variant="tertiary/small">Cancel</Button>
                  </DialogClose>
                }
              />
            </Fieldset>
          </fetcher.Form>
        )}
      </DialogContent>
    </Dialog>
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
