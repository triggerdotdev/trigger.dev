import {
  ArrowUpRightIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
} from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { redirect } from "@remix-run/server-runtime";
import { useEffect, useState } from "react";
import { useFetcher, useRevalidator } from "@remix-run/react";
import { z } from "zod";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { Feedback } from "~/components/Feedback";
import { Callout } from "~/components/primitives/Callout";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "~/components/primitives/Dialog";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  SettingsActions,
  SettingsBlock,
  SettingsContainer,
  SettingsHeader,
  SettingsRow,
  SettingsSection,
} from "~/components/primitives/SettingsLayout";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Switch } from "~/components/primitives/Switch";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { rbac } from "~/services/rbac.server";
import { ssoController } from "~/services/sso.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import type { DirectorySyncEffect, DirectorySyncStatus, Role } from "@trigger.dev/plugins";
import { applyDirectorySyncEffects } from "~/services/directorySyncEffects.server";
import { flag } from "~/v3/featureFlags.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { cn } from "~/utils/cn";
import { throwPermissionDenied } from "~/utils/permissionDenied";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

export const meta: MetaFunction = () => [{ title: "SSO & Directory Sync | Trigger.dev" }];

const Params = z.object({ organizationSlug: z.string() });

async function resolveOrg(slug: string) {
  // Primary (not replica): this scopes the RBAC/entitlement checks, so lag
  // could run them against a stale/missing org.
  return prisma.organization.findFirst({
    where: { slug },
    select: { id: true, title: true },
  });
}

function planAllowsSso(plan: unknown): boolean {
  if (!plan || typeof plan !== "object") return false;
  const subscription = (plan as { v3Subscription?: { plan?: { code?: string } } }).v3Subscription;
  return subscription?.plan?.code === "enterprise";
}

// Client-side upsell is cosmetic; gate real IdP mutations server-side.
async function requireSsoEntitlement(orgId: string): Promise<void> {
  const plan = await getCurrentPlan(orgId);
  if (!planAllowsSso(plan)) {
    throw new Response("SSO requires an Enterprise plan", { status: 403 });
  }
}

const EMPTY_DIRECTORY_SYNC_STATUS: DirectorySyncStatus = {
  hasDirectory: false,
  hasActiveDirectory: false,
  allowExternalDomainSync: false,
  allowManualMembership: true,
  directoryDefaultRoleId: null,
  userCount: 0,
  directories: [],
  groups: [],
};

// Per-org flag wins, else global (default off). Single knob for both SSO and
// Directory Sync (no separate dsync flag).
async function resolveHasSso(orgId: string): Promise<boolean> {
  const org = await prisma.organization.findFirst({
    where: { id: orgId },
    select: { featureFlags: true },
  });
  const perOrg = (org?.featureFlags as Record<string, unknown> | null)?.[FEATURE_FLAG.hasSso];
  if (perOrg === true) return true;
  return (await flag({ key: FEATURE_FLAG.hasSso, defaultValue: false })) === true;
}

const EMPTY_SSO_STATUS = {
  hasIdpOrg: false,
  enforced: false,
  jitProvisioningEnabled: false,
  jitDefaultRoleId: null,
  idpOrgId: null,
  primaryConnectionId: null,
  hasActiveDirectory: false,
  domains: [] as Array<{
    domain: string;
    verified: boolean;
    state: "pending" | "verified" | "failed";
    verificationFailedReason: string | null;
  }>,
  connections: [] as Array<{
    id: string;
    name: string | null;
    connectionType: string;
    state: "active" | "inactive";
  }>,
};

export const loader = dashboardLoader(
  {
    params: Params,
    context: async (params) => {
      const org = await resolveOrg(params.organizationSlug);
      return org ? { organizationId: org.id, orgTitle: org.title } : {};
    },
    // Plan-gated before role-gated: non-Enterprise orgs render the upsell for
    // everyone, so we enforce manage:sso in the body only once entitled.
  },
  async ({ context, ability }) => {
    // True only with SSO_ENABLED on and a real plugin loaded.
    if (!(await ssoController.isUsingPlugin())) {
      throw new Response("Not Found", { status: 404 });
    }

    const orgId = context.organizationId;
    if (!orgId) {
      throw new Response("Not Found", { status: 404 });
    }

    // Not Enterprise: render the upsell for every role, skip role check +
    // queries, return empty data.
    const plan = await getCurrentPlan(orgId);
    if (!planAllowsSso(plan)) {
      return typedjson({
        status: EMPTY_SSO_STATUS,
        orgTitle: context.orgTitle,
        jitRoles: [] as Role[],
        directorySync: EMPTY_DIRECTORY_SYNC_STATUS,
        hasSso: false,
      });
    }

    // Entitled: real config surface, so enforce the role gate (403 for
    // non-Owner without manage:sso).
    if (!ability.can("manage", { type: "sso" })) {
      throwPermissionDenied();
    }

    const [statusResult, allRoles, assignableIds, dsyncResult, hasSso] = await Promise.all([
      ssoController.getStatus(orgId),
      rbac.allRoles(orgId),
      rbac.getAssignableRoleIds(orgId),
      ssoController.getDirectorySyncStatus(orgId),
      resolveHasSso(orgId),
    ]);
    const status = statusResult.isOk() ? statusResult.value : EMPTY_SSO_STATUS;
    const directorySync = dsyncResult.isOk() ? dsyncResult.value : EMPTY_DIRECTORY_SYNC_STATUS;

    // JIT can't grant Owner (reserved), and non-assignable/plan-gated roles
    // are filtered out.
    const assignable = new Set(assignableIds);
    const jitRoles = allRoles.filter((r) => r.name !== "Owner" && assignable.has(r.id));

    return typedjson({
      status,
      orgTitle: context.orgTitle,
      jitRoles,
      directorySync,
      hasSso,
    });
  }
);

