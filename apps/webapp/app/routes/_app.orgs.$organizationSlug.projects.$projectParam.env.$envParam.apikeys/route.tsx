import { BookOpenIcon, PencilSquareIcon, PlusIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Outlet, useLocation, useParams, useRevalidator, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import { type UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { env } from "~/env.server";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { CopyableText } from "~/components/primitives/CopyableText";
import { CodeBlock } from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import { RegenerateApiKeyModal } from "~/components/environments/RegenerateApiKeyModal";
import { EnvironmentCombo, environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { LegacyBadge } from "~/components/FeatureBadges";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { PermissionDenied } from "~/components/PermissionDenied";
import { StepContentContainer } from "~/components/StepContentContainer";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { CopyButton } from "~/components/primitives/CopyButton";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { StepNumber } from "~/components/primitives/StepNumber";
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
import { InfoIconTooltip, SimpleTooltip } from "~/components/primitives/Tooltip";
import { TruncatedText } from "~/components/primitives/TruncatedText";
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
import { apiKeyExpiryEndDay } from "~/utils/apiKeyExpiry";
import { secretKeyPlaceholder } from "~/utils/apiKeyPrefix";
import { ApiKeyAccessCell } from "./ApiKeyAccessCell";
import {
  apiKeyCreator,
  DisableRootApiKeyButton,
  editableApiKey,
  RevokeApiKeyButton,
  ROOT_API_KEY_PARAM,
} from "./ApiKeyActions";
import { apiKeyStatus, ApiKeyStatusCombo } from "./ApiKeyStatus";
import { ApiKeyAllowedIps, ApiKeyLastUsed, EditApiKeyIpRangesButton } from "./ApiKeyIpRanges";
import { ApiKeyNameCell, EditApiKeyNoteButton } from "./ApiKeyNote";
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
        // The dashboard checks IP ranges with the same rule the server applies on save.
        allowPrivateIpRanges: env.API_KEY_ALLOW_PRIVATE_IP_RANGES,
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
  allowPrivateIpRanges: boolean;
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
    allowPrivateIpRanges,
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
  // Cells take the selected style too, so a selected row keeps it on hover (see deployments).
  const isRootSelected = apiKeyParam === ROOT_API_KEY_PARAM;
  const rowPath = (apiKeyId: string) =>
    `${v3ApiKeyPath(organization, project, currentEnvironment, apiKeyId)}${location.search}`;

  const apiKeyEnvironmentLabel = {
    ...environment,
    branchName:
      environment.type === "DEVELOPMENT" || environment.type === "PREVIEW"
        ? null
        : environment.branchName,
  };

  // The dialog shows a placeholder, not the root key: use one of your API keys instead.
  const keyPlaceholder = secretKeyPlaceholder(environment.type);
  const envBlock = [
    `TRIGGER_SECRET_KEY="${keyPlaceholder}"`,
    environment.branchName ? `TRIGGER_PREVIEW_BRANCH="${environment.branchName}"` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const hasUsableApiKey = apiKeys.some(
    (apiKey) =>
      !apiKey.revokedAt && !(apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() <= loadedAt)
  );
  const showCreateApiKeyPrompt = rootApiKey?.isHidden === true && !hasUsableApiKey;
  const canManageRootApiKey = canWriteApiKeys || rootApiKey?.isHidden === false;
  const canLimitAccess = isRbacPluginAvailable && presets !== null;
  const chooseAccessHint = canLimitAccess ? ", and choose what it can access" : "";
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
    allowPrivateIpRanges,
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
      {/* One grid row: the root key banner overlaps the nav bar's bottom line by 1px. */}
      <div>
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
        {rootApiKey && !rootApiKey.isHidden ? (
          // Opaque, so the overlapped line matches the banner's bottom border exactly.
          <div className="relative -mt-px bg-background-dimmed">
            <Callout
              variant="warning"
              className="rounded-none border-x-0 shadow-none backdrop-blur-none"
              cta={
                <Button
                  variant="warning/small"
                  disabled={!canWriteApiKeys}
                  tooltip={
                    canWriteApiKeys ? undefined : "You don't have permission to manage API keys"
                  }
                  onClick={() => setMigrationOpen(true)}
                >
                  Replace root key…
                </Button>
              }
            >
              {`Root keys are being phased out. Replace yours with API keys you can ${canLimitAccess ? "limit and " : ""}revoke one at a time.`}
            </Callout>
          </div>
        ) : null}
      </div>
      <PageBody scrollable={false}>
        {canReadApiKeys ? (
          <ResizablePanelGroup orientation="horizontal" className="max-h-full">
            <ResizablePanel id="api-keys-main" min="100px">
              {/* Like the Tasks page: the table fills the rest of the panel and scrolls both ways, so
                  its horizontal scrollbar sits at the bottom of the page even when it has few rows. */}
              <div className="flex h-full min-w-0 flex-col overflow-hidden">
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
                  allowPrivateIpRanges={allowPrivateIpRanges}
                  environment={apiKeyEnvironmentLabel}
                >
                  {(openCreateApiKey) => (
                    <>
                      <div className="flex h-fit shrink-0 flex-wrap items-center justify-end gap-2 px-2 py-2">
                        <EnvironmentVariablesDialog
                          environment={apiKeyEnvironmentLabel}
                          envBlock={envBlock}
                          secretKeyPlaceholder={keyPlaceholder}
                          canWrite={canWriteApiKeys}
                          onCreateApiKey={openCreateApiKey}
                        />
                        <RevokedFilter checked={showRevoked} />
                        {showCreateApiKeyPrompt ? null : (
                          <NewApiKeyButton canWrite={canWriteApiKeys} variant="primary/small" />
                        )}
                      </div>

                      <Table containerClassName="min-h-0 flex-1">
                        <ApiKeyTableHeader
                          showRevoked={showRevoked}
                          showSecretKey={!isShowingInspector}
                        />
                        <TableBody>
                          {rootApiKey ? (
                            <TableRow isSelected={isRootSelected}>
                              <TableCell
                                to={rowPath(ROOT_API_KEY_PARAM)}
                                isSelected={isRootSelected}
                                isTabbableCell
                              >
                                <div className="flex items-center gap-1.5">
                                  {rootApiKey.name}
                                  <LegacyBadge tooltip="Replace with API keys you can revoke one at a time." />
                                </div>
                              </TableCell>
                              {isShowingInspector ? null : (
                                <TableCell isSelected={isRootSelected}>
                                  {/* -my-1: the copy button is taller than a line of text, so this
                                      keeps the row the same height as the others. */}
                                  <div className="-my-1 flex items-center gap-1">
                                    <span className="font-mono">{rootApiKey.obfuscated}</span>
                                    {rootApiKey.value ? (
                                      <CopyButton
                                        value={rootApiKey.value}
                                        variant="icon"
                                        size="small"
                                      />
                                    ) : (
                                      <InfoIconTooltip
                                        disableHoverableContent
                                        content={`Root keys are being phased out. Create a new API key instead${chooseAccessHint}.`}
                                        contentClassName="max-w-xs"
                                      />
                                    )}
                                  </div>
                                </TableCell>
                              )}
                              <TableCell
                                to={rowPath(ROOT_API_KEY_PARAM)}
                                isSelected={isRootSelected}
                              >
                                <ApiKeyStatusCombo status="ACTIVE" className="text-xs" />
                              </TableCell>
                              <TableCell
                                to={rowPath(ROOT_API_KEY_PARAM)}
                                isSelected={isRootSelected}
                              >
                                <ApiKeyAccessCell label="No restrictions" />
                              </TableCell>
                              <TableCell
                                to={rowPath(ROOT_API_KEY_PARAM)}
                                isSelected={isRootSelected}
                              >
                                <ApiKeyAllowedIps ranges={[]} />
                              </TableCell>
                              <TableCell
                                to={rowPath(ROOT_API_KEY_PARAM)}
                                isSelected={isRootSelected}
                              >
                                –
                              </TableCell>
                              <TableCell
                                to={rowPath(ROOT_API_KEY_PARAM)}
                                isSelected={isRootSelected}
                              >
                                –
                              </TableCell>
                              <TableCell
                                to={rowPath(ROOT_API_KEY_PARAM)}
                                isSelected={isRootSelected}
                              >
                                –
                              </TableCell>
                              <TableCell
                                to={rowPath(ROOT_API_KEY_PARAM)}
                                isSelected={isRootSelected}
                              >
                                Never
                              </TableCell>
                              {showRevoked ? (
                                <TableCell
                                  to={rowPath(ROOT_API_KEY_PARAM)}
                                  isSelected={isRootSelected}
                                >
                                  –
                                </TableCell>
                              ) : null}
                              <TableCellMenu
                                isSelected={isRootSelected}
                                isSticky
                                className="w-32"
                                popoverContent={
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
                                          canLimitAccess={canLimitAccess}
                                          appearance="menu"
                                        />
                                      ) : null}
                                      {rootApiKey.isHidden ? null : (
                                        <DisableRootApiKeyButton
                                          canWrite={canWriteApiKeys}
                                          appearance="menu"
                                        />
                                      )}
                                    </>
                                  ) : null
                                }
                              />
                            </TableRow>
                          ) : null}

                          {apiKeys.map((apiKey) => {
                            const status = apiKeyStatus({
                              revokedAt: apiKey.revokedAt,
                              expiresAt: apiKey.expiresAt,
                              now: loadedAt,
                            });
                            const isActive = status === "ACTIVE";
                            const path = rowPath(apiKey.id);
                            const isSelected = apiKeyParam === apiKey.id;

                            return (
                              <TableRow
                                key={apiKey.id}
                                disabled={!isActive}
                                isSelected={isSelected}
                              >
                                <TableCell to={path} isSelected={isSelected} isTabbableCell>
                                  <ApiKeyNameCell
                                    name={apiKey.name}
                                    note={apiKey.description}
                                    className="max-w-[14rem]"
                                  />
                                </TableCell>
                                {isShowingInspector ? null : (
                                  <TableCell to={path} isSelected={isSelected}>
                                    <span className="font-mono">{apiKey.obfuscated}</span>
                                  </TableCell>
                                )}
                                <TableCell to={path} isSelected={isSelected}>
                                  {apiKey.revokedAt ? (
                                    <SimpleTooltip
                                      asChild
                                      disableHoverableContent
                                      button={
                                        // A span trigger, not a button, inside the row's link.
                                        <span>
                                          <ApiKeyStatusCombo status={status} className="text-xs" />
                                        </span>
                                      }
                                      content={
                                        <>
                                          Revoked{" "}
                                          <DateTime date={apiKey.revokedAt} showTooltip={false} />
                                        </>
                                      }
                                    />
                                  ) : (
                                    <ApiKeyStatusCombo status={status} className="text-xs" />
                                  )}
                                </TableCell>
                                <TableCell to={path} isSelected={isSelected}>
                                  <ApiKeyAccessCell
                                    label={apiKey.access.label}
                                    taskIdentifiers={apiKey.access.taskIdentifiers}
                                    usesTaskSelection={apiKey.access.usesTaskSelection}
                                    isCustom={apiKey.access.isCustom}
                                    capabilities={apiKey.access.capabilities}
                                    unmatchedScopes={apiKey.access.unmatchedScopes}
                                    catalogue={capabilityCatalogue}
                                    presets={presets}
                                    hasDrift={apiKey.access.drift.length > 0}
                                  />
                                </TableCell>
                                <TableCell to={path} isSelected={isSelected}>
                                  <ApiKeyAllowedIps ranges={apiKey.allowedIpRanges} />
                                </TableCell>
                                <TableCell to={path} isSelected={isSelected}>
                                  <TruncatedText
                                    text={apiKeyCreator(apiKey)}
                                    className="block max-w-[10rem]"
                                  />
                                </TableCell>
                                <TableCell to={path} isSelected={isSelected}>
                                  <DateTime date={apiKey.createdAt} includeSeconds={false} />
                                </TableCell>
                                <TableCell to={path} isSelected={isSelected}>
                                  <ApiKeyLastUsed
                                    lastUsedAt={apiKey.lastUsedAt}
                                    lastUsedIp={apiKey.lastUsedIp}
                                  />
                                </TableCell>
                                <TableCell to={path} isSelected={isSelected}>
                                  {apiKey.expiresAt
                                    ? (apiKeyExpiryEndDay(apiKey.expiresAt) ?? (
                                        <DateTime date={apiKey.expiresAt} includeTime={false} />
                                      ))
                                    : "Never"}
                                </TableCell>
                                {showRevoked ? (
                                  <TableCell to={path} isSelected={isSelected}>
                                    {apiKey.revokedAt ? (
                                      <DateTime date={apiKey.revokedAt} includeTime={false} />
                                    ) : (
                                      "–"
                                    )}
                                  </TableCell>
                                ) : null}
                                <TableCellMenu
                                  isSelected={isSelected}
                                  isSticky
                                  className="w-32"
                                  popoverContent={
                                    isActive ? (
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
                                          allowPrivateIpRanges={allowPrivateIpRanges}
                                        />
                                        <EditApiKeyNoteButton
                                          id={apiKey.id}
                                          name={apiKey.name}
                                          note={apiKey.description}
                                          canWrite={canWriteApiKeys}
                                          appearance="menu"
                                        />
                                        <RevokeApiKeyButton
                                          id={apiKey.id}
                                          name={apiKey.name}
                                          canWrite={canWriteApiKeys}
                                        />
                                      </>
                                    ) : status === "EXPIRED" ? (
                                      // Expired keys can't be changed, but revoking takes them off the list.
                                      <RevokeApiKeyButton
                                        id={apiKey.id}
                                        name={apiKey.name}
                                        canWrite={canWriteApiKeys}
                                      />
                                    ) : null
                                  }
                                />
                              </TableRow>
                            );
                          })}

                          {showCreateApiKeyPrompt ? (
                            <TableBlankRow
                              colSpan={(showRevoked ? 11 : 10) - (isShowingInspector ? 1 : 0)}
                            >
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

function ApiKeyTableHeader({
  showRevoked,
  showSecretKey,
}: {
  showRevoked: boolean;
  /** Hidden while the inspector is open, which shows it, so Access stays in view. */
  showSecretKey: boolean;
}) {
  return (
    <TableHeader>
      <TableRow>
        <TableHeaderCell>Name</TableHeaderCell>
        {showSecretKey ? <TableHeaderCell>Secret key</TableHeaderCell> : null}
        <TableHeaderCell>Status</TableHeaderCell>
        <TableHeaderCell>Access</TableHeaderCell>
        <TableHeaderCell>Allowed IPs</TableHeaderCell>
        <TableHeaderCell>Created by</TableHeaderCell>
        <TableHeaderCell>Created</TableHeaderCell>
        <TableHeaderCell>Last used</TableHeaderCell>
        <TableHeaderCell>Expiry</TableHeaderCell>
        {showRevoked ? <TableHeaderCell>Revoked</TableHeaderCell> : null}
        <TableHeaderCell className="w-32" hiddenLabel>
          Actions
        </TableHeaderCell>
      </TableRow>
    </TableHeader>
  );
}

function EnvironmentVariablesDialog({
  environment,
  envBlock,
  secretKeyPlaceholder,
  canWrite,
  onCreateApiKey,
}: {
  environment: React.ComponentProps<typeof EnvironmentCombo>["environment"];
  envBlock: string;
  secretKeyPlaceholder: string;
  canWrite: boolean;
  onCreateApiKey: () => void;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary/small">How to set env vars</Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader className="flex flex-row items-center gap-1.5">
          Set environment variables
          <EnvironmentCombo
            environment={environment}
            className="text-base"
            iconClassName="size-5"
          />
        </DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          {environment.type === "DEVELOPMENT" ? (
            <Callout variant="info">
              Every team member gets their own dev API keys. Make sure you're using one from this
              page, otherwise you will trigger runs on your team member's machine.
            </Callout>
          ) : null}
          <Paragraph>
            Set these in the app that triggers your tasks, so the SDK can authenticate with
            Trigger.dev. Replace <InlineCode variant="small">{secretKeyPlaceholder}</InlineCode>{" "}
            with one of your API keys. Its full value is only shown when you create it.
          </Paragraph>
          <CodeBlock
            language="javascript"
            code={envBlock}
            showOpenInModal={false}
            showLineNumbers={false}
          />
          <FormButtons
            cancelButton={
              <DialogClose asChild>
                <Button variant="secondary/medium">Close</Button>
              </DialogClose>
            }
            confirmButton={
              <DialogClose asChild>
                <Button
                  variant="primary/medium"
                  LeadingIcon={PlusIcon}
                  disabled={!canWrite}
                  tooltip={canWrite ? undefined : "You don't have permission to create API keys"}
                  onClick={onCreateApiKey}
                >
                  Create API key
                </Button>
              </DialogClose>
            }
          />
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
        <DialogHeader>Replace your root key</DialogHeader>
        <div className="flex flex-col gap-4 pt-4">
          <Paragraph variant="base/bright">
            Use a separate API key for each app that triggers your tasks, so you can revoke each one
            on its own. Your root key keeps working until you hide it.
          </Paragraph>
          <div>
            <StepNumber stepNumber="1" title="Create an API key" />
            <StepContentContainer>
              <Paragraph variant="small" spacing>
                Create one for each app that triggers your tasks.
              </Paragraph>
              <Button variant="primary/small" disabled={!canWrite} onClick={onCreateApiKey}>
                Create API key…
              </Button>
            </StepContentContainer>
            <StepNumber
              stepNumber="2"
              title={
                <>
                  Update <InlineCode variant="small">TRIGGER_SECRET_KEY</InlineCode>
                </>
              }
            />
            <StepContentContainer>
              <Paragraph variant="small">
                Set it to the new key, then check everything works.
              </Paragraph>
            </StepContentContainer>
            <StepNumber stepNumber="3" title="Hide the root key" />
            <StepContentContainer className="mb-0">
              <Paragraph variant="small" spacing>
                It stops working 24 hours later.
              </Paragraph>
              {hasUsableApiKey ? (
                <DisableRootApiKeyButton canWrite={canWrite} />
              ) : (
                <Paragraph variant="small">
                  Create an API key before completing this step.
                </Paragraph>
              )}
            </StepContentContainer>
          </div>
          <FormButtons
            cancelButton={
              <DialogClose asChild>
                <Button variant="secondary/medium">Close</Button>
              </DialogClose>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
