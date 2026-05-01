import { CheckIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { useState } from "react";
import {
  type UseDataFunctionReturn,
  typedjson,
  useTypedLoaderData,
} from "remix-typedjson";
import { z } from "zod";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
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
import { cn } from "~/utils/cn";
import { $replica } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { rbac } from "~/services/rbac.server";
import {
  dashboardLoader,
} from "~/services/routeBuilders/dashboardBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

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

async function resolveOrgIdFromSlug(slug: string): Promise<string | null> {
  const org = await $replica.organization.findFirst({
    where: { slug },
    select: { id: true },
  });
  return org?.id ?? null;
}

export const loader = dashboardLoader(
  {
    params: Params,
    context: async (params) => {
      const orgId = await resolveOrgIdFromSlug(params.organizationSlug);
      return orgId ? { organizationId: orgId } : {};
    },
    authorization: { action: "read", resource: { type: "members" } },
  },
  async ({ params }) => {
    const orgId = await resolveOrgIdFromSlug(params.organizationSlug);
    if (!orgId) {
      throw new Response("Not Found", { status: 404 });
    }

    const [roles, assignableRoleIds, allPermissions, systemRoleIds] =
      await Promise.all([
        rbac.allRoles(orgId),
        rbac.getAssignableRoleIds(orgId),
        rbac.allPermissions(orgId),
        rbac.systemRoleIds(),
      ]);

    return typedjson({
      roles,
      assignableRoleIds,
      allPermissions,
      systemRoleIds,
    });
  }
);

type LoaderData = UseDataFunctionReturn<typeof loader>;
type LoaderRole = LoaderData["roles"][number];
type LoaderPermission = LoaderData["allPermissions"][number];
type RolePermission = LoaderRole["permissions"][number];

// Permission name → display group. The wire-format Permission only
// carries `name` and `description`, so this lives client-side.
const PERMISSION_GROUP_BY_NAME: Record<string, string> = {
  "read:runs": "Runs",
  "write:runs": "Runs",
  "read:tags": "Runs",
  "read:batch": "Runs",
  "write:batch": "Runs",
  "read:tasks": "Tasks",
  "write:tasks": "Tasks",
  "trigger:tasks": "Tasks",
  "batchTrigger:tasks": "Tasks",
  "deploy:tasks": "Tasks",
  "read:waitpoints": "Waitpoints",
  "write:waitpoints": "Waitpoints",
  "read:inputStreams": "Realtime",
  "write:inputStreams": "Realtime",
  "read:deployments": "Deployments",
  "read:prompts": "Prompts",
  "write:prompts": "Prompts",
  "update:prompts": "Prompts",
  "read:query": "Query",
  "read:tokens": "Tokens",
  "write:tokens": "Tokens",
  "read:envvars": "Environment",
  "write:envvars": "Environment",
  "read:apiKeys": "Environment",
  "write:apiKeys": "Environment",
  "read:members": "Organisation",
  "manage:members": "Organisation",
  "manage:billing": "Organisation",
};

const GROUP_ORDER = [
  "Runs",
  "Tasks",
  "Waitpoints",
  "Realtime",
  "Deployments",
  "Prompts",
  "Query",
  "Tokens",
  "Environment",
  "Organisation",
  "Other",
] as const;

export default function Page() {
  const { roles, assignableRoleIds, allPermissions, systemRoleIds } =
    useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const plan = useCurrentPlan();
  const planCode = plan?.v3Subscription?.plan?.code;
  const isEnterprise = planCode === "enterprise";

  // Map role-id → role for fast cell lookup. Each role's permissions are
  // already the expanded `effectivePermissions` output (system roles
  // populated server-side; custom roles too) so cells just filter that
  // list by permission name.
  const rolesById = new Map<string, LoaderRole>(roles.map((r) => [r.id, r]));
  const assignable = new Set(assignableRoleIds);

  // Column ordering: Owner / Admin / Developer / Member, then any
  // custom roles in the order rbac.allRoles returned them. systemRoleIds
  // is null when no plugin is installed — there are no system roles to
  // pin; fall through to whatever order rbac.allRoles returns.
  const systemRoleOrder: ReadonlyArray<{ id: string; name: string }> =
    systemRoleIds
      ? [
          { id: systemRoleIds.owner, name: "Owner" },
          { id: systemRoleIds.admin, name: "Admin" },
          { id: systemRoleIds.developer, name: "Developer" },
          { id: systemRoleIds.member, name: "Member" },
        ]
      : [];
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
        {!isEnterprise ? <CreateRoleUpsell /> : null}
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid max-h-full min-h-full grid-rows-[auto_1fr]">
          <div className="border-b border-grid-bright px-4 py-6">
            <Paragraph>
              Roles control what each team member can do in{" "}
              <strong>{organization.title}</strong>. Compare what each role
              grants below; assign a role to a team member from the{" "}
              <a
                className="text-text-link hover:underline"
                href={`/orgs/${organization.slug}/settings/team`}
              >
                Team page
              </a>
              .
            </Paragraph>
          </div>
          <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            {columns.length === 0 ? (
              <EmptyState />
            ) : (
              <Table containerClassName="border-t-0">
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
                            systemRoleIds={systemRoleIds}
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
                        <TableCell
                          colSpan={columns.length + 2}
                          className="bg-charcoal-800"
                        >
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

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 p-8 text-center">
      <Header3>No roles available on this plan.</Header3>
      <Paragraph variant="small" className="text-text-dimmed">
        Upgrade to Pro to unlock RBAC.
      </Paragraph>
    </div>
  );
}

function PlanBadge({
  roleId,
  assignable,
  systemRoleIds,
}: {
  roleId: string;
  assignable: ReadonlySet<string>;
  systemRoleIds: { developer: string; member: string } | null;
}) {
  // Roles the org's plan doesn't permit get a small upgrade-tier hint
  // in the column header. The cell rendering is identical regardless
  // — the comparison value is still useful even on Free/Hobby.
  if (assignable.has(roleId)) return null;
  // System role gating: Owner+Admin always available; Member/Developer
  // only on Pro+; custom roles only on Enterprise.
  if (
    systemRoleIds &&
    (roleId === systemRoleIds.member || roleId === systemRoleIds.developer)
  ) {
    return <Badge variant="extra-small">Pro</Badge>;
  }
  return <Badge variant="extra-small">Enterprise</Badge>;
}

// Render a single (role × permission) cell. Filters the role's
// effectivePermissions list to entries matching this permission name
// and emits an icon + optional condition badge based on the rules.
function RoleCell({
  permissionName,
  rolePermissions,
}: {
  permissionName: string;
  rolePermissions: RolePermission[];
}) {
  const matching = rolePermissions.filter((p) => p.name === permissionName);

  if (matching.length === 0) {
    // No rule matches — the role denies this permission by omission.
    return (
      <span className="text-text-dimmed" aria-label="Not granted">
        <XMarkIcon className="size-4" />
      </span>
    );
  }

  const allowed = matching.filter((p) => !p.inverted);
  const denied = matching.filter((p) => p.inverted);

  // Only inverted rules apply — the role explicitly denies this
  // permission. Render as ✗ in error colour.
  if (allowed.length === 0) {
    return (
      <span className="text-error" aria-label="Denied">
        <XMarkIcon className="size-4" />
      </span>
    );
  }

  // At least one allow rule applies. If there's a conditional cannot
  // rule, replace the ✓ with just the condition label so the user sees
  // the restriction without a misleading tick. Plain unconditional
  // allow keeps the ✓.
  const conditionalDeny = denied.find((p) => p.conditions);
  if (conditionalDeny?.conditions) {
    return (
      <span className="text-xs text-text-dimmed">
        {conditionLabel(conditionalDeny.conditions)}
      </span>
    );
  }
  return (
    <span className="text-success" aria-label="Allowed">
      <CheckIcon className="size-4" />
    </span>
  );
}

// Render a CASL conditions object into a tier badge label. Only
// `envType` is recognised today (the catalogue's only allowed condition);
// extending this requires adding a new branch when ALLOWED_CONDITIONS
// grows.
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
    const group = PERMISSION_GROUP_BY_NAME[permission.name] ?? "Other";
    const list = buckets.get(group) ?? [];
    list.push(permission);
    buckets.set(group, list);
  }
  return GROUP_ORDER.flatMap((group) =>
    buckets.has(group) ? [{ group, permissions: buckets.get(group)! }] : []
  );
}

function CreateRoleUpsell() {
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
            Define your own roles with bespoke permission sets — perfect for
            "Member, but no production deploys" or a vendor/contractor role.
            Available on the Enterprise plan.
          </Paragraph>
          <Paragraph variant="small" className="text-text-dimmed">
            Get in touch and we'll walk you through the Enterprise plan and how
            custom roles fit your team.
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