const NULL_ROLE_VALUE = "__none__";
const DEFAULT_JIT_ROLE_NAME = "Developer";

// Not `z.coerce.boolean()`: it treats the string "false" as truthy.
const boolish = z.union([z.literal("true"), z.literal("false")]).transform((v) => v === "true");

// Changed group→role mappings from the deferred Directory Sync Save.
const GroupRolesSchema = z.array(z.object({ groupId: z.string(), roleId: z.string() }));

const ActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save_config"),
    enforced: boolish,
    jitEnabled: boolish,
    jitRoleId: z.string(),
  }),
  z.object({
    action: z.literal("portal_link"),
    intent: z.enum(["sso", "domain_verification", "dsync"]),
  }),
  // Single deferred Save: settings + changed group mappings commit together.
  z.object({
    action: z.literal("save_dsync_config"),
    allowExternalDomainSync: boolish,
    allowManualMembership: boolish,
    directoryDefaultRoleId: z.string(),
    groupRoles: z.string(),
  }),
]);

export const action = dashboardAction(
  {
    params: Params,
    context: async (params) => {
      const org = await resolveOrg(params.organizationSlug);
      return org ? { organizationId: org.id } : {};
    },
    authorization: { action: "manage", resource: { type: "sso" } },
  },
  async ({ request, context, user, params }) => {
    const orgId = context.organizationId;
    if (!orgId) {
      throw new Response("Not Found", { status: 404 });
    }

    // Mirror the loader gate.
    if (!(await ssoController.isUsingPlugin())) {
      throw new Response("Not Found", { status: 404 });
    }
    await requireSsoEntitlement(orgId);

    const formData = await request.formData();
    const parsed = ActionSchema.safeParse({
      action: formData.get("action"),
      enforced: formData.get("enforced") ?? undefined,
      jitEnabled: formData.get("jitEnabled") ?? undefined,
      jitRoleId: formData.get("jitRoleId") ?? undefined,
      intent: formData.get("intent") ?? undefined,
      allowExternalDomainSync: formData.get("allowExternalDomainSync") ?? undefined,
      allowManualMembership: formData.get("allowManualMembership") ?? undefined,
      directoryDefaultRoleId: formData.get("directoryDefaultRoleId") ?? undefined,
      groupRoles: formData.get("groupRoles") ?? undefined,
    });
    if (!parsed.success) {
      return new Response("Bad Request", { status: 400 });
    }

    switch (parsed.data.action) {
      case "save_config": {
        const jitRoleId = parsed.data.jitRoleId === NULL_ROLE_VALUE ? null : parsed.data.jitRoleId;
        // All-or-nothing: `updateConfig` writes the three fields in one
        // transaction (with the JIT-role RBAC check inside).
        const result = await ssoController.updateConfig({
          organizationId: orgId,
          enforced: parsed.data.enforced,
          jitProvisioningEnabled: parsed.data.jitEnabled,
          jitDefaultRoleId: jitRoleId,
        });
        if (result.isErr()) {
          return new Response(`Error: ${result.error}`, { status: 400 });
        }
        return redirect(`/orgs/${params.organizationSlug}/settings/sso`);
      }
      case "portal_link": {
        const url = new URL(request.url);
        const returnUrl = `${url.protocol}//${url.host}/orgs/${params.organizationSlug}/settings/sso`;
        const result = await ssoController.generatePortalLink({
          organizationId: orgId,
          userId: user.id,
          intent: parsed.data.intent,
          returnUrl,
        });
        if (result.isErr()) {
          return Response.json({ ok: false, error: result.error }, { status: 400 });
        }
        return Response.json({ ok: true, url: result.value.url });
      }
      case "save_dsync_config": {
        // Parse the changed group→role mappings.
        let groupRoles: Array<{ groupId: string; roleId: string }>;
        try {
          groupRoles = GroupRolesSchema.parse(JSON.parse(parsed.data.groupRoles));
        } catch {
          return new Response("Bad Request", { status: 400 });
        }
        const defaultRoleId =
          parsed.data.directoryDefaultRoleId === NULL_ROLE_VALUE
            ? null
            : parsed.data.directoryDefaultRoleId;
        // Hoist out: the union narrowing doesn't survive into the thunks below.
        const { allowExternalDomainSync, allowManualMembership } = parsed.data;

        // Config columns first. Not transactional, but each write is
        // idempotent so retrying the whole Save converges. Thunks run serially
        // so the first failure stops the rest.
        const configWrites = [
          () =>
            ssoController.setAllowExternalDomainSync({
              organizationId: orgId,
              allowed: allowExternalDomainSync,
            }),
          () =>
            ssoController.setAllowManualMembership({
              organizationId: orgId,
              allowed: allowManualMembership,
            }),
          () =>
            ssoController.setDirectoryDefaultRole({ organizationId: orgId, roleId: defaultRoleId }),
        ];
        for (const write of configWrites) {
          const result = await write();
          if (result.isErr()) {
            return new Response(`Error: ${result.error}`, { status: 400 });
          }
        }

        // Each remap returns membership effects for its members (role
        // recompute, or deprovision when cleared); apply them immediately.
        const effects: DirectorySyncEffect[] = [];
        for (const g of groupRoles) {
          const result = await ssoController.setDirectoryGroupRole({
            organizationId: orgId,
            groupId: g.groupId,
            roleId: g.roleId === NULL_ROLE_VALUE ? null : g.roleId,
          });
          if (result.isErr()) {
            return new Response(`Error: ${result.error}`, { status: 400 });
          }
          effects.push(...result.value.effects);
        }
        if (effects.length > 0) {
          await applyDirectorySyncEffects(effects);
        }
        return redirect(`/orgs/${params.organizationSlug}/settings/sso`);
      }
    }
  }
);

