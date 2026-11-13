import { PencilSquareIcon } from "@heroicons/react/20/solid";
import { useNavigate, useOutletContext, useRevalidator, useSearchParams } from "@remix-run/react";
import { type ApiKeyCapabilityCatalogue } from "@trigger.dev/plugins";
import { type ReactNode, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { EnvironmentCombo, environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { RegenerateApiKeyModal } from "~/components/environments/RegenerateApiKeyModal";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyButton } from "~/components/primitives/CopyButton";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { TruncatedText } from "~/components/primitives/TruncatedText";
import { Switch } from "~/components/primitives/Switch";
import { ApiKeyUsagePresenter } from "~/presenters/v3/ApiKeyUsagePresenter.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { driftSummary, uneditableApiKeyMessage } from "~/utils/apiKeyAccess";
import { apiKeyExpiryDayLabel } from "~/utils/apiKeyExpiry";
import { cn } from "~/utils/cn";
import { type ApiKeyUsageView, capabilityUsageLine, narrowToUsage } from "~/utils/apiKeyUsage";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { pageMeta } from "~/utils/pageTitle";
import { ApiKeyAccessLabel } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/ApiKeyAccessCell";
import {
  apiKeyCreator,
  DisableRootApiKeyButton,
  editableApiKey,
  RevokeApiKeyButton,
  ROOT_API_KEY_PARAM,
} from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/ApiKeyActions";
import { CapabilityList } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/ApiKeyCapabilities";
import {
  apiKeyStatus,
  ApiKeyStatusCombo,
} from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/ApiKeyStatus";
import { EditApiKeyIpRangesButton } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/ApiKeyIpRanges";
import { EditApiKeyNoteButton } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/ApiKeyNote";
import { apiKeysAction } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/apiKeysAction.server";
import {
  type EditAccessStart,
  EditApiKeyAccessDialog,
} from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/EditApiKeyAccessDialog";
import type { ApiKeysOutletContext } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route";

export const meta = pageMeta("API keys");

const Params = EnvironmentParamSchema.extend({
  apiKeyParam: z.string(),
});

export const loader = dashboardLoader(
  {
    params: Params,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
  },
  async ({ params, user, ability }) => {
    if (params.apiKeyParam === ROOT_API_KEY_PARAM) {
      return typedjson({ apiKey: null, usage: null });
    }

    const result = await new ApiKeyUsagePresenter().call({
      userId: user.id,
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectParam,
      environmentSlug: params.envParam,
      apiKeyId: params.apiKeyParam,
    });

    if (
      !result.apiKey ||
      !ability.can("read", { type: "apiKeys", envType: result.environmentType })
    ) {
      throw new Response(undefined, { status: 404, statusText: "API key not found" });
    }

    return typedjson({ apiKey: result.apiKey, usage: result.usage });
  }
);

export const action = apiKeysAction;

export default function Page() {
  const { apiKey, usage } = useTypedLoaderData<typeof loader>();
  const context = useOutletContext<ApiKeysOutletContext>();

  if (!apiKey) {
    return <RootApiKeyInspector context={context} />;
  }

  const row = context.apiKeys.find((candidate) => candidate.id === apiKey.id);
  if (!row) {
    return (
      <Inspector title={apiKey.name} closePath={context.listPath}>
        <Group>
          <Property.Table>
            <Property.Item>
              <Property.Label>Status</Property.Label>
              <Property.Value>
                <ApiKeyStatusCombo
                  status={apiKeyStatus({ revokedAt: apiKey.revokedAt, now: context.loadedAt })}
                  className="text-xs"
                />
              </Property.Value>
            </Property.Item>
            {apiKey.revokedAt ? (
              <Property.Item>
                <Property.Label>Revoked</Property.Label>
                <Property.Value>
                  <DateTime date={apiKey.revokedAt} includeSeconds={false} />
                </Property.Value>
              </Property.Item>
            ) : null}
          </Property.Table>
          <ShowRevokedButton />
        </Group>
      </Inspector>
    );
  }

  return <ApiKeyInspector key={row.id} row={row} usage={usage} context={context} />;
}

type ApiKeyRow = ApiKeysOutletContext["apiKeys"][number];

function ApiKeyInspector({
  row,
  usage,
  context,
}: {
  row: ApiKeyRow;
  usage: ApiKeyUsageView | null;
  context: ApiKeysOutletContext;
}) {
  const [showScopes, setShowScopes] = useState(false);
  const [editing, setEditing] = useState<{ start?: EditAccessStart } | null>(null);
  const revalidator = useRevalidator();
  const { capabilityCatalogue: catalogue, loadedAt: now } = context;
  const isExpired = row.expiresAt ? new Date(row.expiresAt).getTime() <= now : false;
  const isActive = !row.revokedAt && !isExpired;
  const canEditAccess = context.canEditAccess && isActive;
  const isRevoked = !!row.revokedAt;
  const { access } = row;
  const expiryLabel = row.expiresAt ? apiKeyExpiryDayLabel(row.expiresAt) : undefined;
  const usageNotes =
    usage && catalogue
      ? Object.fromEntries(
          catalogue.capabilities.flatMap((capability) => {
            const granted = access.fullAccess ? undefined : access.capabilities?.[capability.id];
            if (!access.fullAccess && !granted) return [];
            const line = capabilityUsageLine(capability, granted, usage);
            return [
              [
                capability.id,
                <LabelValue key={capability.id} label={line.label}>
                  {line.lastUsedAt ? (
                    <DateTime date={line.lastUsedAt} includeSeconds={false} />
                  ) : (
                    "Never"
                  )}
                </LabelValue>,
              ],
            ];
          })
        )
      : undefined;

  function editAccess(start?: EditAccessStart) {
    revalidator.revalidate();
    setEditing({ start });
  }

  const revokeButton = (
    <div className="ml-auto">
      <RevokeApiKeyButton
        id={row.id}
        name={row.name}
        canWrite={context.canWriteApiKeys}
        appearance="button"
      />
    </div>
  );

  return (
    <Inspector
      title={row.name}
      closePath={context.listPath}
      footer={
        isActive ? (
          <>
            {context.canEditAccess ? (
              <Button
                variant="secondary/medium"
                LeadingIcon={PencilSquareIcon}
                leadingIconClassName="text-text-dimmed"
                onClick={() => editAccess()}
              >
                Edit access…
              </Button>
            ) : null}
            <EditApiKeyIpRangesButton
              id={row.id}
              name={row.name}
              ranges={row.allowedIpRanges}
              lastUsedIp={row.lastUsedIp}
              canWrite={context.canWriteApiKeys}
              allowPrivateIpRanges={context.allowPrivateIpRanges}
              appearance="button"
            />
            {revokeButton}
          </>
        ) : isRevoked ? null : (
          // Expired keys can't be changed, but revoking takes them off the list.
          revokeButton
        )
      }
    >
      {row.description || isActive ? (
        // The note reads as a subtitle to the name in the header. Editable while the key works,
        // like its allowed IPs.
        <div className="flex items-start gap-1 border-b border-grid-dimmed px-3 py-2">
          {row.description ? (
            <Paragraph variant="small" className="min-w-0 flex-1 break-words py-0.5">
              {row.description}
            </Paragraph>
          ) : null}
          {isActive ? (
            <EditApiKeyNoteButton
              id={row.id}
              name={row.name}
              note={row.description}
              canWrite={context.canWriteApiKeys}
              appearance="inline"
            />
          ) : null}
        </div>
      ) : null}
      <Group>
        <Property.Table>
          <Property.Item>
            <Property.Label>Status</Property.Label>
            <Property.Value>
              <ApiKeyStatusCombo
                status={apiKeyStatus({ revokedAt: row.revokedAt, expiresAt: row.expiresAt, now })}
                className="text-xs"
              />
            </Property.Value>
          </Property.Item>
          {row.revokedAt ? (
            <Property.Item>
              <Property.Label>Revoked</Property.Label>
              <Property.Value>
                <DateTime date={row.revokedAt} includeSeconds={false} />
              </Property.Value>
            </Property.Item>
          ) : null}
          <Property.Item>
            <Property.Label>Environment</Property.Label>
            <Property.Value>
              <EnvironmentCombo environment={context.environmentLabel} />
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Secret key</Property.Label>
            <Property.Value className="font-mono">{row.obfuscated}</Property.Value>
          </Property.Item>
        </Property.Table>
        {isExpired && !isRevoked && row.expiresAt ? (
          <Paragraph variant="extra-small" className="mt-3">
            Expired on {expiryLabel ?? <DateTime date={row.expiresAt} includeSeconds={false} />}.
            Create a new key to replace it.
          </Paragraph>
        ) : null}
      </Group>

      <Group>
        <div className="flex items-center justify-between gap-3">
          <Property.Label className="text-sm">Access</Property.Label>
          {access.fullAccess || access.capabilities ? (
            <Switch
              variant="small"
              // A full-access key has no per-area scopes to list, only the areas themselves.
              label={access.fullAccess ? "Show areas" : "Show scopes"}
              checked={showScopes}
              onCheckedChange={setShowScopes}
            />
          ) : null}
        </div>
        <div className="text-sm text-text-dimmed">
          <ApiKeyAccessLabel
            label={access.label}
            isCustom={access.isCustom}
            isOrganizationPreset={access.isOrganizationPreset}
            presetDeleted={access.presetDeleted}
            capabilities={access.capabilities}
            unmatchedScopes={access.unmatchedScopes}
            catalogue={catalogue}
            presets={context.presets}
            taskIdentifiers={access.taskIdentifiers}
          />
        </div>
        {access.fullAccess ? (
          <Paragraph variant="extra-small" className="mt-1">
            Full access to everything in this environment.
          </Paragraph>
        ) : null}
        {catalogue && (access.capabilities || (access.fullAccess && showScopes)) ? (
          // Dimmed on keys that no longer work: what they could do matters less than their status.
          <div className={cn("mt-3", !isActive && "opacity-50")}>
            <CapabilityList
              catalogue={catalogue}
              capabilities={access.capabilities ?? {}}
              fullAccess={access.fullAccess}
              grantedOnly={!access.fullAccess}
              unmatchedScopes={access.unmatchedScopes}
              showScopes={showScopes}
              taskIdentifiers={access.taskIdentifiers}
              allTasks
              notes={usageNotes}
            />
          </div>
        ) : null}
        {catalogue && isActive && access.drift.length > 0 ? (
          <div className="mt-3 flex flex-col items-start gap-2 border-t border-grid-dimmed pt-3">
            <Paragraph variant="extra-small">
              {driftSummary(catalogue, access.label, access.drift)}
            </Paragraph>
            <Button
              variant="secondary/small"
              disabled={!canEditAccess}
              onClick={() => editAccess({ kind: "drift", presetLabel: access.label })}
            >
              Update to current preset
            </Button>
          </div>
        ) : null}
      </Group>

      <Group>
        <Property.Table>
          <Property.Item>
            <Property.Label>Allowed IPs</Property.Label>
            <Property.Value>
              {row.allowedIpRanges.length > 0 ? (
                <ul className="flex flex-col font-mono">
                  {row.allowedIpRanges.map((range) => (
                    <li key={range} className="break-all">
                      {range}
                    </li>
                  ))}
                </ul>
              ) : (
                "Any IP"
              )}
            </Property.Value>
          </Property.Item>
        </Property.Table>
      </Group>

      {usage && catalogue && isActive ? (
        <Group>
          <NarrowToUsage
            row={row}
            usage={usage}
            catalogue={catalogue}
            canEdit={canEditAccess}
            onNarrow={(capabilities) =>
              editAccess({ kind: "narrow", capabilities, windowDays: usage.windowDays })
            }
          />
        </Group>
      ) : null}

      <Group>
        <Property.Table>
          <Property.Item>
            <Property.Label>Created by</Property.Label>
            <Property.Value>{apiKeyCreator(row, "Unknown")}</Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Created</Property.Label>
            <Property.Value>
              <DateTime date={row.createdAt} includeSeconds={false} />
            </Property.Value>
          </Property.Item>
          {isRevoked && !row.expiresAt ? null : (
            <Property.Item>
              <Property.Label>{isExpired ? "Expired" : "Expires"}</Property.Label>
              <Property.Value>
                {row.expiresAt
                  ? (expiryLabel ?? <DateTime date={row.expiresAt} includeSeconds={false} />)
                  : "Never"}
              </Property.Value>
            </Property.Item>
          )}
          <Property.Item>
            <Property.Label>Last used</Property.Label>
            <Property.Value>
              {row.lastUsedAt ? (
                <>
                  <DateTime date={row.lastUsedAt} includeSeconds={false} />
                  {row.lastUsedIp ? (
                    <>
                      {" "}
                      from <span className="font-mono">{row.lastUsedIp}</span>
                    </>
                  ) : null}
                </>
              ) : (
                "Never"
              )}
            </Property.Value>
          </Property.Item>
        </Property.Table>
      </Group>

      {editing ? (
        <EditApiKeyAccessDialog
          apiKey={editableApiKey(row, usage)}
          uneditableMessage={uneditableApiKeyMessage(row, now)}
          start={editing.start}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          availableTasks={context.availableTasks}
          presets={context.presets}
          capabilityCatalogue={catalogue}
          isRbacPluginAvailable={context.isRbacPluginAvailable}
          canManagePresets={context.canManagePresets}
          environment={context.environmentLabel}
          now={now}
        />
      ) : null}
    </Inspector>
  );
}

function NarrowToUsage({
  row,
  usage,
  catalogue,
  canEdit,
  onNarrow,
}: {
  row: ApiKeyRow;
  usage: ApiKeyUsageView;
  catalogue: ApiKeyCapabilityCatalogue;
  canEdit: boolean;
  onNarrow: (capabilities: NonNullable<ApiKeyUsageView["narrowTo"]>) => void;
}) {
  const narrow = narrowToUsage({
    view: usage,
    catalogue,
    capabilities: row.access.capabilities,
    fullAccess: row.access.fullAccess,
  });

  return (
    <div className="flex flex-col items-start gap-2">
      <Property.Table>
        <Property.Item>
          <Property.Label>Usage tracked since</Property.Label>
          <Property.Value>
            <DateTime date={usage.trackedSince} includeTime={false} />
          </Property.Value>
        </Property.Item>
      </Property.Table>
      <Paragraph variant="extra-small">
        {narrow.ok
          ? `Narrowing sets each area to the smallest level that covers the last ${usage.windowDays} days.`
          : narrow.reason}
      </Paragraph>
      <Button
        variant="secondary/small"
        disabled={!canEdit || !narrow.ok}
        onClick={() => {
          if (narrow.ok) onNarrow(narrow.capabilities);
        }}
      >
        Narrow to what it used
      </Button>
    </div>
  );
}

function LabelValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span>
      {label}: <span className="text-text-bright">{children}</span>
    </span>
  );
}

