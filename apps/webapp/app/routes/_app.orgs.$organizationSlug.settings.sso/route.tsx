import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  LockClosedIcon,
} from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { redirect, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { useEffect, useState } from "react";
import { useFetcher } from "@remix-run/react";
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
import { $replica } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { rbac } from "~/services/rbac.server";
import { ssoController } from "~/services/sso.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import type { Role } from "@trigger.dev/plugins";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { v3BillingPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "SSO settings | Trigger.dev" }];

const Params = z.object({ organizationSlug: z.string() });

async function resolveOrg(slug: string) {
  return $replica.organization.findFirst({
    where: { slug },
    select: { id: true, title: true },
  });
}

function planAllowsSso(plan: unknown): boolean {
  if (!plan || typeof plan !== "object") return false;
  const subscription = (plan as { v3Subscription?: { plan?: { code?: string } } })
    .v3Subscription;
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

export const loader = dashboardLoader(
  {
    params: Params,
    context: async (params) => {
      const org = await resolveOrg(params.organizationSlug);
      return org ? { organizationId: org.id, orgTitle: org.title } : {};
    },
    authorization: { action: "manage", resource: { type: "sso" } },
  },
  async ({ context, request }) => {
    const { isManagedCloud } = featuresForRequest(request);
    // Gate on managed cloud AND the SSO plugin actually being loaded
    // (SSO_ENABLED off → OSS fallback → isUsingPlugin false). Without
    // this the page renders for every managed-cloud org even when SSO
    // is disabled for the deployment.
    if (!isManagedCloud || !(await ssoController.isUsingPlugin())) {
      throw new Response("Not Found", { status: 404 });
    }

    const orgId = context.organizationId;
    if (!orgId) {
      throw new Response("Not Found", { status: 404 });
    }

    // The page is reachable on every paid + free plan; when the org
    // isn't on Enterprise we render the upsell state instead of the
    // SSO UI. Plan-tier enforcement lives in the React render so the
    // sidebar entry and the page itself stay aligned.
    const [statusResult, allRoles, assignableIds] = await Promise.all([
      ssoController.getStatus(orgId),
      rbac.allRoles(orgId),
      rbac.getAssignableRoleIds(orgId),
    ]);
    const status = statusResult.isOk()
      ? statusResult.value
      : {
          hasIdpOrg: false,
          enforced: false,
          jitProvisioningEnabled: false,
          jitDefaultRoleId: null,
          idpOrgId: null,
          primaryConnectionId: null,
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

    // JIT can't promote new users to Owner — that role is reserved for
    // the founding member and explicit transfers. Plan-gated roles are
    // filtered out via the assignable set so the UI doesn't offer
    // something the org can't actually use.
    const assignable = new Set(assignableIds);
    const jitRoles = allRoles.filter(
      (r) => r.name !== "Owner" && assignable.has(r.id)
    );

    return typedjson({ status, orgTitle: context.orgTitle, jitRoles });
  }
);

const NULL_ROLE_VALUE = "__none__";
const DEFAULT_JIT_ROLE_NAME = "Developer";

// Don't use `z.coerce.boolean()` — it goes through JS `Boolean()`,
// which treats the string "false" as truthy (any non-empty string).
const boolish = z
  .union([z.literal("true"), z.literal("false")])
  .transform((v) => v === "true");

const ActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save_config"),
    enforced: boolish,
    jitEnabled: boolish,
    jitRoleId: z.string(),
  }),
  z.object({
    action: z.literal("portal_link"),
    intent: z.enum(["sso", "domain_verification"]),
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

    const { isManagedCloud } = featuresForRequest(request);
    if (!isManagedCloud) {
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
    });
    if (!parsed.success) {
      return new Response("Bad Request", { status: 400 });
    }

    switch (parsed.data.action) {
      case "save_config": {
        const jitRoleId =
          parsed.data.jitRoleId === NULL_ROLE_VALUE ? null : parsed.data.jitRoleId;
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
    }
  }
);

function defaultJitRoleId(
  jitRoles: ReadonlyArray<Role>,
  current: string | null
): string {
  // Persisted value wins, even when it points at something the picker
  // can no longer offer — keeps the user's prior choice visible.
  if (current) return current;
  const dev = jitRoles.find((r) => r.name === DEFAULT_JIT_ROLE_NAME);
  return dev?.id ?? NULL_ROLE_VALUE;
}

export default function Page() {
  const { status, orgTitle, jitRoles } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const _plan = useCurrentPlan();

  const isEntitled = planAllowsSso(_plan);
  const activeConnections = status.connections.filter((c) => c.state === "active");
  const hasActive = activeConnections.length > 0;

  // Deferred-save: each field starts mirrored from `status`, edits stay
  // local until Save commits all three to the action. The `key` trick
  // below resets local state after a successful save (when `status`
  // changes via revalidation following the redirect).
  const initialJitRoleId = defaultJitRoleId(jitRoles, status.jitDefaultRoleId);
  const [draftEnforced, setDraftEnforced] = useState(status.enforced);
  const [draftJitEnabled, setDraftJitEnabled] = useState(status.jitProvisioningEnabled);
  const [draftJitRoleId, setDraftJitRoleId] = useState(initialJitRoleId);

  // Re-sync drafts when the loader returns fresh `status` (post-save
  // redirect → revalidation). useEffect rather than a memo so we don't
  // stomp in-flight edits during the same render.
  useEffect(() => {
    setDraftEnforced(status.enforced);
    setDraftJitEnabled(status.jitProvisioningEnabled);
    setDraftJitRoleId(defaultJitRoleId(jitRoles, status.jitDefaultRoleId));
    // jitRoles only changes if the org changes; the role list itself is
    // stable across saves on a given org.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.enforced, status.jitProvisioningEnabled, status.jitDefaultRoleId]);

  const isDirty =
    draftEnforced !== status.enforced ||
    draftJitEnabled !== status.jitProvisioningEnabled ||
    draftJitRoleId !== initialJitRoleId;

  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [enforceModalOpen, setEnforceModalOpen] = useState(false);
  const portalFetcher = useFetcher<{ ok: boolean; url?: string; error?: string }>();
  const saveFetcher = useFetcher();
  const isSaving = saveFetcher.state !== "idle";

  useEffect(() => {
    if (portalFetcher.data?.ok && portalFetcher.data.url) {
      setPortalUrl(portalFetcher.data.url);
    }
  }, [portalFetcher.data]);

  const openPortal = (intent: "sso" | "domain_verification") => {
    setPortalUrl(null);
    portalFetcher.submit(
      { action: "portal_link", intent },
      { method: "POST" }
    );
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
        <PageTitle title="SSO" />
      </NavBar>
      <PageBody scrollable={true}>
        <MainHorizontallyCenteredContainer className="max-w-3xl space-y-6">
          {!isEntitled ? (
            <EnterpriseUpsellState organizationSlug={organization.slug} />
          ) : !status.hasIdpOrg ? (
            <NoIdpOrgState onOpenPortal={() => openPortal("sso")} />
          ) : !hasActive ? (
            <NoActiveConnectionState
              domains={status.domains}
              onOpenSso={() => openPortal("sso")}
              onOpenDomain={() => openPortal("domain_verification")}
            />
          ) : (
            <ActiveConnectionState
              orgTitle={orgTitle ?? organization.title}
              status={status}
              activeConnections={activeConnections}
              jitRoles={jitRoles}
              draftEnforced={draftEnforced}
              draftJitEnabled={draftJitEnabled}
              draftJitRoleId={draftJitRoleId}
              isDirty={isDirty}
              isSaving={isSaving}
              onTogglePortal={() => openPortal("sso")}
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

      <PortalLinkDialog url={portalUrl} onClose={() => setPortalUrl(null)} />

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
        Single sign-on (SAML / OIDC) lets your IT admins manage who can access Trigger.dev
        through your identity provider — Okta, Azure AD, Google Workspace, OneLogin, and more.
        Upgrade your organization to Enterprise to configure it.
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
        <LinkButton
          variant="tertiary/small"
          to="https://trigger.dev/contact"
          target="_blank"
        >
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
        Single sign-on lets your IT admins manage who can access Trigger.dev through your
        identity provider (Okta, Azure AD, Google Workspace, OneLogin, and more). The first
        click opens the admin portal in a 5-minute single-use link.
      </Paragraph>
      <Button variant="primary/small" onClick={onOpenPortal} LeadingIcon={LockClosedIcon}>
        Open admin portal
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
  onOpenSso,
  onOpenDomain,
}: {
  domains: ReadonlyArray<DomainRow>;
  onOpenSso: () => void;
  onOpenDomain: () => void;
}) {
  const verifiedDomains = domains.filter((d) => d.state === "verified");
  const failedDomains = domains.filter((d) => d.state === "failed");
  const pendingDomains = domains.filter((d) => d.state === "pending");
  const hasUnresolved = failedDomains.length > 0 || pendingDomains.length > 0;

  return (
    <div className="space-y-4">
      {failedDomains.length > 0 && (
        <Callout variant="error">
          {failedDomains.length === 1
            ? `Domain verification failed for ${failedDomains[0].domain}. Re-check the DNS records in the admin portal and re-run verification.`
            : `${failedDomains.length} domains failed verification. Re-check the DNS records in the admin portal and re-run verification.`}
        </Callout>
      )}
      {failedDomains.length === 0 && verifiedDomains.length > 0 && (
        <Callout variant="success">
          {verifiedDomains.length === 1
            ? `Domain verified: ${verifiedDomains[0].domain}. Continue in the admin portal to finish setting up your identity provider connection.`
            : `${verifiedDomains.length} domains verified. Continue in the admin portal to finish setting up your identity provider connection.`}
        </Callout>
      )}
      {failedDomains.length === 0 && verifiedDomains.length === 0 && (
        <Callout variant="warning">
          Not yet configured. Continue in the admin portal to verify a domain and set up your
          identity provider connection.
        </Callout>
      )}

      {domains.length > 0 && (
        <div className="space-y-2">
          <Header2>Domains</Header2>
          <DomainList domains={domains} />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="primary/small" onClick={onOpenSso}>
          Configure SSO
        </Button>
        <Button variant="tertiary/small" onClick={onOpenDomain}>
          {failedDomains.length > 0
            ? "Re-verify a domain"
            : hasUnresolved
              ? "Continue verifying a domain"
              : "Verify another domain"}
        </Button>
      </div>
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
  draftEnforced,
  draftJitEnabled,
  draftJitRoleId,
  isDirty,
  isSaving,
  onTogglePortal,
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
  draftEnforced: boolean;
  draftJitEnabled: boolean;
  draftJitRoleId: string;
  isDirty: boolean;
  isSaving: boolean;
  onTogglePortal: () => void;
  onToggleEnforced: (next: boolean) => void;
  onToggleJit: (next: boolean) => void;
  onChangeJitRole: (roleId: string | null) => void;
  onSave: () => void;
}) {
  return (
    <div className="space-y-6">
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
      </div>

      <div className="space-y-2">
        <Header2>Verified domains</Header2>
        {status.domains.length === 0 ? (
          <Paragraph variant="small" className="text-text-dimmed">
            No domains verified yet.
          </Paragraph>
        ) : (
          <DomainList domains={status.domains} />
        )}
      </div>

      <div className="space-y-3">
        <Header2>Configuration</Header2>
        <div className="flex items-center justify-between rounded-md border border-grid-bright px-3 py-2.5">
          <div>
            <Paragraph variant="small" className="text-text-bright">
              Require SSO for matching domains
            </Paragraph>
            <Paragraph variant="extra-small" className="text-text-dimmed">
              When on, users whose email matches a verified domain must use SSO to sign in.
            </Paragraph>
          </div>
          <Switch
            variant="small"
            checked={draftEnforced}
            onCheckedChange={onToggleEnforced}
          />
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
          <Switch
            variant="small"
            checked={draftJitEnabled}
            onCheckedChange={onToggleJit}
          />
        </div>
        <div className="flex items-center justify-between rounded-md border border-grid-bright px-3 py-2.5">
          <div>
            <Paragraph variant="small" className="text-text-bright">
              Default role for JIT provisioned users
            </Paragraph>
            <Paragraph variant="extra-small" className="text-text-dimmed pr-0.5">
              Role assigned to new users created via JIT provisioning. Owner is reserved
              and cannot be granted automatically.
            </Paragraph>
          </div>
          <Select<string, Role | { id: string; name: string; description: string }>
            value={draftJitRoleId}
            setValue={(v) => onChangeJitRole(v === NULL_ROLE_VALUE ? null : v)}
            items={[
              { id: NULL_ROLE_VALUE, name: "None", description: "" },
              ...jitRoles,
            ]}
            variant="tertiary/small"
            dropdownIcon
            text={(v) =>
              v === NULL_ROLE_VALUE
                ? "None"
                : jitRoles.find((r) => r.id === v)?.name ?? "Select a role"
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
        <div className="flex items-center justify-between pt-1">
          <LinkButton
            to="#"
            variant="tertiary/small"
            LeadingIcon={ArrowTopRightOnSquareIcon}
            onClick={(e) => {
              e.preventDefault();
              onTogglePortal();
            }}
          >
            Open admin portal
          </LinkButton>
          <Button
            variant="primary/small"
            disabled={!isDirty || isSaving}
            onClick={onSave}
          >
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PortalLinkDialog({
  url,
  onClose,
}: {
  url: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={url !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>Admin portal link</DialogHeader>
        <DialogDescription>
          This link is active for 5 minutes — copy it and share it with your IT contact via
          whatever channel you prefer.
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
          Once enabled, users whose email domain matches your verified domains will be
          redirected to your identity provider to sign in. They will no longer be able to use
          magic link, GitHub, or Google via that domain.
          <br />
          <br />
          Users with non-matching emails (e.g. contractors with personal emails) will continue
          to use existing methods.
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