function defaultJitRoleId(jitRoles: ReadonlyArray<Role>, current: string | null): string {
  // Persisted value wins, even if the picker can no longer offer it.
  if (current) return current;
  const dev = jitRoles.find((r) => r.name === DEFAULT_JIT_ROLE_NAME);
  return dev?.id ?? NULL_ROLE_VALUE;
}

// Locally-editable mirror of a server value, poll-safe: untouched fields adopt
// fresh server values; edited (dirty) fields hold until the server catches up,
// then snap back to clean.
function useOverrideDraft<T>(serverValue: T): {
  value: T;
  set: (next: T) => void;
  dirty: boolean;
} {
  const [override, setOverride] = useState<{ value: T } | null>(null);
  useEffect(() => {
    // Server matches the pending edit → clear the override.
    setOverride((current) => (current && Object.is(current.value, serverValue) ? null : current));
  }, [serverValue]);
  const value = override ? override.value : serverValue;
  return {
    value,
    set: (next) => setOverride({ value: next }),
    dirty: override != null && !Object.is(override.value, serverValue),
  };
}

export default function Page() {
  const { status, orgTitle, jitRoles, directorySync, hasSso } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const _plan = useCurrentPlan();

  const isEntitled = planAllowsSso(_plan);
  const activeConnections = status.connections.filter((c) => c.state === "active");
  const hasActive = activeConnections.length > 0;

  // Deferred-save drafts; `useOverrideDraft` keeps them poll-safe until Save.
  const initialJitRoleId = defaultJitRoleId(jitRoles, status.jitDefaultRoleId);
  const enforcedDraft = useOverrideDraft(status.enforced);
  const jitEnabledDraft = useOverrideDraft(status.jitProvisioningEnabled);
  const jitRoleDraft = useOverrideDraft(initialJitRoleId);
  const draftEnforced = enforcedDraft.value;
  const setDraftEnforced = enforcedDraft.set;
  const draftJitEnabled = jitEnabledDraft.value;
  const setDraftJitEnabled = jitEnabledDraft.set;
  const draftJitRoleId = jitRoleDraft.value;
  const setDraftJitRoleId = jitRoleDraft.set;

  const isDirty = enforcedDraft.dirty || jitEnabledDraft.dirty || jitRoleDraft.dirty;

  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [portalIntent, setPortalIntent] = useState<"sso" | "domain_verification" | "dsync" | null>(
    null
  );
  const [enforceModalOpen, setEnforceModalOpen] = useState(false);
  const portalFetcher = useFetcher<{ ok: boolean; url?: string; error?: string }>();
  const saveFetcher = useFetcher();
  const isSaving = saveFetcher.state !== "idle";
  const revalidator = useRevalidator();

  useEffect(() => {
    if (portalFetcher.data?.ok && portalFetcher.data.url) {
      setPortalUrl(portalFetcher.data.url);
    }
  }, [portalFetcher.data]);

  // Poll while entitled to reflect portal progress and keep SSO + Directory
  // Sync state fresh; drafts survive via `useOverrideDraft`.
  const shouldPoll = isEntitled;
  useEffect(() => {
    if (!shouldPoll) return;
    const id = setInterval(() => {
      if (
        revalidator.state !== "idle" ||
        portalFetcher.state !== "idle" ||
        saveFetcher.state !== "idle" ||
        (typeof document !== "undefined" && document.visibilityState === "hidden")
      ) {
        return;
      }
      revalidator.revalidate();
    }, 5000);
    return () => clearInterval(id);
  }, [shouldPoll, revalidator, portalFetcher.state, saveFetcher.state]);

  const openPortal = (intent: "sso" | "domain_verification" | "dsync") => {
    setPortalUrl(null);
    setPortalIntent(intent);
    portalFetcher.submit({ action: "portal_link", intent }, { method: "POST" });
  };

  const submitSave = () => {
    saveFetcher.submit(
      {
        action: "save_config",
        enforced: draftEnforced ? "true" : "false",
        jitEnabled: draftJitEnabled ? "true" : "false",
        jitRoleId: draftJitRoleId,
      },
      { method: "POST" }
    );
  };

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="SSO & Directory Sync" />
      </NavBar>
      <PageBody scrollable={true}>
        <SettingsContainer>
          {!isEntitled ? (
            <EnterpriseUpsellState />
          ) : !status.hasIdpOrg ? (
            <NoIdpOrgState onOpenPortal={() => openPortal("domain_verification")} />
          ) : !hasActive ? (
            <NoActiveConnectionState
              domains={status.domains}
              directorySync={directorySync}
              jitRoles={jitRoles}
              hasSso={hasSso}
              onOpenSso={() => openPortal("sso")}
              onOpenDomain={() => openPortal("domain_verification")}
              onOpenDsync={() => openPortal("dsync")}
            />
          ) : (
            <ActiveConnectionState
              orgTitle={orgTitle ?? organization.title}
              status={status}
              activeConnections={activeConnections}
              jitRoles={jitRoles}
              directorySync={directorySync}
              hasSso={hasSso}
              draftEnforced={draftEnforced}
              draftJitEnabled={draftJitEnabled}
              draftJitRoleId={draftJitRoleId}
              isDirty={isDirty}
              isSaving={isSaving}
              onOpenPortal={openPortal}
              onToggleEnforced={(next) => {
                // off→on locks users out, so confirm first (draft only).
                if (next && !status.enforced) {
                  setEnforceModalOpen(true);
                } else {
                  setDraftEnforced(next);
                }
              }}
              onToggleJit={(next) => setDraftJitEnabled(next)}
              onChangeJitRole={(roleId) => setDraftJitRoleId(roleId ?? NULL_ROLE_VALUE)}
              onSave={submitSave}
            />
          )}
        </SettingsContainer>
      </PageBody>

      <PortalLinkDialog url={portalUrl} intent={portalIntent} onClose={() => setPortalUrl(null)} />

      <EnforceConfirmDialog
        open={enforceModalOpen}
        orgTitle={orgTitle ?? organization.title}
        onCancel={() => setEnforceModalOpen(false)}
        onConfirm={() => {
          setDraftEnforced(true);
          setEnforceModalOpen(false);
        }}
      />
    </PageContainer>
  );
}

