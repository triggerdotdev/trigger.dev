import { ShieldCheckIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { useState } from "react";
import { type UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
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
import { Header2, Header3 } from "~/components/primitives/Headers";
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
    // Read-only page; same gating as the Teams page.
    authorization: { action: "read", resource: { type: "members" } },
  },
  async ({ params }) => {
    const orgId = await resolveOrgIdFromSlug(params.organizationSlug);
    if (!orgId) {
      throw new Response("Not Found", { status: 404 });
    }

    const [roles, assignableRoleIds] = await Promise.all([
      rbac.allRoles(orgId),
      rbac.getAssignableRoleIds(orgId),
    ]);

    return typedjson({ roles, assignableRoleIds });
  }
);

export default function Page() {
  const { roles, assignableRoleIds } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const plan = useCurrentPlan();
  const planCode = plan?.v3Subscription?.plan?.code;
  const isEnterprise = planCode === "enterprise";

  const assignable = new Set(assignableRoleIds);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Roles" />
        {!isEnterprise ? <CreateRoleUpsell /> : null}
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid max-h-full min-h-full grid-rows-[1fr_auto]">
          <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            <div className="mx-auto max-w-3xl px-4 pb-8 pt-20">
              <Paragraph spacing>
                Roles control what each team member can do in{" "}
                <strong>{organization.title}</strong>. Each role bundles a set of
                permissions; assign a role to a team member from the{" "}
                <a
                  className="text-text-link hover:underline"
                  href={`/orgs/${organization.slug}/settings/team`}
                >
                  Team page
                </a>
                .
              </Paragraph>

              {roles.length === 0 ? (
                <EmptyState />
              ) : (
                <div className="mt-6 flex flex-col gap-8">
                  {roles.map((role) => (
                    <RoleCard
                      key={role.id}
                      role={role}
                      isAssignable={assignable.has(role.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function EmptyState() {
  return (
    <div className="mt-6 flex flex-col items-center gap-2 rounded-md border border-dashed border-grid-bright p-8 text-center">
      <ShieldCheckIcon className="size-8 text-text-dimmed" />
      <Header3>No roles available on this plan.</Header3>
      <Paragraph variant="small" className="text-text-dimmed">
        Upgrade to Pro to unlock RBAC and additional system roles.
      </Paragraph>
    </div>
  );
}

type LoaderRole = UseDataFunctionReturn<typeof loader>["roles"][number];
type LoaderPermission = LoaderRole["permissions"][number];

function RoleCard({
  role,
  isAssignable,
}: {
  role: LoaderRole;
  isAssignable: boolean;
}) {
  // Group permissions by their description metadata's `group`. The
  // controller populates `description` from PERMISSION_METADATA at the
  // boundary, but the wire type doesn't carry the group, so we infer
  // groups from the permission name's prefix as a fallback.
  const grouped = groupPermissions(role.permissions);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <Header2>{role.name}</Header2>
        {role.isSystem ? (
          <Badge variant="extra-small">System role</Badge>
        ) : (
          <Badge variant="extra-small">Custom role</Badge>
        )}
        {!isAssignable ? (
          <Badge variant="extra-small">Not on this plan</Badge>
        ) : null}
      </div>
      {role.description ? (
        <Paragraph variant="small" className="text-text-dimmed">
          {role.description}
        </Paragraph>
      ) : null}
      <Table containerClassName="border-t-0">
        <TableHeader>
          <TableRow>
            <TableHeaderCell hiddenLabel>Allowed</TableHeaderCell>
            <TableHeaderCell>Permission</TableHeaderCell>
            <TableHeaderCell>Description</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {role.permissions.length === 0 ? (
            <TableBlankRow colSpan={3}>
              <Paragraph variant="small" className="text-text-dimmed">
                This role has no permissions assigned.
              </Paragraph>
            </TableBlankRow>
          ) : (
            grouped.flatMap(({ group, permissions }) => [
              <TableRow key={`${group}-header`}>
                <TableCell colSpan={3} className="bg-charcoal-800">
                  <Header3 className="text-xs uppercase tracking-wide text-text-dimmed">
                    {group}
                  </Header3>
                </TableCell>
              </TableRow>,
              ...permissions.map((permission, idx) => (
                <TableRow key={`${role.id}-${permission.name}-${idx}`}>
                  <TableCell className="w-8 text-center">
                    {permission.inverted ? (
                      <span className="text-error" aria-label="Denied">
                        ✗
                      </span>
                    ) : (
                      <span className="text-success" aria-label="Allowed">
                        ✓
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <code className="text-xs">{permission.name}</code>
                      {permission.conditions ? (
                        <Badge variant="extra-small">
                          {formatConditions(permission.conditions)}
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
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
    </div>
  );
}

// Permission name-prefix → display group. Lives client-side because
// the wire-format Permission only carries `name` and `description` —
// the RBAC plugin doesn't ship grouping metadata over the wire.
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
  // System-role meta pairs ("manage:all", "read:all", …) — collapse to
  // a single "All" group at the top.
  "manage:all": "All",
  "read:all": "All",
  "write:all": "All",
  "trigger:all": "All",
  "batchTrigger:all": "All",
  "update:all": "All",
  "deploy:all": "All",
};

const GROUP_ORDER = [
  "All",
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
];

// Render a CASL conditions object into a tier badge label. Only one
// condition key is recognised today (envType); extending this requires
// adding a new branch when ALLOWED_CONDITIONS grows.
function formatConditions(conditions: Record<string, unknown>): string {
  if (typeof conditions.envType === "string") {
    const t = conditions.envType.toLowerCase();
    return `${t} only`;
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

// "Create role" upsell shown to non-Enterprise plans. Enterprise plans
// don't see this — the actual create-role UI is a follow-up.
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
