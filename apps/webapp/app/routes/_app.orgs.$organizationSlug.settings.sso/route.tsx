import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  LockClosedIcon,
} from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { redirect } from "@remix-run/server-runtime";
import { useEffect, useState } from "react";
import { useFetcher, useRevalidator } from "@remix-run/react";
import { z } from "zod";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "~/components/primitives/Dialog";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
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
import { throwPermissionDenied } from "~/utils/permissionDenied";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { v3BillingPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Identity & Access | Trigger.dev" }];

const Params = z.object({ organizationSlug: z.string() });

async function resolveOrg(slug: string) {
  // Use primary: this slug→id lookup scopes the org-level RBAC/entitlement
  // checks (loader and action), and replica lag could run them against a
  // stale or missing org scope.
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

// The render-level upsell (planAllowsSso on the client) is cosmetic —
// any org member could still POST the actions directly. Mutations that
// provision real IdP-side resources are gated here, server-side.
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

// SSO availability for an org: the per-org feature flag wins, else the global
// flag (default off). This is the single rollout knob for the whole feature —
// SSO and Directory Sync are both gated by it (there is no separate dsync flag).
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
    // No static `authorization` gate here: SSO is plan-gated *before* it's
    // role-gated. A non-Enterprise org must render the upsell for everyone —
    // gating on manage:sso at the wrapper would show a non-Owner "Permission
    // denied" for a feature their org can't use yet. We resolve the plan in
    // the body and only enforce manage:sso once the org is actually entitled.
  },
  async ({ context, ability }) => {
    // True only when SSO_ENABLED is on and a real SSO plugin is loaded.
    if (!(await ssoController.isUsingPlugin())) {
      throw new Response("Not Found", { status: 404 });
    }

    const orgId = context.organizationId;
    if (!orgId) {
      throw new Response("Not Found", { status: 404 });
    }

    // Plan first. When the org isn't on Enterprise the page renders the
    // upsell state for every role, so we skip the role check (and the
    // SSO/role queries it would gate) and return empty data.
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

    // Entitled: the page is now a real config surface, so enforce the role
    // gate. A non-Owner without manage:sso gets the permission panel — the
    // same 403 the dashboardLoader `authorization` block would have thrown.
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

    // JIT can't promote new users to Owner — that role is reserved for
    // the founding member and explicit transfers. Plan-gated roles are
    // filtered out via the assignable set so the UI doesn't offer
    // something the org can't actually use.
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

// Don't use `z.coerce.boolean()` — it goes through JS `Boolean()`,
// which treats the string "false" as truthy (any non-empty string).
const boolish = z.union([z.literal("true"), z.literal("false")]).transform((v) => v === "true");

// Only-changed group→role mappings sent by the deferred Directory Sync Save.
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
  // Directory Sync section is a single deferred Save (like the SSO config
  // form): all settings + changed group mappings commit together.
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
        // The form is a single Save, so the three fields must commit
        // all-or-nothing: `updateConfig` writes them in one transaction
        // (with the JIT-role RBAC check inside it), so a failure leaves
        // none of the fields changed rather than a partial config.
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
        // Parse the changed group→role mappings the deferred Save sent.
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
        // Hoist out of the narrowed `parsed.data` — the discriminated-union
        // narrowing doesn't survive into the thunk closures below.
        const { allowExternalDomainSync, allowManualMembership } = parsed.data;

        // Apply the OrgSsoConfig columns first. Not one transaction (group
        // mappings are separate rows), but each write is idempotent, so a retry
        // of the whole Save converges. Thunks (not pre-started ResultAsyncs) so
        // they run strictly one at a time and the first failure stops the rest
        // rather than leaving later writes to apply in the background.
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

        // Each group remap returns the membership effects it implies for that
        // group's current members (roles recomputed against the new mapping,
        // deprovision when cleared to "No access" and it was their last mapped
        // group). Collect and apply them so the remap takes effect immediately.
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
  // Persisted value wins, even when it points at something the picker
  // can no longer offer — keeps the user's prior choice visible.
  if (current) return current;
  const dev = jitRoles.find((r) => r.name === DEFAULT_JIT_ROLE_NAME);
  return dev?.id ?? NULL_ROLE_VALUE;
}

// A settings field that mirrors a server value but is locally editable, safe
// to use while the whole page polls: as long as the user hasn't touched the
// field, it adopts fresh server values from revalidation; once edited (dirty)
// it holds the user's value until the server catches up (a successful Save, or
// another admin setting the same value), at which point it snaps back to clean.
// `dirty` never fires a false positive from a poll because the override is
// dropped as soon as the server value matches it.
function useOverrideDraft<T>(serverValue: T): {
  value: T;
  set: (next: T) => void;
  dirty: boolean;
} {
  const [override, setOverride] = useState<{ value: T } | null>(null);
  useEffect(() => {
    // Server caught up to the pending edit → clear the override (back to clean).
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

  // Deferred-save: each field mirrors `status` but stays locally editable.
  // `useOverrideDraft` lets the page poll safely — untouched fields adopt
  // fresh server values, edited fields are preserved until Save.
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

  // Poll the whole page while entitled — before an active connection this
  // reflects portal progress (domain verified, connection activated), and
  // once active it keeps SSO + Directory Sync state fresh (connection
  // deleted/deactivated, directory activated/deactivated/deleted, new
  // groups). Draft edits survive revalidation because every editable field
  // goes through `useOverrideDraft` (dirty fields preserved, clean fields
  // adopt server values). The upsell state is excluded by `isEntitled`.
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
        <PageTitle title="Identity & Access" />
      </NavBar>
      <PageBody scrollable={true}>
        <MainHorizontallyCenteredContainer className="max-w-3xl space-y-6">
          {!isEntitled ? (
            <EnterpriseUpsellState organizationSlug={organization.slug} />
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
                // Going on→off is harmless; going off→on locks users out so
                // we still require explicit confirmation. The modal updates
                // the draft only; nothing is persisted until Save.
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
        </MainHorizontallyCenteredContainer>
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

function EnterpriseUpsellState({ organizationSlug }: { organizationSlug: string }) {
  return (
    <div className="space-y-4 rounded-md border border-indigo-500/30 bg-indigo-500/5 p-5">
      <div className="flex items-center gap-2">
        <LockClosedIcon className="size-5 text-indigo-400" />
        <Header2>SSO is available on the Enterprise plan</Header2>
      </div>
      <Paragraph variant="base">
        Single sign-on (SAML / OIDC) lets your IT admins manage who can access Trigger.dev through
        your identity provider — Okta, Azure AD, Google Workspace, OneLogin, and more. Upgrade your
        organization to Enterprise to configure it.
      </Paragraph>
      <ul className="ml-4 list-disc space-y-1 text-sm text-text-dimmed">
        <li>Self-service domain verification and connection setup via the admin portal.</li>
        <li>Just-in-time user provisioning for your verified domains.</li>
        <li>Per-domain enforcement so contractors keep using existing sign-in methods.</li>
      </ul>
      <div className="flex flex-wrap gap-2 pt-1">
        <LinkButton variant="primary/small" to={v3BillingPath({ slug: organizationSlug })}>
          Talk to sales
        </LinkButton>
        <LinkButton variant="tertiary/small" to="https://trigger.dev/contact" target="_blank">
          Contact us
        </LinkButton>
      </div>
    </div>
  );
}

function NoIdpOrgState({ onOpenPortal }: { onOpenPortal: () => void }) {
  return (
    <div className="space-y-3">
      <Header2>Configure SSO for your organization</Header2>
      <Paragraph variant="base">
        Single sign-on lets your IT admins manage who can access Trigger.dev through your identity
        provider (Okta, Azure AD, Google Workspace, OneLogin, and more).
      </Paragraph>
      <Button
        variant="tertiary/small"
        onClick={onOpenPortal}
        LeadingIcon={ArrowTopRightOnSquareIcon}
      >
        Start the process
      </Button>
    </div>
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
    <div className="space-y-6">
      <div className="space-y-2">
        <Header2>Domains</Header2>
        <Paragraph variant="small" className="text-text-dimmed">
          Verify the email domains your team signs in with. Once a domain is verified you can
          connect your identity provider.
        </Paragraph>
        {failedDomains.length > 0 && (
          <Callout variant="error">
            {failedDomains.length === 1
              ? `Domain verification failed for ${failedDomains[0].domain}. Re-check the DNS records in the admin portal and re-run verification.`
              : `${failedDomains.length} domains failed verification. Re-check the DNS records in the admin portal and re-run verification.`}
          </Callout>
        )}
        {domains.length > 0 && <DomainList domains={domains} />}
        <Button
          variant="tertiary/small"
          onClick={onOpenDomain}
          LeadingIcon={ArrowTopRightOnSquareIcon}
        >
          {domains.length > 0 ? "Verify another domain" : "Verify domain"}
        </Button>
      </div>

      {hasVerifiedDomain && (
        <div className="space-y-2">
          <Header2>SSO</Header2>
          <Paragraph variant="small" className="text-text-dimmed">
            Connect your identity provider to finish setting up single sign-on for your verified
            domains.
          </Paragraph>
          <Button
            variant="tertiary/small"
            onClick={onOpenSso}
            LeadingIcon={ArrowTopRightOnSquareIcon}
          >
            Configure SSO
          </Button>
        </div>
      )}

      {/* Directory Sync is independent of SSO — once a domain is verified an org
          can connect a directory without ever configuring SSO. */}
      {hasVerifiedDomain && hasSso ? (
        <DirectorySyncSection
          directorySync={directorySync}
          jitRoles={jitRoles}
          onOpenPortal={onOpenDsync}
        />
      ) : null}
    </div>
  );
}

function DomainList({ domains }: { domains: ReadonlyArray<DomainRow> }) {
  return (
    <ul className="space-y-1">
      {domains.map((d) => {
        const visual = domainVisual(d.state);
        return (
          <li
            key={d.domain}
            className={`flex items-start justify-between gap-3 rounded-md border px-3 py-1.5 ${visual.row}`}
          >
            <div className="flex flex-col">
              <span className="font-mono text-sm">{d.domain}</span>
              {d.state === "failed" && d.verificationFailedReason && (
                <span className="mt-0.5 text-xxs text-rose-300">
                  Reason: <span className="font-mono">{d.verificationFailedReason}</span>
                </span>
              )}
            </div>
            <span className={`flex shrink-0 items-center gap-1 text-xs ${visual.label}`}>
              {visual.icon}
              {d.state}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function domainVisual(state: DomainRow["state"]) {
  switch (state) {
    case "verified":
      return {
        row: "border-emerald-500/30 bg-emerald-500/5",
        label: "text-emerald-400",
        icon: <CheckCircleIcon className="size-3.5" />,
      };
    case "failed":
      return {
        row: "border-rose-500/30 bg-rose-500/5",
        label: "text-rose-400",
        icon: <ExclamationCircleIcon className="size-3.5" />,
      };
    case "pending":
    default:
      return {
        row: "border-amber-500/20 bg-amber-500/5",
        label: "text-amber-400",
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
    <div className="space-y-6">
      <div className="space-y-2">
        <Header2>Verified domains</Header2>
        {status.domains.length === 0 ? (
          <Paragraph variant="small" className="text-text-dimmed">
            No domains verified yet.
          </Paragraph>
        ) : (
          <DomainList domains={status.domains} />
        )}
        <Button
          variant="tertiary/small"
          onClick={() => onOpenPortal("domain_verification")}
          LeadingIcon={ArrowTopRightOnSquareIcon}
        >
          {status.domains.length > 0 ? "Verify another domain" : "Verify domain"}
        </Button>
      </div>

      <div className="space-y-2">
        <Header2>{orgTitle} – SSO connection</Header2>
        {activeConnections.map((conn) => (
          <div
            key={conn.id}
            className="rounded-md border border-grid-bright bg-charcoal-800 px-3 py-2"
          >
            <Paragraph variant="small" className="text-text-bright">
              {conn.name ?? conn.connectionType}
            </Paragraph>
            <Paragraph variant="extra-small" className="text-text-dimmed">
              Type: {conn.connectionType}
            </Paragraph>
          </div>
        ))}
        <Button
          variant="tertiary/small"
          onClick={() => onOpenPortal("sso")}
          LeadingIcon={ArrowTopRightOnSquareIcon}
        >
          Manage SSO connection
        </Button>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between rounded-md border border-grid-bright px-3 py-2.5">
          <div>
            <Paragraph variant="small" className="text-text-bright">
              Require SSO for matching domains
            </Paragraph>
            <Paragraph variant="extra-small" className="text-text-dimmed">
              When on, users whose email matches a verified domain must use SSO to sign in.
            </Paragraph>
          </div>
          <Switch variant="small" checked={draftEnforced} onCheckedChange={onToggleEnforced} />
        </div>
        <div className="flex items-center justify-between rounded-md border border-grid-bright px-3 py-2.5">
          <div>
            <Paragraph variant="small" className="text-text-bright">
              JIT provisioning
            </Paragraph>
            <Paragraph variant="extra-small" className="text-text-dimmed">
              Auto-create memberships for first-time SSO sign-ins from your verified domains.
            </Paragraph>
          </div>
          <Switch variant="small" checked={draftJitEnabled} onCheckedChange={onToggleJit} />
        </div>
        <div className="flex items-center justify-between rounded-md border border-grid-bright px-3 py-2.5">
          <div>
            <Paragraph variant="small" className="text-text-bright">
              Default role for JIT provisioned users
            </Paragraph>
            <Paragraph variant="extra-small" className="text-text-dimmed pr-0.5">
              Role assigned to new users created via JIT provisioning. Owner is reserved and cannot
              be granted automatically.
            </Paragraph>
          </div>
          <Select<string, Role>
            value={draftJitRoleId}
            setValue={(v) => onChangeJitRole(v)}
            items={[...jitRoles]}
            variant="tertiary/small"
            dropdownIcon
            text={(v) => jitRoles.find((r) => r.id === v)?.name ?? "Select a role"}
          >
            {(items) =>
              items.map((role) => (
                <SelectItem key={role.id} value={role.id}>
                  <span className="flex flex-col">
                    <span>{role.name}</span>
                    {role.description ? (
                      <span className="text-xs text-text-dimmed">{role.description}</span>
                    ) : null}
                  </span>
                </SelectItem>
              ))
            }
          </Select>
        </div>
        <div className="flex justify-end pt-1">
          <Button variant="primary/small" disabled={!isDirty || isSaving} onClick={onSave}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {hasSso ? (
        <DirectorySyncSection
          directorySync={directorySync}
          jitRoles={jitRoles}
          onOpenPortal={() => onOpenPortal("dsync")}
        />
      ) : null}
    </div>
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

  // Deferred save: edits stay local until Save commits them all together
  // (mirrors the SSO Configuration form). `useOverrideDraft` keeps the fields
  // safe under whole-page polling — untouched fields adopt fresh server
  // values, edited ones are preserved. Role values keep the NULL_ROLE_VALUE
  // sentinel in the draft; the action converts it to null on write.
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

  // Group mappings vary in count, so instead of one draft per group we keep a
  // sparse map of only the groups the user has edited (overrides). Rendering
  // falls back to the server value, so new groups arriving via polling show up
  // immediately, and an override is dropped once the server catches up to it.
  const [draftGroupRoles, setDraftGroupRoles] = useState<Record<string, string>>({});
  useEffect(() => {
    setDraftGroupRoles((current) => {
      const next: Record<string, string> = {};
      for (const g of directorySync.groups) {
        const override = current[g.groupId];
        if (override === undefined) continue;
        // Keep only overrides that still diverge from the server (drops
        // saved/externally-matched edits and edits for removed groups).
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
    // Send only the group mappings that actually changed.
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
    <div className="space-y-3">
      <Header2>Directory Sync</Header2>
      <Paragraph variant="small" className="text-text-dimmed">
        Sync users and groups from your identity provider (SCIM). Members in mapped groups are
        provisioned automatically, their role follows the group mapping, and removing a user from
        your directory removes their access here.
      </Paragraph>

      {directorySync.directories.length === 0 ? (
        <Button
          variant="tertiary/small"
          onClick={onOpenPortal}
          LeadingIcon={ArrowTopRightOnSquareIcon}
        >
          Connect a directory
        </Button>
      ) : (
        <>
          {directorySync.directories.map((dir) => (
            <div
              key={dir.id}
              className="flex items-center justify-between rounded-md border border-grid-bright bg-charcoal-800 px-3 py-2"
            >
              <div>
                <Paragraph variant="small" className="text-text-bright">
                  {dir.name ?? dir.type}
                </Paragraph>
                <Paragraph variant="extra-small" className="text-text-dimmed">
                  {dir.type} · {dir.state === "active" ? "Active" : "Inactive"} ·{" "}
                  {directorySync.userCount} {directorySync.userCount === 1 ? "user" : "users"}
                </Paragraph>
              </div>
            </div>
          ))}
          <Button
            variant="tertiary/small"
            onClick={onOpenPortal}
            LeadingIcon={ArrowTopRightOnSquareIcon}
          >
            Manage directory
          </Button>

          <div className="flex items-center justify-between rounded-md border border-grid-bright px-3 py-2.5">
            <div>
              <Paragraph variant="small" className="text-text-bright">
                Sync users outside verified domains
              </Paragraph>
              <Paragraph variant="extra-small" className="text-text-dimmed">
                By default only directory users whose email domain is verified for this org are
                provisioned. Turn on to also provision users on other domains (e.g. contractors).
              </Paragraph>
            </div>
            <Switch
              variant="small"
              disabled={isSaving}
              checked={draftExternal}
              onCheckedChange={setDraftExternal}
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-grid-bright px-3 py-2.5">
            <div>
              <Paragraph variant="small" className="text-text-bright">
                Allow manual membership management
              </Paragraph>
              <Paragraph variant="extra-small" className="text-text-dimmed">
                On by default. Turn off to let Directory Sync manage membership exclusively — while
                a directory is active, inviting, removing, and leaving are disabled in the
                dashboard.
              </Paragraph>
            </div>
            <Switch
              variant="small"
              disabled={isSaving}
              checked={draftManual}
              onCheckedChange={setDraftManual}
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-grid-bright px-3 py-2.5">
            <div>
              <Paragraph variant="small" className="text-text-bright">
                Default role for users without a mapped group
              </Paragraph>
              <Paragraph variant="extra-small" className="text-text-dimmed pr-0.5">
                Directory users who belong to no mapped group are provisioned at this role
                (Developer by default). Choose "No access" to leave them unprovisioned until they
                join a mapped group.
              </Paragraph>
            </div>
            <Select<string, Role | { id: string; name: string; description: string }>
              value={draftDefaultRole}
              setValue={(v) => setDraftDefaultRole(v)}
              items={[{ id: NULL_ROLE_VALUE, name: "No access", description: "" }, ...jitRoles]}
              variant="tertiary/small"
              dropdownIcon
              text={(v) =>
                v === NULL_ROLE_VALUE
                  ? "No access"
                  : (jitRoles.find((r) => r.id === v)?.name ?? "Select a role")
              }
            >
              {(items) =>
                items.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    <span className="flex flex-col">
                      <span>{role.name}</span>
                      {role.description ? (
                        <span className="text-xs text-text-dimmed">{role.description}</span>
                      ) : null}
                    </span>
                  </SelectItem>
                ))
              }
            </Select>
          </div>

          <div className="space-y-1">
            <Paragraph variant="small" className="text-text-bright">
              Group → role mapping
            </Paragraph>
            {directorySync.groups.length === 0 ? (
              <Paragraph variant="extra-small" className="text-text-dimmed">
                No directory groups synced yet. Groups appear here once your directory syncs them.
              </Paragraph>
            ) : (
              directorySync.groups.map((group) => {
                const value =
                  draftGroupRoles[group.groupId] ?? group.mappedRoleId ?? NULL_ROLE_VALUE;
                return (
                  <div
                    key={group.groupId}
                    className="flex items-center justify-between rounded-md border border-grid-bright px-3 py-2"
                  >
                    <Paragraph variant="small" className="text-text-bright">
                      {group.name}
                    </Paragraph>
                    <Select<string, Role | { id: string; name: string; description: string }>
                      value={value}
                      setValue={(v) =>
                        setDraftGroupRoles((prev) => ({ ...prev, [group.groupId]: v }))
                      }
                      items={[
                        { id: NULL_ROLE_VALUE, name: "No access", description: "" },
                        ...jitRoles,
                      ]}
                      variant="tertiary/small"
                      dropdownIcon
                      text={(v) =>
                        v === NULL_ROLE_VALUE
                          ? "No access"
                          : (jitRoles.find((r) => r.id === v)?.name ?? "Select a role")
                      }
                    >
                      {(items) =>
                        items.map((role) => (
                          <SelectItem key={role.id} value={role.id}>
                            <span className="flex flex-col">
                              <span>{role.name}</span>
                              {role.description ? (
                                <span className="text-xs text-text-dimmed">{role.description}</span>
                              ) : null}
                            </span>
                          </SelectItem>
                        ))
                      }
                    </Select>
                  </div>
                );
              })
            )}
          </div>

          <div className="flex justify-end pt-1">
            <Button variant="primary/small" disabled={!isDirty || isSaving} onClick={submitSave}>
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
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
      ? "This single-use link opens domain verification. Send it to whoever manages your DNS or identity provider so they can confirm your organization owns its email domains."
      : intent === "sso"
        ? "This single-use link opens identity-provider setup. Send it to whoever manages your identity provider so they can connect it to Trigger.dev."
        : intent === "dsync"
          ? "This single-use link opens directory sync (SCIM) setup. Send it to whoever manages your identity provider so they can connect your directory to Trigger.dev."
          : "This single-use link opens your organization's SSO setup.";
  return (
    <Dialog open={url !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>Admin portal link</DialogHeader>
        <DialogDescription>
          {purpose} The link expires 5 minutes after you open this dialog.
        </DialogDescription>
        <div className="mt-4 break-all rounded-md border border-grid-bright bg-charcoal-800 p-3 font-mono text-xs">
          {url ?? ""}
        </div>
        <DialogFooter>
          <Button variant="tertiary/small" onClick={onClose}>
            Cancel
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="tertiary/small"
              onClick={() => {
                if (url) {
                  navigator.clipboard?.writeText(url);
                }
              }}
            >
              Copy link
            </Button>
            <Button
              variant="primary/small"
              LeadingIcon={ArrowTopRightOnSquareIcon}
              onClick={() => {
                if (!url) return;
                // Single-use links — `noopener,noreferrer` keeps the new
                // tab from inheriting any session context from the dashboard.
                window.open(url, "_blank", "noopener,noreferrer");
                onClose();
              }}
            >
              Open in new tab
            </Button>
          </div>
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
          Once enabled, users whose email domain matches your verified domains will be redirected to
          your identity provider to sign in. They will no longer be able to use magic link, GitHub,
          or Google via that domain.
          <br />
          <br />
          Users with non-matching emails (e.g. contractors with personal emails) will continue to
          use existing methods.
        </DialogDescription>
        <DialogFooter>
          <Button variant="tertiary/small" onClick={onCancel}>
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
