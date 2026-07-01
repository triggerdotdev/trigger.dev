import { CheckIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { useState } from "react";
import { type UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Feedback } from "~/components/Feedback";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TextLink } from "~/components/primitives/TextLink";
import { useOrganization } from "~/hooks/useOrganizations";
import { useShowSelfServe } from "~/hooks/useShowSelfServe";
import { resolveOrgIdFromSlug } from "~/models/organization.server";
import { rbac } from "~/services/rbac.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Roles | Trigger.dev`,
    },
  ];
};

const Params = z.object({
  organizationSlug: z.string(),
});

export const loader = dashboardLoader(
  {
    params: Params,
    context: async (params) => {
      const orgId = await resolveOrgIdFromSlug(params.organizationSlug);
      return orgId ? { organizationId: orgId } : {};
    },
    authorization: { action: "read", resource: { type: "members" } },
  },
  async ({ context, user }) => {
    const orgId = context.organizationId;
    if (!orgId) {
      throw new Response("Not Found", { status: 404 });
    }

    const [roles, assignableRoleIds, allPermissions, systemRoles, isUsingPlugin, currentRole] =
      await Promise.all([
        rbac.allRoles(orgId),
        rbac.getAssignableRoleIds(orgId),
        rbac.allPermissions(orgId),
        rbac.systemRoles(orgId),
        // OSS self-host has no RBAC plugin.
        rbac.isUsingPlugin(),
        rbac.getUserRole({ userId: user.id, organizationId: orgId }),
      ]);

    return typedjson({
      roles,
      assignableRoleIds,
      allPermissions,
      systemRoles,
      isUsingPlugin,
      currentRoleName: currentRole?.name ?? null,
    });
  }
);

type LoaderData = UseDataFunctionReturn<typeof loader>;
type LoaderRole = LoaderData["roles"][number];
type LoaderPermission = LoaderData["allPermissions"][number];
type RolePermission = LoaderRole["permissions"][number];

// Ungrouped permissions fall into "Other".
const FALLBACK_GROUP = "Other";