function EnterpriseUpsellState() {
  return (
    <SettingsSection>
      <SettingsHeader
        title={
          <span className="flex items-center gap-2">
            SSO & Directory Sync
            <Badge variant="small">Enterprise</Badge>
          </span>
        }
        description="Single sign-on (SAML/OIDC) and Directory Sync (SCIM) let your IT team manage access to Trigger.dev from your identity provider, such as Okta, Azure AD, or Google Workspace."
      />
      <div className="w-full space-y-4 py-4">
        <ul className="ml-4 list-disc space-y-1.5 text-sm text-text-dimmed">
          <li>Verify domains and connect your identity provider from the admin portal.</li>
          <li>Just-in-time provisioning for your verified domains.</li>
          <li>Enforce SSO by domain, so contractors keep their existing sign-in.</li>
          <li>Sync users and map directory groups to roles with SCIM.</li>
        </ul>
        <div className="flex flex-wrap gap-2">
          <Feedback
            defaultValue="enterprise"
            button={<Button variant="primary/small">Contact us</Button>}
          />
        </div>
      </div>
    </SettingsSection>
  );
}

function NoIdpOrgState({ onOpenPortal }: { onOpenPortal: () => void }) {
  return (
    <SettingsSection>
      <SettingsHeader
        title="SSO"
        description="Manage access to Trigger.dev from your identity provider, such as Okta, Azure AD, or Google Workspace."
      />
      <SettingsRow
        title="Get started"
        description="Verify your email domains, then connect your identity provider."
        action={
          <Button variant="secondary/small" onClick={onOpenPortal}>
            Start setup
          </Button>
        }
      />
    </SettingsSection>
  );
}

