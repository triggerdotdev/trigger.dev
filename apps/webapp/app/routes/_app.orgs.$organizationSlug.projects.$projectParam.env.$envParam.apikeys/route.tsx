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
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { CopyableText } from "~/components/primitives/CopyableText";
import { CodeBlock } from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import { RegenerateApiKeyModal } from "~/components/environments/RegenerateApiKeyModal";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { PermissionDenied } from "~/components/PermissionDenied";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { CopyButton } from "~/components/primitives/CopyButton";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
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
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import { MAX_API_KEY_TASK_IDENTIFIERS } from "~/consts";
import {
  createEnvironmentApiKey,
  disableRootApiKeyVisibility,
  revokeEnvironmentApiKey,
} from "~/models/api-key.server";
import {
  redirectWithErrorMessage,
  redirectWithSuccessMessage,
  typedJsonWithErrorMessage,
  typedJsonWithSuccessMessage,
} from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { ApiKeysPresenter } from "~/presenters/v3/ApiKeysPresenter.server";
import { validateCreateApiKeyPreset } from "~/services/apiKeyPresetValidation.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { rbac } from "~/services/rbac.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { docsPath, EnvironmentParamSchema } from "~/utils/pathBuilder";
import { sectionAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import { WhenAgentUnavailable } from "~/components/dashboard-agent/WhenAgentUnavailable";
import type { Handle } from "~/utils/handle";
import { NewApiKeyDialog } from "./NewApiKeyDialog";

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

const DISABLE_ROOT_API_KEY_VISIBILITY_CONFIRMATION = "disable root key visibility";

const ApiKeyActionSchema = z.discriminatedUnion("action", [
  CreateApiKeySchema,
  z.object({ action: z.literal("revoke"), apiKeyId: z.string().min(1) }),
  z.object({
    action: z.literal("disable-root"),
    confirmation: z.literal(DISABLE_ROOT_API_KEY_VISIBILITY_CONFIRMATION),
  }),
]);

export type ApiKeyActionData =
  | { ok: true; action: "create"; apiKey: string }
  | { ok: false; error: string };

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    searchParams: ApiKeySearchParams,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
  },
  async ({ params, searchParams, user, ability }) => {
    try {
      const presenter = new ApiKeysPresenter();
      const [data, isRbacPluginAvailable] = await Promise.all([
        presenter.call({
          userId: user.id,
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectParam,
          environmentSlug: params.envParam,
          showRevoked: searchParams.showRevoked,
        }),
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
        rootApiKey: canReadApiKeys ? data.rootApiKey : null,
        apiKeys: canReadApiKeys ? data.apiKeys : [],
        canReadApiKeys,
        canWriteApiKeys,
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
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
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
        case "disable-root": {
          await disableRootApiKeyVisibility({
            environmentId: keyEnvironmentId,
            userId: user.id,
          });

          return redirectWithSuccessMessage(
            returnPath,
            request,
            "Root API key visibility disabled"
          );
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
  const [createApiKeyOpen, setCreateApiKeyOpen] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [returnToMigration, setReturnToMigration] = useState(false);
  const {
    environment,
    rootApiKey,
    apiKeys,
    canReadApiKeys,
    canWriteApiKeys,
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

  const hasUsableApiKey = apiKeys.some(
    (apiKey) =>
      !apiKey.revokedAt && !(apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() <= loadedAt)
  );
  const showCreateApiKeyPrompt = rootApiKey?.isHidden === true && !hasUsableApiKey;
  const canManageRootApiKey = canWriteApiKeys || rootApiKey?.isHidden === false;
  const chooseAccessHint =
    isRbacPluginAvailable && presets !== null ? ", and choose what it can access" : "";

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
            {/* The dialog wraps both triggers so it stays mounted when creating the first key swaps
                the empty state for the table: the new key is only shown once, in this dialog. */}
            <NewApiKeyDialog
              open={createApiKeyOpen}
              onOpenChange={(open) => {
                setCreateApiKeyOpen(open);
                if (!open && returnToMigration) {
                  setReturnToMigration(false);
                  setMigrationOpen(true);
                }
              }}
              availableTasks={availableTasks}
              presets={presets}
              isRbacPluginAvailable={isRbacPluginAvailable}
              environment={apiKeyEnvironmentLabel}
            >
              {(openCreateApiKey) => (
                <>
                  <div className="flex h-fit items-center justify-end gap-2 p-3">
                    <div className="flex items-center gap-2">
                      {envBlock ? (
                        <EnvironmentVariablesDialog
                          environmentType={environment.type}
                          envBlock={envBlock}
                        />
                      ) : null}
                      <RevokedFilter checked={showRevoked} />
                      {showCreateApiKeyPrompt ? null : (
                        <NewApiKeyButton canWrite={canWriteApiKeys} variant="primary/small" />
                      )}
                    </div>
                  </div>

                  {rootApiKey && !rootApiKey.isHidden ? (
                    <div className="mx-3 mb-3">
                      <Callout variant="info">
                        <div className="flex flex-col items-start gap-2">
                          <div>
                            <span className="flex flex-wrap items-center gap-2 text-sm text-text-bright">
                              Switch to individually managed API keys
                              <Badge variant="extra-small">Recommended</Badge>
                            </span>
                            <Paragraph variant="small">
                              Create keys you can revoke independently, without rotating your root
                              key.
                            </Paragraph>
                          </div>
                          <Button
                            variant="secondary/small"
                            disabled={!canWriteApiKeys}
                            onClick={() => setMigrationOpen(true)}
                          >
                            Switch to API keys…
                          </Button>
                        </div>
                      </Callout>
                    </div>
                  ) : null}

                  <Table>
                    <ApiKeyTableHeader />
                    <TableBody>
                      {rootApiKey ? (
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
                                {rootApiKey.obfuscated}
                              </span>
                              {rootApiKey.value ? (
                                <CopyButton value={rootApiKey.value} variant="icon" size="small" />
                              ) : (
                                <InfoIconTooltip
                                  content={`Root keys are being phased out. Create a new API key instead${chooseAccessHint}.`}
                                  contentClassName="max-w-xs"
                                />
                              )}
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
                              canManageRootApiKey ? (
                                <>
                                  {canWriteApiKeys ? (
                                    <RegenerateApiKeyModal
                                      id={environment.keyEnvironmentId}
                                      title={environmentFullTitle(apiKeyEnvironmentLabel)}
                                      hasVercelIntegration={hasVercelIntegration}
                                      isDevelopment={environment.type === "DEVELOPMENT"}
                                      isRootApiKeyHidden={rootApiKey.isHidden}
                                      onSwitchToApiKeys={() => setMigrationOpen(true)}
                                    />
                                  ) : null}
                                  {rootApiKey.isHidden ? null : (
                                    <DisableRootApiKeyButton canWrite={canWriteApiKeys} />
                                  )}
                                </>
                              ) : null
                            }
                          />
                        </TableRow>
                      ) : null}

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
                              <span className="font-mono text-text-dimmed">
                                {apiKey.obfuscated}
                              </span>
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

                      {showCreateApiKeyPrompt ? (
                        <TableBlankRow colSpan={8}>
                          <div className="flex flex-col items-center justify-center gap-y-4 py-8">
                            <div className="flex flex-col items-center gap-y-1">
                              <Header2>Create an API key for your backend</Header2>
                              <Paragraph variant="small">
                                {`Root keys are being phased out. Create an API key so your backend can authenticate with Trigger.dev${chooseAccessHint}.`}
                              </Paragraph>
                            </div>
                            <NewApiKeyButton canWrite={canWriteApiKeys} variant="primary/medium" />
                          </div>
                        </TableBlankRow>
                      ) : null}
                    </TableBody>
                  </Table>
                  <RootApiKeyMigrationDialog
                    open={migrationOpen && rootApiKey?.isHidden === false}
                    onOpenChange={setMigrationOpen}
                    canWrite={canWriteApiKeys}
                    hasUsableApiKey={hasUsableApiKey}
                    onCreateApiKey={() => {
                      setMigrationOpen(false);
                      setReturnToMigration(true);
                      openCreateApiKey();
                    }}
                  />
                </>
              )}
            </NewApiKeyDialog>
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

function NewApiKeyButton({
  canWrite,
  variant,
}: {
  canWrite: boolean;
  variant: "primary/small" | "primary/medium";
}) {
  return (
    <DialogTrigger asChild>
      <Button
        variant={variant}
        LeadingIcon={PlusIcon}
        shortcut={{ key: "n" }}
        disabled={!canWrite}
        tooltip={canWrite ? undefined : "You don't have permission to create API keys"}
      >
        Create API key
      </Button>
    </DialogTrigger>
  );
}

function RootApiKeyMigrationDialog({
  open,
  onOpenChange,
  canWrite,
  hasUsableApiKey,
  onCreateApiKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canWrite: boolean;
  hasUsableApiKey: boolean;
  onCreateApiKey: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>Switch to individually managed API keys</DialogHeader>
        <div className="flex flex-col gap-4 pt-4">
          <Paragraph variant="small">
            Your root key keeps working while you make the switch. It only starts expiring when you
            choose to hide it in the final step.
          </Paragraph>
          <ol className="flex flex-col gap-5">
            <li className="flex flex-col items-start gap-2">
              <Header2>1. Create an API key</Header2>
              <Paragraph variant="small">
                Give each application its own named key so you can revoke it independently.
              </Paragraph>
              <Button variant="primary/small" disabled={!canWrite} onClick={onCreateApiKey}>
                Create API key
              </Button>
            </li>
            <li className="flex flex-col gap-2">
              <Header2>2. Update your applications</Header2>
              <Paragraph variant="small">
                Replace the root key in your applications with the new API key and verify everything
                works.
              </Paragraph>
            </li>
            <li className="flex flex-col items-start gap-2">
              <Header2>3. Hide the root key</Header2>
              <Paragraph variant="small">
                Once your applications are using individual keys, permanently hide the root key. The
                current root key will stop working 24 hours later.
              </Paragraph>
              {hasUsableApiKey ? (
                <DisableRootApiKeyButton canWrite={canWrite} />
              ) : (
                <Paragraph variant="small">
                  Create an API key before completing this step.
                </Paragraph>
              )}
            </li>
          </ol>
          <FormButtons
            cancelButton={
              <DialogClose asChild>
                <Button variant="tertiary/medium">Close</Button>
              </DialogClose>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DisableRootApiKeyButton({ canWrite }: { canWrite: boolean }) {
  const [confirmation, setConfirmation] = useState("");

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="minimal/small"
          LeadingIcon={NoSymbolIcon}
          disabled={!canWrite}
          tooltip={
            canWrite ? undefined : "You don't have permission to disable root API key visibility"
          }
        >
          Stop using the root key…
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>Stop using the root API key</DialogHeader>
        <Form method="post" className="flex flex-col gap-4 pt-3">
          <input type="hidden" name="action" value="disable-root" />
          <Callout variant="warning">
            The current root key will stop working in 24 hours. Any application still using it will
            fail to authenticate after that.
          </Callout>
          <div className="space-y-2">
            <Paragraph variant="small">
              Before continuing, replace the root key in your applications with individually managed
              API keys and verify they work. Existing individual API keys are not affected.
            </Paragraph>
            <Paragraph variant="small">
              This generates a new hidden root key and permanently disables full root key
              visibility. This can't be reversed.
            </Paragraph>
          </div>
          <InputGroup className="max-w-full">
            <Paragraph variant="small/bright">
              Enter{" "}
              <InlineCode variant="small">
                {DISABLE_ROOT_API_KEY_VISIBILITY_CONFIRMATION}
              </InlineCode>{" "}
              to confirm:
            </Paragraph>
            <Input
              name="confirmation"
              type="text"
              placeholder={DISABLE_ROOT_API_KEY_VISIBILITY_CONFIRMATION}
              autoComplete="off"
              fullWidth
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </InputGroup>
          <FormButtons
            confirmButton={
              <Button
                type="submit"
                variant="danger/medium"
                disabled={confirmation !== DISABLE_ROOT_API_KEY_VISIBILITY_CONFIRMATION}
              >
                Hide root key and start 24-hour expiry
              </Button>
            }
            cancelButton={
              <DialogClose asChild>
                <Button variant="tertiary/medium">Cancel</Button>
              </DialogClose>
            }
          />
        </Form>
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
