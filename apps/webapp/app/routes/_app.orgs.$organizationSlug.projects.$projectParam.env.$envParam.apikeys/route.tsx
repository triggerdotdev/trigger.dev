import { BookOpenIcon, KeyIcon, PencilSquareIcon, PlusIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Outlet, useLocation, useParams, useRevalidator, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import { type UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { CopyableText } from "~/components/primitives/CopyableText";
import { CodeBlock } from "~/components/code/CodeBlock";
import { RegenerateApiKeyModal } from "~/components/environments/RegenerateApiKeyModal";
import {
  type EnvironmentCombo,
  environmentFullTitle,
} from "~/components/environments/EnvironmentLabel";
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
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  RESIZABLE_PANEL_ANIMATION,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  collapsibleHandleClassName,
} from "~/components/primitives/Resizable";
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
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { ApiKeysPresenter } from "~/presenters/v3/ApiKeysPresenter.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { rbac } from "~/services/rbac.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { docsPath, EnvironmentParamSchema, v3ApiKeyPath, v3ApiKeysPath } from "~/utils/pathBuilder";
import { sectionAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import { WhenAgentUnavailable } from "~/components/dashboard-agent/WhenAgentUnavailable";
import type { Handle } from "~/utils/handle";
import { uneditableApiKeyMessage } from "~/utils/apiKeyAccess";
import { ApiKeyAccessCell } from "./ApiKeyAccessCell";
import {
  ApiKeyStatus,
  apiKeyCreator,
  DisableRootApiKeyButton,
  editableApiKey,
  RevokeApiKeyButton,
  ROOT_API_KEY_PARAM,
} from "./ApiKeyActions";
import { ApiKeyAllowedIps, ApiKeyLastUsed, EditApiKeyIpRangesButton } from "./ApiKeyIpRanges";
import { apiKeysAction, canManageOrganizationPresets } from "./apiKeysAction.server";
import { EditApiKeyAccessDialog, type EditableApiKey } from "./EditApiKeyAccessDialog";
import { NewApiKeyDialog } from "./NewApiKeyDialog";

export type { ApiKeyActionData } from "./apiKeysAction.server";

export const handle: Handle = {
  agentPageContext: () => sectionAgentPageContext("apikeys"),
};

import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta("API keys");

const ApiKeySearchParams = z.object({
  showRevoked: z.preprocess((value) => value === "true" || value === true, z.boolean()).optional(),
});

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    searchParams: ApiKeySearchParams,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
  },
  async ({ request, params, searchParams, user, ability, context }) => {
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
        presets: canReadApiKeys ? data.presets : [],
        capabilityCatalogue: canReadApiKeys ? data.capabilityCatalogue : null,
        canReadApiKeys,
        canWriteApiKeys,
        canManagePresets:
          canWriteApiKeys &&
          (await canManageOrganizationPresets(request, user.id, context.organizationId)),
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

export const action = apiKeysAction;

export type ApiKeysOutletContext = {
  apiKeys: ApiKeysData["apiKeys"];
  rootApiKey: ApiKeysData["rootApiKey"];
  environment: ApiKeysData["environment"];
  environmentLabel: React.ComponentProps<typeof EnvironmentCombo>["environment"];
  availableTasks: string[];
  presets: ApiKeysData["presets"];
  capabilityCatalogue: ApiKeysData["capabilityCatalogue"];
  isRbacPluginAvailable: boolean;
  canWriteApiKeys: boolean;
  canManagePresets: boolean;
  canEditAccess: boolean;
  canManageRootApiKey: boolean;
  hasVercelIntegration: boolean;
  loadedAt: number;
  listPath: string;
  openMigration: () => void;
};

type ApiKeysData = UseDataFunctionReturn<typeof loader>;

export default function Page() {
  const [createApiKeyOpen, setCreateApiKeyOpen] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [returnToMigration, setReturnToMigration] = useState(false);
  const [editing, setEditing] = useState<EditableApiKey | null>(null);
  const data = useTypedLoaderData<typeof loader>();
  const {
    environment,
    rootApiKey,
    apiKeys,
    canReadApiKeys,
    canWriteApiKeys,
    canManagePresets,
    isRbacPluginAvailable,
    showRevoked,
    hasVercelIntegration,
    availableTasks,
    presets,
    capabilityCatalogue,
    loadedAt,
  } = data;
  const revalidator = useRevalidator();
  const location = useLocation();
  const organization = useOrganization();
  const project = useProject();
  const currentEnvironment = useEnvironment();
  const { apiKeyParam } = useParams();
  const isShowingInspector = !!apiKeyParam;
  const listPath = v3ApiKeysPath(organization, project, currentEnvironment);
  const rowPath = (apiKeyId: string) =>
    `${v3ApiKeyPath(organization, project, currentEnvironment, apiKeyId)}${location.search}`;

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
  const canEditAccess =
    canWriteApiKeys && isRbacPluginAvailable && presets !== null && capabilityCatalogue !== null;

  function editAccess(apiKey: (typeof apiKeys)[number]) {
    revalidator.revalidate();
    setEditing(editableApiKey(apiKey));
  }

  const outletContext: ApiKeysOutletContext = {
    apiKeys,
    rootApiKey,
    environment,
    environmentLabel: apiKeyEnvironmentLabel,
    availableTasks,
    presets,
    capabilityCatalogue,
    isRbacPluginAvailable,
    canWriteApiKeys,
    canManagePresets,
    canEditAccess,
    canManageRootApiKey,
    hasVercelIntegration,
    loadedAt,
    listPath: `${listPath}${location.search}`,
    openMigration: () => setMigrationOpen(true),
  };

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
            <LinkButton variant="docs/small" LeadingIcon={BookOpenIcon} to={docsPath("/apikeys")}>
              API keys docs
            </LinkButton>
          </WhenAgentUnavailable>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        {canReadApiKeys ? (
          <ResizablePanelGroup orientation="horizontal" className="max-h-full">
            <ResizablePanel id="api-keys-main" min="100px">
              <div className="max-h-full min-h-full overflow-y-auto border-t border-grid-dimmed">
                {/* The dialog wraps both triggers so it stays mounted when creating the first key swaps
                    the empty state for the table: the new key is only shown once, in this dialog. */}
                <NewApiKeyDialog
                  open={createApiKeyOpen}
                  onOpenChange={(open) => {
                    setCreateApiKeyOpen(open);
                    if (open) revalidator.revalidate();
                    if (!open && returnToMigration) {
                      setReturnToMigration(false);
                      setMigrationOpen(true);
                    }
                  }}
                  availableTasks={availableTasks}
                  presets={presets}
                  capabilityCatalogue={capabilityCatalogue}
                  isRbacPluginAvailable={isRbacPluginAvailable}
                  canManagePresets={canManagePresets}
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
                                  Create keys you can revoke independently, without rotating your
                                  root key.
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
                            <TableRow
                              className="h-[3.25rem] [&_td]:py-2"
                              isSelected={apiKeyParam === ROOT_API_KEY_PARAM}
                            >
                              <TableCell to={rowPath(ROOT_API_KEY_PARAM)} isTabbableCell>
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
                                    <CopyButton
                                      value={rootApiKey.value}
                                      variant="icon"
                                      size="small"
                                    />
                                  ) : (
                                    <InfoIconTooltip
                                      content={`Root keys are being phased out. Create a new API key instead${chooseAccessHint}.`}
                                      contentClassName="max-w-xs"
                                    />
                                  )}
                                </div>
                              </TableCell>
                              <TableCell to={rowPath(ROOT_API_KEY_PARAM)}>
                                <ApiKeyStatus now={loadedAt} />
                              </TableCell>
                              <TableCell to={rowPath(ROOT_API_KEY_PARAM)}>
                                <ApiKeyAccessCell label="No restrictions" />
                              </TableCell>
                              <TableCell to={rowPath(ROOT_API_KEY_PARAM)}>
                                <ApiKeyAllowedIps ranges={[]} />
                              </TableCell>
                              <TableCell to={rowPath(ROOT_API_KEY_PARAM)}>–</TableCell>
                              <TableCell to={rowPath(ROOT_API_KEY_PARAM)}>–</TableCell>
                              <TableCell to={rowPath(ROOT_API_KEY_PARAM)}>–</TableCell>
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
                            const cannotRevoke = Boolean(apiKey.revokedAt) || isExpired;
                            const path = rowPath(apiKey.id);

                            return (
                              <TableRow
                                key={apiKey.id}
                                disabled={cannotRevoke}
                                isSelected={apiKeyParam === apiKey.id}
                                className="h-[3.25rem] [&_td]:py-2"
                              >
                                <TableCell to={path} isTabbableCell>
                                  {apiKey.name}
                                </TableCell>
                                <TableCell to={path}>
                                  <span className="font-mono text-text-dimmed">
                                    {apiKey.obfuscated}
                                  </span>
                                </TableCell>
                                <TableCell to={path}>
                                  <ApiKeyStatus
                                    revokedAt={apiKey.revokedAt}
                                    expiresAt={apiKey.expiresAt}
                                    now={loadedAt}
                                  />
                                </TableCell>
                                <TableCell to={path}>
                                  <ApiKeyAccessCell
                                    label={apiKey.access.label}
                                    taskIdentifiers={apiKey.access.taskIdentifiers}
                                    usesTaskSelection={apiKey.access.usesTaskSelection}
                                    isCustom={apiKey.access.isCustom}
                                    capabilities={apiKey.access.capabilities}
                                    catalogue={capabilityCatalogue}
                                    presets={presets}
                                    hasDrift={apiKey.access.drift.length > 0}
                                  />
                                </TableCell>
                                <TableCell>
                                  <ApiKeyAllowedIps ranges={apiKey.allowedIpRanges} />
                                </TableCell>
                                <TableCell to={path}>{apiKeyCreator(apiKey)}</TableCell>
                                <TableCell to={path}>
                                  <DateTime date={apiKey.createdAt} />
                                </TableCell>
                                <TableCell to={path}>
                                  <ApiKeyLastUsed
                                    lastUsedAt={apiKey.lastUsedAt}
                                    lastUsedIp={apiKey.lastUsedIp}
                                  />
                                </TableCell>
                                <TableCellMenu
                                  isSticky
                                  className="w-32"
                                  popoverContent={
                                    cannotRevoke ? null : (
                                      <>
                                        {canEditAccess ? (
                                          <Button
                                            variant="small-menu-item"
                                            LeadingIcon={PencilSquareIcon}
                                            fullWidth
                                            textAlignLeft
                                            className="w-full px-1.5 py-[0.9rem]"
                                            onClick={() => editAccess(apiKey)}
                                          >
                                            Edit access…
                                          </Button>
                                        ) : null}
                                        <EditApiKeyIpRangesButton
                                          id={apiKey.id}
                                          name={apiKey.name}
                                          ranges={apiKey.allowedIpRanges}
                                          lastUsedIp={apiKey.lastUsedIp}
                                          canWrite={canWriteApiKeys}
                                        />
                                        <RevokeApiKeyButton
                                          id={apiKey.id}
                                          name={apiKey.name}
                                          canWrite={canWriteApiKeys}
                                        />
                                      </>
                                    )
                                  }
                                />
                              </TableRow>
                            );
                          })}

                          {showCreateApiKeyPrompt ? (
                            <TableBlankRow colSpan={9}>
                              <div className="flex flex-col items-center justify-center gap-y-4 py-8">
                                <div className="flex flex-col items-center gap-y-1">
                                  <Header2>Create an API key for your backend</Header2>
                                  <Paragraph variant="small">
                                    {`Root keys are being phased out. Create an API key so your backend can authenticate with Trigger.dev${chooseAccessHint}.`}
                                  </Paragraph>
                                </div>
                                <NewApiKeyButton
                                  canWrite={canWriteApiKeys}
                                  variant="primary/medium"
                                />
                              </div>
                            </TableBlankRow>
                          ) : null}
                        </TableBody>
                      </Table>
                      {editing ? (
                        <EditApiKeyAccessDialog
                          key={editing.id}
                          apiKey={editing}
                          uneditableMessage={uneditableApiKeyMessage(
                            apiKeys.find((apiKey) => apiKey.id === editing.id),
                            loadedAt
                          )}
                          open
                          onOpenChange={(open) => {
                            if (!open) setEditing(null);
                          }}
                          availableTasks={availableTasks}
                          presets={presets}
                          capabilityCatalogue={capabilityCatalogue}
                          isRbacPluginAvailable={isRbacPluginAvailable}
                          canManagePresets={canManagePresets}
                          environment={apiKeyEnvironmentLabel}
                          now={loadedAt}
                        />
                      ) : null}
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
            </ResizablePanel>
            <ResizableHandle
              id="api-keys-handle"
              className={collapsibleHandleClassName(isShowingInspector)}
            />
            <ResizablePanel
              id="api-keys-inspector"
              min="450px"
              default="500px"
              className="overflow-hidden"
              collapsible
              collapsed={!isShowingInspector}
              onCollapseChange={() => {}}
              collapsedSize="0px"
              collapseAnimation={RESIZABLE_PANEL_ANIMATION}
            >
              <div className="h-full" style={{ minWidth: 450 }}>
                <Outlet context={outletContext} />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
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
        <TableHeaderCell>Allowed IPs</TableHeaderCell>
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