type DomainRow = {
  domain: string;
  verified: boolean;
  state: "pending" | "verified" | "failed";
  verificationFailedReason: string | null;
};

function NoActiveConnectionState({
  domains,
  directorySync,
  jitRoles,
  hasSso,
  onOpenSso,
  onOpenDomain,
  onOpenDsync,
}: {
  domains: ReadonlyArray<DomainRow>;
  directorySync: DirectorySyncStatus;
  jitRoles: ReadonlyArray<Role>;
  hasSso: boolean;
  onOpenSso: () => void;
  onOpenDomain: () => void;
  onOpenDsync: () => void;
}) {
  const verifiedDomains = domains.filter((d) => d.state === "verified");
  const failedDomains = domains.filter((d) => d.state === "failed");
  const hasVerifiedDomain = verifiedDomains.length > 0;

  return (
    <>
      <SettingsSection>
        <SettingsHeader
          title="Domains"
          description="Verify the email domains your team signs in with. Connect your identity provider once a domain is verified."
          action={
            <Button variant="secondary/small" onClick={onOpenDomain}>
              {domains.length > 0 ? "Add domain" : "Verify domain"}
            </Button>
          }
        />
        {failedDomains.length > 0 && (
          <SettingsBlock>
            <Callout variant="error">
              {failedDomains.length === 1
                ? `Verification failed for ${failedDomains[0].domain}. Check the DNS records in the admin portal and try again.`
                : `${failedDomains.length} domains failed verification. Check the DNS records in the admin portal and try again.`}
            </Callout>
          </SettingsBlock>
        )}
        {domains.length > 0 && <DomainList domains={domains} />}
      </SettingsSection>

      {hasVerifiedDomain && (
        <SettingsSection>
          <SettingsHeader
            title="SSO"
            description="Connect your identity provider to enable SSO for your verified domains."
          />
          <SettingsRow
            title="Identity provider"
            description="Connect Okta, Azure AD, Google Workspace, and more."
            action={
              <Button variant="secondary/small" onClick={onOpenSso}>
                Configure SSO
              </Button>
            }
          />
        </SettingsSection>
      )}

      {/* Directory Sync is independent of SSO (needs only a verified domain). */}
      {hasVerifiedDomain && hasSso ? (
        <DirectorySyncSection
          directorySync={directorySync}
          jitRoles={jitRoles}
          onOpenPortal={onOpenDsync}
        />
      ) : null}
    </>
  );
}

function DomainList({ domains }: { domains: ReadonlyArray<DomainRow> }) {
  return (
    <>
      {domains.map((d) => {
        const visual = domainVisual(d.state);
        return (
          <SettingsRow
            key={d.domain}
            size="sm"
            action={
              <span
                className={cn("flex shrink-0 items-center gap-1 text-sm capitalize", visual.label)}
              >
                {visual.icon}
                {d.state}
              </span>
            }
          >
            <div className="flex flex-col">
              <span className="font-mono text-sm text-text-bright">{d.domain}</span>
              {d.state === "failed" && d.verificationFailedReason && (
                <span className="mt-0.5 text-xs text-rose-400">
                  Reason: <span className="font-mono">{d.verificationFailedReason}</span>
                </span>
              )}
            </div>
          </SettingsRow>
        );
      })}
    </>
  );
}

function domainVisual(state: DomainRow["state"]) {
  switch (state) {
    case "verified":
      return {
        label: "text-success",
        icon: <CheckCircleIcon className="size-3.5" />,
      };
    case "failed":
      return {
        label: "text-error",
        icon: <ExclamationCircleIcon className="size-3.5" />,
      };
    case "pending":
    default:
      return {
        label: "text-warning",
        icon: <ClockIcon className="size-3.5" />,
      };
  }
}