function RootApiKeyInspector({ context }: { context: ApiKeysOutletContext }) {
  const { rootApiKey, environment } = context;
  if (!rootApiKey) {
    return (
      <Inspector title="Root API key" closePath={context.listPath}>
        <Group>
          <Paragraph variant="small">This environment has no root key.</Paragraph>
        </Group>
      </Inspector>
    );
  }

  return (
    <Inspector
      title={rootApiKey.name}
      closePath={context.listPath}
      footer={
        context.canManageRootApiKey ? (
          <>
            {context.canWriteApiKeys ? (
              <RegenerateApiKeyModal
                id={environment.keyEnvironmentId}
                title={environmentFullTitle(context.environmentLabel)}
                hasVercelIntegration={context.hasVercelIntegration}
                isDevelopment={environment.type === "DEVELOPMENT"}
                isRootApiKeyHidden={rootApiKey.isHidden}
                onSwitchToApiKeys={context.openMigration}
                canLimitAccess={context.isRbacPluginAvailable && context.presets !== null}
                appearance="button"
              />
            ) : null}
            {rootApiKey.isHidden ? null : (
              <div className="ml-auto">
                <DisableRootApiKeyButton canWrite={context.canWriteApiKeys} appearance="button" />
              </div>
            )}
          </>
        ) : null
      }
    >
      <Group>
        <Property.Table>
          <Property.Item>
            <Property.Label>Status</Property.Label>
            <Property.Value>
              <ApiKeyStatusCombo status="ACTIVE" className="text-xs" />
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Environment</Property.Label>
            <Property.Value>
              <EnvironmentCombo environment={context.environmentLabel} />
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Secret key</Property.Label>
            <Property.Value className="flex items-center gap-2">
              <span className="font-mono">{rootApiKey.obfuscated}</span>
              {rootApiKey.value ? (
                <CopyButton value={rootApiKey.value} variant="icon" size="small" />
              ) : null}
            </Property.Value>
          </Property.Item>
        </Property.Table>
      </Group>
      <Group>
        <Property.Table>
          <Property.Item>
            <Property.Label>Access</Property.Label>
            <Property.Value>No restrictions</Property.Value>
          </Property.Item>
        </Property.Table>
        <Paragraph variant="extra-small" className="mt-2">
          Root keys are being phased out. Create an API key to choose what it can access.
        </Paragraph>
      </Group>
    </Inspector>
  );
}