export default function Page() {
  const { roles, assignableRoleIds, allPermissions, systemRoles, isUsingPlugin, currentRoleName } =
    useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const showSelfServe = useShowSelfServe();

  const rolesById = new Map<string, LoaderRole>(roles.map((r) => [r.id, r]));
  const assignable = new Set(assignableRoleIds);

  // System roles first (plugin order), then custom roles.
  const systemRoleOrder = systemRoles ?? [];
  const systemRoleIdSet = new Set(systemRoleOrder.map((r) => r.id));
  const systemColumns = systemRoleOrder.flatMap((meta) => {
    const role = rolesById.get(meta.id);
    return role ? [{ role, fallbackName: meta.name }] : [];
  });
  const customColumns = roles
    .filter((r) => !systemRoleIdSet.has(r.id))
    .map((role) => ({ role, fallbackName: role.name }));
  const columns = [...systemColumns, ...customColumns];

  const grouped = groupPermissions(allPermissions);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Roles" />
        {/* Hide on OSS self-host and managed customers (!showSelfServe). */}
        {isUsingPlugin && showSelfServe ? <RequestCustomRoles /> : null}
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid h-full max-h-full grid-rows-[auto_1fr] overflow-hidden">
          <div className="border-b border-grid-bright px-4 py-6">
            <Paragraph variant="small">
              Roles control what each team member can do in <strong>{organization.title}</strong>.
              Compare what each role grants below; assign a role to a team member from the{" "}
              <TextLink to={`/orgs/${organization.slug}/settings/team`}>Team page</TextLink>.
            </Paragraph>
            {currentRoleName ? (
              <Paragraph variant="small" className="mt-2">
                Your role is <strong className="text-text-bright">{currentRoleName}</strong>.
              </Paragraph>
            ) : null}
          </div>
          <div className="min-h-0 overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            {columns.length === 0 ? (
              <EmptyState isUsingPlugin={isUsingPlugin} showSelfServe={showSelfServe} />
            ) : (
              <Table stickyHeader containerClassName="border-t-0">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Permission</TableHeaderCell>
                    {columns.map(({ role }) => (
                      <TableHeaderCell key={role.id}>
                        <div className="flex items-center gap-1">
                          <span>{role.name}</span>
                          <PlanBadge
                            roleId={role.id}
                            assignable={assignable}
                            systemRoleIdSet={systemRoleIdSet}
                          />
                        </div>
                      </TableHeaderCell>
                    ))}
                    <TableHeaderCell>Description</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grouped.length === 0 ? (
                    <TableBlankRow colSpan={columns.length + 2}>
                      <Paragraph variant="small" className="text-text-dimmed">
                        No permissions to display.
                      </Paragraph>
                    </TableBlankRow>
                  ) : (
                    grouped.flatMap(({ group, permissions }) => [
                      <TableRow key={`${group}-header`}>
                        <TableCell colSpan={columns.length + 2} className="bg-charcoal-800">
                          <Header3 className="text-xs uppercase tracking-wide text-text-dimmed">
                            {group}
                          </Header3>
                        </TableCell>
                      </TableRow>,
                      ...permissions.map((permission) => (
                        <TableRow key={permission.name}>
                          <TableCell>
                            <code className="text-xs">{permission.name}</code>
                          </TableCell>
                          {columns.map(({ role }) => (
                            <TableCell key={role.id}>
                              <RoleCell
                                permissionName={permission.name}
                                rolePermissions={role.permissions}
                              />
                            </TableCell>
                          ))}
                          <TableCell>
                            <Paragraph variant="small">
                              {permission.description || (
                                <span className="text-text-dimmed">—</span>
                              )}
                            </Paragraph>
                          </TableCell>
                        </TableRow>
                      )),
                    ])
                  )}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function EmptyState({
  isUsingPlugin,
  showSelfServe,
}: {
  isUsingPlugin: boolean;
  showSelfServe: boolean;
}) {
  // OSS self-host vs plan-gated empty state.
  if (!isUsingPlugin) {
    return (
      <div className="flex flex-col items-center gap-2 p-8 text-center">
        <Header3>Roles aren't available in this self-hosted deployment.</Header3>
        <Paragraph variant="small" className="text-text-dimmed">
          All members have full access. Role-Based Access Controls are available in Trigger.dev
          Cloud or with an enterprise self-hosted license.
        </Paragraph>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 p-8 text-center">
      <Header3>No roles available on this plan.</Header3>
      <Paragraph variant="small" className="text-text-dimmed">
        {showSelfServe
          ? "Upgrade to Pro to unlock RBAC."
          : "Contact us to discuss RBAC for your organization."}
      </Paragraph>
      {!showSelfServe ? (
        <Feedback
          defaultValue="enterprise"
          button={<Button variant="secondary/small">Contact us</Button>}
        />
      ) : null}
    </div>
  );
}

function PlanBadge({
  roleId,
  assignable,
  systemRoleIdSet,
}: {
  roleId: string;
  assignable: ReadonlySet<string>;
  systemRoleIdSet: ReadonlySet<string>;
}) {
  if (assignable.has(roleId)) return null;
  // Unassignable system roles → Pro; custom roles → Enterprise.
  if (systemRoleIdSet.has(roleId)) {
    return <Badge variant="extra-small">Pro</Badge>;
  }
  return <Badge variant="extra-small">Enterprise</Badge>;
}

function RoleCell({
  permissionName,
  rolePermissions,
}: {
  permissionName: string;
  rolePermissions: RolePermission[];
}) {
  const matching = rolePermissions.filter((p) => p.name === permissionName);

  if (matching.length === 0) {
    return (
      <span className="text-text-dimmed" aria-label="Not granted">
        <XMarkIcon className="size-4" />
      </span>
    );
  }

  const allowed = matching.filter((p) => !p.inverted);
  const denied = matching.filter((p) => p.inverted);

  if (allowed.length === 0) {
    return (
      <span className="text-error" aria-label="Denied">
        <XMarkIcon className="size-4" />
      </span>
    );
  }

  const conditionalDeny = denied.find((p) => p.conditions);
  if (conditionalDeny?.conditions) {
    const allowedEnvTypes = allowedEnvTypesFromDeny(conditionalDeny.conditions);
    if (allowedEnvTypes) {
      // Conditional grant: show the environments the permission is allowed in.
      return (
        <div className="flex flex-col items-start gap-1">
          {allowedEnvTypes.map((type) => (
            <EnvironmentCombo key={type} environment={{ type }} className="text-xs" />
          ))}
        </div>
      );
    }
    // Conditions we can't map to environments fall back to a text label.
    return (
      <span className="text-xs text-text-dimmed">{conditionLabel(conditionalDeny.conditions)}</span>
    );
  }
  return (
    <span className="text-success" aria-label="Allowed">
      <CheckIcon className="size-4" />
    </span>
  );
}

const ENV_TYPES = ["DEVELOPMENT", "STAGING", "PREVIEW", "PRODUCTION"] as const;
type EnvType = (typeof ENV_TYPES)[number];

// A conditional `cannot` rule denies the permission where the resource matches
// its condition, so the permission stays allowed everywhere else. Translate the
// envType condition into the set of environments where it's still allowed, or
// null when we can't interpret it (caller falls back to a text label).
function allowedEnvTypesFromDeny(conditions: Record<string, unknown>): EnvType[] | null {
  const envType = conditions.envType;
  // Equality, e.g. { envType: "PRODUCTION" } → denied in prod, allowed elsewhere.
  if (typeof envType === "string") {
    return ENV_TYPES.includes(envType as EnvType) ? ENV_TYPES.filter((t) => t !== envType) : null;
  }
  // Negation, e.g. { envType: { $ne: "DEVELOPMENT" } } → denied everywhere except
  // DEVELOPMENT, so allowed only in DEVELOPMENT.
  if (envType && typeof envType === "object" && "$ne" in envType) {
    const ne = (envType as { $ne: unknown }).$ne;
    return typeof ne === "string" && ENV_TYPES.includes(ne as EnvType) ? [ne as EnvType] : null;
  }
  return null;
}

// Only `envType` is supported today.
function conditionLabel(conditions: Record<string, unknown>): string {
  if (typeof conditions.envType === "string") {
    if (conditions.envType === "PRODUCTION") return "Non-prod only";
    return `Non-${conditions.envType.toLowerCase()} only`;
  }
  return JSON.stringify(conditions);
}

function groupPermissions(
  permissions: LoaderPermission[]
): { group: string; permissions: LoaderPermission[] }[] {
  const buckets = new Map<string, LoaderPermission[]>();
  for (const permission of permissions) {
    const group = permission.group ?? FALLBACK_GROUP;
    const list = buckets.get(group) ?? [];
    list.push(permission);
    buckets.set(group, list);
  }
  return Array.from(buckets, ([group, permissions]) => ({ group, permissions }));
}

function RequestCustomRoles() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary/small">Create role</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>Custom roles are an Enterprise feature</DialogHeader>
        <div className="flex flex-col gap-3 pt-2">
          <Paragraph>
            Define your own roles with bespoke permission sets — perfect for "Member, but no
            production deploys" or a vendor/contractor role. Available on the Enterprise plan.
          </Paragraph>
          <Paragraph variant="small" className="text-text-dimmed">
            Get in touch and we'll walk you through the Enterprise plan and how custom roles fit
            your team.
          </Paragraph>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary/medium" onClick={() => setOpen(false)}>
            Maybe later
          </Button>
          <Button
            variant="primary/medium"
            onClick={() => {
              window.open("https://trigger.dev/contact", "_blank");
              setOpen(false);
            }}
          >
            Contact us
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