function ActiveConnectionState({
  orgTitle,
  status,
  activeConnections,
  jitRoles,
  directorySync,
  hasSso,
  draftEnforced,
  draftJitEnabled,
  draftJitRoleId,
  isDirty,
  isSaving,
  onOpenPortal,
  onToggleEnforced,
  onToggleJit,
  onChangeJitRole,
  onSave,
}: {
  orgTitle: string;
  status: {
    enforced: boolean;
    jitProvisioningEnabled: boolean;
    jitDefaultRoleId: string | null;
    domains: ReadonlyArray<DomainRow>;
  };
  activeConnections: ReadonlyArray<{ id: string; name: string | null; connectionType: string }>;
  jitRoles: ReadonlyArray<Role>;
  directorySync: DirectorySyncStatus;
  hasSso: boolean;
  draftEnforced: boolean;
  draftJitEnabled: boolean;
  draftJitRoleId: string;
  isDirty: boolean;
  isSaving: boolean;
  onOpenPortal: (intent: "sso" | "domain_verification" | "dsync") => void;
  onToggleEnforced: (next: boolean) => void;
  onToggleJit: (next: boolean) => void;
  onChangeJitRole: (roleId: string | null) => void;
  onSave: () => void;
}) {
  return (
    <>
      <SettingsSection>
        <SettingsHeader
          title="Domains"
          description="The email domains your team signs in with."
          action={
            <Button variant="secondary/small" onClick={() => onOpenPortal("domain_verification")}>
              {status.domains.length > 0 ? "Add domain" : "Verify domain"}
            </Button>
          }
        />
        {status.domains.length === 0 ? (
          <SettingsBlock>
            <Paragraph variant="small">No domains verified yet.</Paragraph>
          </SettingsBlock>
        ) : (
          <DomainList domains={status.domains} />
        )}
      </SettingsSection>

      <SettingsSection>
        <SettingsHeader
          title="SSO"
          description={`SSO connection for ${orgTitle}.`}
          action={
            <Button variant="secondary/small" onClick={() => onOpenPortal("sso")}>
              Manage connection
            </Button>
          }
        />
        {activeConnections.map((conn) => (
          <SettingsRow
            key={conn.id}
            title={conn.name ?? conn.connectionType}
            description={`Type: ${conn.connectionType}`}
            action={<StatusIndicator label="Active" />}
          />
        ))}

        <SettingsRow
          title="Require SSO for matching domains"
          description="Users with an email on a verified domain must sign in with SSO."
          action={
            <Switch variant="medium" checked={draftEnforced} onCheckedChange={onToggleEnforced} />
          }
        />
        <SettingsRow
          title="Just-in-time provisioning"
          description="Automatically add members on their first SSO sign-in from a verified domain."
          action={
            <Switch variant="medium" checked={draftJitEnabled} onCheckedChange={onToggleJit} />
          }
        />
        <SettingsRow
          title="Default role for new users"
          description="Assigned to users created by just-in-time provisioning. Owner can't be granted automatically."
          action={
            <Select<string, Role>
              value={draftJitRoleId}
              setValue={(v) => onChangeJitRole(v)}
              items={[...jitRoles]}
              variant="secondary/small"
              dropdownIcon
              popoverClassName="max-w-xs"
              placement="bottom-end"
              text={(v) => jitRoles.find((r) => r.id === v)?.name ?? "Select a role"}
            >
              {(items) =>
                items.map((role) => (
                  <RoleSelectItem
                    key={role.id}
                    id={role.id}
                    name={role.name}
                    description={role.description}
                  />
                ))
              }
            </Select>
          }
        />
        <SettingsActions>
          <Button variant="primary/small" disabled={!isDirty || isSaving} onClick={onSave}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </SettingsActions>
      </SettingsSection>

      {hasSso ? (
        <DirectorySyncSection
          directorySync={directorySync}
          jitRoles={jitRoles}
          onOpenPortal={() => onOpenPortal("dsync")}
        />
      ) : null}
    </>
  );
}

function StatusIndicator({ label, active = true }: { label: string; active?: boolean }) {
  return (
    <span
      className={cn(
        "flex flex-none items-center gap-1.5 text-sm",
        active ? "text-success" : "text-text-dimmed"
      )}
    >
      <span className={cn("size-1.5 rounded-full", active ? "bg-success" : "bg-charcoal-500")} />
      {label}
    </span>
  );
}

// Option content for the role dropdowns: a bright title with a wrapping,
// dimmed description beneath it. `wrap` lets long descriptions flow onto
// multiple lines instead of running off the popover edge.
function RoleSelectItem({
  id,
  name,
  description,
}: {
  id: string;
  name: string;
  description?: string;
}) {
  return (
    <SelectItem value={id} wrap>
      <span className="flex flex-col gap-1">
        <span className="text-text-bright">{name}</span>
        {description ? <span className="text-xs text-text-dimmed">{description}</span> : null}
      </span>
    </SelectItem>
  );
}