function Inspector({
  title,
  closePath,
  footer,
  children,
}: {
  title: string;
  closePath: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  // Dialogs opened from the inspector close on Esc themselves; the same press mustn't also close
  // the inspector. Radix traps focus inside an open dialog, so focus tells us one is open.
  useShortcutKeys({
    shortcut: { key: "esc" },
    action: () => {
      if (document.activeElement?.closest("[role='dialog'], [role='alertdialog']")) return;
      navigate(closePath);
    },
  });

  return (
    <div
      className={cn(
        "grid h-full max-h-full overflow-hidden bg-background-bright",
        footer ? "grid-rows-[2.5rem_1fr_auto]" : "grid-rows-[2.5rem_1fr]"
      )}
    >
      <div className="mx-3 flex items-center justify-between gap-2 overflow-x-hidden border-b border-grid-dimmed">
        <Header2 className="flex min-w-0">
          <TruncatedText text={title} className="whitespace-nowrap" />
        </Header2>
        <LinkButton
          to={closePath}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc", enabled: false }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
        />
      </div>
      <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        {children}
      </div>
      {footer ? (
        <div className="flex min-h-[3.25rem] flex-wrap items-center gap-2 border-t border-grid-dimmed px-2 py-2">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

function ShowRevokedButton() {
  const [, setSearchParams] = useSearchParams();
  return (
    <div className="mt-3 flex flex-col items-start gap-2">
      <Paragraph variant="small">Revoked keys are hidden from the list.</Paragraph>
      <Button
        variant="secondary/small"
        onClick={() =>
          setSearchParams((searchParams) => {
            searchParams.set("showRevoked", "true");
            return searchParams;
          })
        }
      >
        Show revoked keys
      </Button>
    </div>
  );
}

function Group({ children }: { children: ReactNode }) {
  return <div className="border-b border-grid-dimmed p-3 last:border-b-0">{children}</div>;
}
