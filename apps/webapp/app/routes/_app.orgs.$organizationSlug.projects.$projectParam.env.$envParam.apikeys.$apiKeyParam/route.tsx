import { PencilSquareIcon } from "@heroicons/react/20/solid";
import { useOutletContext, useRevalidator } from "@remix-run/react";
import {
  type ApiKeyCapabilityCatalogue,
  type ApiKeyCapabilityDifference,
} from "@trigger.dev/plugins";
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
import { ApiKeyUsagePresenter } from "~/presenters/v3/ApiKeyUsagePresenter.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { capabilityName, levelLabel, uneditableApiKeyMessage } from "~/utils/apiKeyAccess";
import { cn } from "~/utils/cn";
import { type ApiKeyUsageView, capabilityUsageLine, narrowToUsage } from "~/utils/apiKeyUsage";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { pageMeta } from "~/utils/pageTitle";
import { ApiKeyAccessLabel } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/ApiKeyAccessCell";
import {
  ApiKeyStatus,
  apiKeyCreator,
  DisableRootApiKeyButton,
  editableApiKey,
  RevokeApiKeyButton,
  ROOT_API_KEY_PARAM,
} from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/ApiKeyActions";
import { CapabilityList } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/ApiKeyCapabilities";
import { EditApiKeyIpRangesButton } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/ApiKeyIpRanges";
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
                <ApiKeyStatus revokedAt={apiKey.revokedAt} now={context.loadedAt} />
              </Property.Value>
            </Property.Item>
          </Property.Table>
          <Paragraph variant="small" className="mt-3">
            Turn on Show revoked to see this key's details.
          </Paragraph>
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
  const { access } = row;
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
                  {line.lastUsedAt ? <DateTime date={line.lastUsedAt} /> : "Never"}
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

  return (
    <Inspector
      title={row.name}
      closePath={context.listPath}
      footer={
        isActive ? (
          <>
            {context.canEditAccess ? (
              <Button
                variant="tertiary/medium"
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
              appearance="button"
            />
            <div className="ml-auto">
              <RevokeApiKeyButton
                id={row.id}
                name={row.name}
                canWrite={context.canWriteApiKeys}
                appearance="button"
              />
            </div>
          </>
        ) : null
      }
    >
      <Group>
        <Property.Table>
          <Property.Item>
            <Property.Label>Status</Property.Label>
            <Property.Value>
              <ApiKeyStatus revokedAt={row.revokedAt} expiresAt={row.expiresAt} now={now} />
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
            <Property.Value className="font-mono">{row.obfuscated}</Property.Value>
          </Property.Item>
        </Property.Table>
      </Group>

      <Group>
        <Property.Table>
          <Property.Item>
            <Property.Label>Access</Property.Label>
            <Property.Value>
              <ApiKeyAccessLabel
                label={access.label}
                isCustom={access.isCustom}
                capabilities={access.capabilities}
                catalogue={catalogue}
                presets={context.presets}
                taskIdentifiers={access.taskIdentifiers}
              />
            </Property.Value>
          </Property.Item>
        </Property.Table>
        {catalogue && (access.fullAccess || access.capabilities) ? (
          <div className="mt-2">
            <CapabilityList
              catalogue={catalogue}
              capabilities={access.capabilities ?? {}}
              fullAccess={access.fullAccess}
              grantedOnly={!access.fullAccess}
              unmatchedScopes={access.unmatchedScopes}
              showScopes={showScopes}
              taskIdentifiers={access.taskIdentifiers}
              notes={usageNotes}
            />
          </div>
        ) : null}
        {!access.fullAccess && access.capabilities ? (
          <Button
            variant="minimal/small"
            className="-ml-2 mt-1"
            onClick={() => setShowScopes(!showScopes)}
          >
            {showScopes ? "Hide scopes" : "Show scopes"}
          </Button>
        ) : null}
        {access.taskIdentifiers && access.taskIdentifiers.length > 0 ? (
          <Paragraph variant="extra-small" className="mt-2">
            Limited to{" "}
            {access.taskIdentifiers.map((task, index) => (
              <span key={task}>
                {index > 0 ? ", " : null}
                <span className="font-mono text-text-bright">{task}</span>
              </span>
            ))}
          </Paragraph>
        ) : null}
        {catalogue && access.drift.length > 0 ? (
          <div className="mt-3 flex items-center justify-between gap-3">
            <Paragraph variant="extra-small">
              {driftSummary(catalogue, access.label, access.drift)}
            </Paragraph>
            <Button
              variant="tertiary/small"
              className="shrink-0"
              disabled={!canEditAccess}
              onClick={() => editAccess({ kind: "drift", presetLabel: access.label })}
            >
              Update to current preset
            </Button>
          </div>
        ) : null}
        {usage && catalogue ? (
          <NarrowToUsage
            row={row}
            usage={usage}
            catalogue={catalogue}
            canEdit={canEditAccess}
            onNarrow={(capabilities) =>
              editAccess({ kind: "narrow", capabilities, windowDays: usage.windowDays })
            }
          />
        ) : null}
      </Group>

      <Group>
        <Property.Table>
          <Property.Item>
            <Property.Label>Created by</Property.Label>
            <Property.Value>{apiKeyCreator(row, "Unknown")}</Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Created</Property.Label>
            <Property.Value>
              <DateTime date={row.createdAt} />
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Expires</Property.Label>
            <Property.Value>
              {row.expiresAt ? <DateTime date={row.expiresAt} /> : "Never"}
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Last used</Property.Label>
            <Property.Value>
              {row.lastUsedAt ? (
                <>
                  <DateTime date={row.lastUsedAt} />
                  {row.lastUsedIp ? <> from {row.lastUsedIp}</> : null}
                </>
              ) : (
                "Never"
              )}
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Allowed IPs</Property.Label>
            <Property.Value>
              {row.allowedIpRanges.length > 0 ? row.allowedIpRanges.join(", ") : "Any IP"}
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

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function driftSummary(
  catalogue: ApiKeyCapabilityCatalogue,
  presetLabel: string,
  drift: ApiKeyCapabilityDifference[]
): string {
  if (drift.every((difference) => !difference.loses)) {
    return `${presetLabel} now also grants ${listNames(
      drift.map((difference) => capabilityName(catalogue, difference.capabilityId))
    )}.`;
  }
  return `${presetLabel} now grants ${drift
    .map(
      (difference) =>
        `${capabilityName(catalogue, difference.capabilityId)}: ${levelLabel(
          catalogue,
          difference.capabilityId,
          difference.to
        )} (was ${levelLabel(catalogue, difference.capabilityId, difference.from)})`
    )
    .join(", ")}.`;
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
    <div className="mt-3 flex flex-col gap-2">
      <Paragraph variant="extra-small">
        <LabelValue label="Usage tracked since">
          <DateTime date={usage.trackedSince} includeTime={false} />
        </LabelValue>
      </Paragraph>
      <div className="flex items-center gap-3">
        <Button
          variant="tertiary/small"
          className="shrink-0"
          disabled={!canEdit || !narrow.ok}
          onClick={() => {
            if (narrow.ok) onNarrow(narrow.capabilities);
          }}
        >
          Narrow to what it used
        </Button>
        <Paragraph variant="extra-small">
          {narrow.ok
            ? `Smallest levels that cover the last ${usage.windowDays} days.`
            : narrow.reason}
        </Paragraph>
      </div>
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
              />
            ) : null}
            {rootApiKey.isHidden ? null : (
              <div className="ml-auto">
                <DisableRootApiKeyButton canWrite={context.canWriteApiKeys} />
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
              <ApiKeyStatus now={context.loadedAt} />
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
  return (
    <div
      className={cn(
        "grid h-full max-h-full overflow-hidden bg-background-bright",
        footer ? "grid-rows-[2.5rem_1fr_auto]" : "grid-rows-[2.5rem_1fr]"
      )}
    >
      <div className="mx-3 flex items-center justify-between gap-2 overflow-x-hidden border-b border-grid-dimmed">
        <Header2 className="truncate whitespace-nowrap">{title}</Header2>
        <LinkButton
          to={closePath}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
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

function Group({ children }: { children: ReactNode }) {
  return <div className="border-b border-grid-dimmed p-3 last:border-b-0">{children}</div>;
}