function DirectorySyncSection({
  directorySync,
  jitRoles,
  onOpenPortal,
}: {
  directorySync: DirectorySyncStatus;
  jitRoles: ReadonlyArray<Role>;
  onOpenPortal: () => void;
}) {
  const fetcher = useFetcher();
  const isSaving = fetcher.state !== "idle";

  // Deferred save; `useOverrideDraft` keeps fields poll-safe. Role drafts hold
  // the NULL_ROLE_VALUE sentinel; the action converts it to null.
  const externalDraft = useOverrideDraft(directorySync.allowExternalDomainSync);
  const manualDraft = useOverrideDraft(directorySync.allowManualMembership);
  const defaultRoleDraft = useOverrideDraft(
    directorySync.directoryDefaultRoleId ?? NULL_ROLE_VALUE
  );
  const draftExternal = externalDraft.value;
  const setDraftExternal = externalDraft.set;
  const draftManual = manualDraft.value;
  const setDraftManual = manualDraft.set;
  const draftDefaultRole = defaultRoleDraft.value;
  const setDraftDefaultRole = defaultRoleDraft.set;

  // Sparse override map of only edited groups; rendering falls back to the
  // server value so polled-in groups appear and matched overrides drop.
  const [draftGroupRoles, setDraftGroupRoles] = useState<Record<string, string>>({});
  useEffect(() => {
    setDraftGroupRoles((current) => {
      const next: Record<string, string> = {};
      for (const g of directorySync.groups) {
        const override = current[g.groupId];
        if (override === undefined) continue;
        // Keep only overrides still diverging from the server.
        if (override !== (g.mappedRoleId ?? NULL_ROLE_VALUE)) next[g.groupId] = override;
      }
      const currentKeys = Object.keys(current);
      const unchanged =
        currentKeys.length === Object.keys(next).length &&
        currentKeys.every((k) => next[k] === current[k]);
      return unchanged ? current : next;
    });
  }, [directorySync.groups]);

  const groupRolesDirty = directorySync.groups.some((g) => {
    const override = draftGroupRoles[g.groupId];
    return override !== undefined && override !== (g.mappedRoleId ?? NULL_ROLE_VALUE);
  });
  const isDirty =
    externalDraft.dirty || manualDraft.dirty || defaultRoleDraft.dirty || groupRolesDirty;

  const submitSave = () => {
    // Send only changed mappings.
    const changedGroups = directorySync.groups
      .filter((g) => {
        const override = draftGroupRoles[g.groupId];
        return override !== undefined && override !== (g.mappedRoleId ?? NULL_ROLE_VALUE);
      })
      .map((g) => ({ groupId: g.groupId, roleId: draftGroupRoles[g.groupId] }));
    fetcher.submit(
      {
        action: "save_dsync_config",
        allowExternalDomainSync: draftExternal ? "true" : "false",
        allowManualMembership: draftManual ? "true" : "false",
        directoryDefaultRoleId: draftDefaultRole,
        groupRoles: JSON.stringify(changedGroups),
      },
      { method: "POST" }
    );
  };

  return (
    <SettingsSection>
      <SettingsHeader
        title="Directory Sync"
        description="Sync users and groups from your identity provider over SCIM. Members of mapped groups are provisioned with the group's role, and removing them from your directory revokes their access."
        action={
          <Button variant="secondary/small" onClick={onOpenPortal}>
            {directorySync.directories.length === 0 ? "Connect a directory" : "Manage directory"}
          </Button>
        }
      />

      {directorySync.directories.length === 0 ? (
        <SettingsBlock>
          <Paragraph variant="small">
            No directory connected. Once connected, members of mapped groups are provisioned
            automatically.
          </Paragraph>
        </SettingsBlock>
      ) : (
        <>
          {directorySync.directories.map((dir) => (
            <SettingsRow
              key={dir.id}
              title={dir.name ?? dir.type}
              description={`${dir.type} · ${directorySync.userCount} ${
                directorySync.userCount === 1 ? "user" : "users"
              }`}
              action={
                <StatusIndicator
                  label={dir.state === "active" ? "Active" : "Inactive"}
                  active={dir.state === "active"}
                />
              }
            />
          ))}

          <SettingsRow
            title="Sync users outside verified domains"
            description="By default, only users on a verified domain are provisioned. Turn on to also provision users on other domains, such as contractors."
            action={
              <Switch
                variant="medium"
                disabled={isSaving}
                checked={draftExternal}
                onCheckedChange={setDraftExternal}
              />
            }
          />

          <SettingsRow
            title="Allow manual membership management"
            description="On by default. Turn off to let Directory Sync manage membership exclusively. While a directory is active, inviting, removing, and leaving are disabled in the dashboard."
            action={
              <Switch
                variant="medium"
                disabled={isSaving}
                checked={draftManual}
                onCheckedChange={setDraftManual}
              />
            }
          />

          <SettingsRow
            title="Default role for unmapped users"
            description={`Assigned to directory users who aren't in a mapped group. Choose "No access" to leave them unprovisioned until they join one.`}
            action={
              <Select<string, Role | { id: string; name: string; description: string }>
                value={draftDefaultRole}
                setValue={(v) => setDraftDefaultRole(v)}
                items={[{ id: NULL_ROLE_VALUE, name: "No access", description: "" }, ...jitRoles]}
                variant="secondary/small"
                dropdownIcon
                popoverClassName="max-w-xs"
                placement="bottom-end"
                text={(v) =>
                  v === NULL_ROLE_VALUE
                    ? "No access"
                    : (jitRoles.find((r) => r.id === v)?.name ?? "Select a role")
                }
              >
                {(items) =>
                  items.map((role) => (
                    <RoleSelectItem
                      key={role.id}
                      id={role.id}
                      name={role.name}
                      description={role.description}
                    />
                  ))
                }
              </Select>
            }
          />

          <SettingsHeader
            as="h3"
            title="Group roles"
            description="Map each directory group to a role. Members inherit their group's role."
          />
          {directorySync.groups.length === 0 ? (
            <SettingsBlock>
              <Paragraph variant="small">
                No groups synced yet. Groups appear here after your directory syncs.
              </Paragraph>
            </SettingsBlock>
          ) : (
            directorySync.groups.map((group) => {
              const value = draftGroupRoles[group.groupId] ?? group.mappedRoleId ?? NULL_ROLE_VALUE;
              return (
                <SettingsRow
                  key={group.groupId}
                  size="sm"
                  title={group.name}
                  titleClassName="font-medium"
                  action={
                    <Select<string, Role | { id: string; name: string; description: string }>
                      value={value}
                      setValue={(v) =>
                        setDraftGroupRoles((prev) => ({ ...prev, [group.groupId]: v }))
                      }
                      items={[
                        { id: NULL_ROLE_VALUE, name: "No access", description: "" },
                        ...jitRoles,
                      ]}
                      variant="secondary/small"
                      dropdownIcon
                      popoverClassName="max-w-xs"
                      placement="bottom-end"
                      text={(v) =>
                        v === NULL_ROLE_VALUE
                          ? "No access"
                          : (jitRoles.find((r) => r.id === v)?.name ?? "Select a role")
                      }
                    >
                      {(items) =>
                        items.map((role) => (
                          <RoleSelectItem
                            key={role.id}
                            id={role.id}
                            name={role.name}
                            description={role.description}
                          />
                        ))
                      }
                    </Select>
                  }
                />
              );
            })
          )}

          <SettingsActions>
            <Button variant="primary/small" disabled={!isDirty || isSaving} onClick={submitSave}>
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </SettingsActions>
        </>
      )}
    </SettingsSection>
  );
}

// The portal is hosted by our SSO vendor, so the friendly name is derived from
// the link's host (e.g. setup.workos.com -> WorkOS). Falls back to the
// capitalized root label, then to a generic label if the URL can't be parsed.
const KNOWN_PORTAL_PROVIDERS: Record<string, string> = { workos: "WorkOS" };

function portalProviderName(url: string | null): string | null {
  if (!url) return null;
  try {
    const labels = new URL(url).hostname.split(".").filter(Boolean);
    const root = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    if (!root) return null;
    return KNOWN_PORTAL_PROVIDERS[root.toLowerCase()] ?? root[0].toUpperCase() + root.slice(1);
  } catch {
    return null;
  }
}

function PortalLinkDialog({
  url,
  intent,
  onClose,
}: {
  url: string | null;
  intent: "sso" | "domain_verification" | "dsync" | null;
  onClose: () => void;
}) {
  const purpose =
    intent === "domain_verification"
      ? "Single-use link to verify your email domains. Share it with whoever manages your DNS."
      : intent === "sso"
        ? "Single-use link to connect your identity provider. Share it with whoever manages it."
        : intent === "dsync"
          ? "Single-use link to set up Directory Sync over SCIM. Share it with whoever manages your identity provider."
          : "Single-use link to set up SSO.";
  const providerName = portalProviderName(url);
  return (
    <Dialog open={url !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>Admin portal link</DialogHeader>
        <DialogDescription className="text-sm">
          {purpose} It expires 5 minutes after this dialog opens.
        </DialogDescription>
        <ClipboardField value={url ?? ""} variant="secondary/medium" />
        <DialogFooter>
          <Button variant="secondary/small" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary/small"
            TrailingIcon={ArrowUpRightIcon}
            onClick={() => {
              if (!url) return;
              // Single-use link; `noopener,noreferrer` isolates the new tab.
              window.open(url, "_blank", "noopener,noreferrer");
              onClose();
            }}
          >
            {providerName ? `Open in ${providerName}` : "Open in new tab"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EnforceConfirmDialog({
  open,
  orgTitle,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  orgTitle: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>Enable SSO enforcement for {orgTitle}?</DialogHeader>
        <DialogDescription>
          Users with an email on a verified domain will be redirected to your identity provider to
          sign in. They can no longer use magic link, GitHub, or Google for that domain.
          <br />
          <br />
          Users with other emails, such as contractors, keep their existing sign-in methods.
        </DialogDescription>
        <DialogFooter>
          <Button variant="secondary/small" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary/small" onClick={onConfirm}>
            Enable enforcement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
