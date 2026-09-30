import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { env } from "~/env.server";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Input } from "~/components/primitives/Input";
import { PaginationControls } from "~/components/primitives/Pagination";
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
import { SupportAccessRequestDialog } from "~/components/admin/SupportAccessRequestDialog";
import { supportAccessState } from "~/components/admin/supportAccessState";
import { adminGetUsers, redirectWithImpersonation } from "~/models/admin.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { organizationPath } from "~/utils/pathBuilder";
import { createSearchParams } from "~/utils/searchParams";

export const SearchParams = z.object({
  page: z.coerce.number().optional(),
  search: z.string().optional(),
});

export type SearchParams = z.infer<typeof SearchParams>;

export const loader = dashboardLoader(
  { authorization: { requireSuper: true } },
  async ({ user, request }) => {
    const searchParams = createSearchParams(request.url, SearchParams);
    if (!searchParams.success) {
      throw new Error(searchParams.error);
    }
    const result = await adminGetUsers(user.id, searchParams.params.getAll());

    return typedjson({ ...result, impersonationEnabled: env.ADMIN_DASHBOARD_ENABLED });
  }
);

const FormSchema = z.object({ id: z.string(), organizationSlug: z.string() });

export const action = dashboardAction(
  { authorization: { requireSuper: true } },
  async ({ request }) => {
    if (request.method.toLowerCase() !== "post") {
      return new Response("Method not allowed", { status: 405 });
    }

    const payload = Object.fromEntries(await request.formData());
    const { id, organizationSlug } = FormSchema.parse(payload);

    return redirectWithImpersonation(request, {
      userId: id,
      organizationSlug,
      path: organizationPath({ slug: organizationSlug }),
    });
  }
);

export default function AdminDashboardRoute() {
  const { users, filters, page, pageCount, impersonationEnabled } =
    useTypedLoaderData<typeof loader>();

  const [requestOrg, setRequestOrg] = useState<{ id: string; title: string } | null>(null);
  const [requestOpenCount, setRequestOpenCount] = useState(0);

  const openRequestDialog = (org: { id: string; title: string }) => {
    setRequestOrg(org);
    setRequestOpenCount((count) => count + 1);
  };

  return (
    <main
      aria-labelledby="primary-heading"
      className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4 lg:order-last"
    >
      <div className=" space-y-4">
        <Form className="flex items-center gap-2">
          <Input
            placeholder="Search users or orgs"
            variant="medium"
            icon={MagnifyingGlassIcon}
            fullWidth={true}
            name="search"
            defaultValue={filters.search}
            autoFocus
          />
          <Button type="submit" variant="secondary/medium">
            Search
          </Button>
        </Form>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Email</TableHeaderCell>
              <TableHeaderCell>GitHub</TableHeaderCell>
              <TableHeaderCell>id</TableHeaderCell>
              <TableHeaderCell>Created</TableHeaderCell>
              <TableHeaderCell>Admin?</TableHeaderCell>
              <TableHeaderCell>Orgs</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 ? (
              <TableBlankRow colSpan={9}>
                <Paragraph>No users found for search</Paragraph>
              </TableBlankRow>
            ) : (
              users.map((user) => {
                return (
                  <TableRow key={user.id}>
                    <TableCell>
                      <CopyableText value={user.email} />
                    </TableCell>
                    <TableCell>
                      <a
                        href={`https://github.com/${user.displayName}`}
                        target="_blank"
                        className="text-indigo-500 underline"
                        rel="noreferrer"
                      >
                        {user.displayName}
                      </a>
                    </TableCell>
                    <TableCell>
                      <CopyableText value={user.id} />
                    </TableCell>
                    <TableCell>
                      <CopyableText value={user.createdAt.toISOString()} />
                    </TableCell>
                    <TableCell>{user.admin ? "✅" : ""}</TableCell>
                    <TableCell isSticky={true}>
                      <div className="flex flex-col gap-1">
                        {user.orgMemberships.map(({ organization }) => {
                          const state = supportAccessState(organization);
                          return (
                            <div
                              key={organization.slug}
                              className="flex items-center justify-between gap-3"
                            >
                              <LinkButton
                                variant="minimal/small"
                                to={`/admin/orgs?search=${encodeURIComponent(organization.slug)}`}
                              >
                                {organization.title} ({organization.slug})
                                {organization.deletedAt ? " (☠️)" : ""}
                              </LinkButton>
                              {impersonationEnabled &&
                                !organization.deletedAt &&
                                (state === "request" ? (
                                  <Button
                                    variant="danger/small"
                                    onClick={() => openRequestDialog(organization)}
                                  >
                                    Support Access
                                  </Button>
                                ) : (
                                  <Form method="post" action="/admin/impersonate" reloadDocument>
                                    <input type="hidden" name="id" value={user.id} />
                                    <input
                                      type="hidden"
                                      name="organizationSlug"
                                      value={organization.slug}
                                    />
                                    <Button type="submit" variant="tertiary/small">
                                      Support Access
                                    </Button>
                                  </Form>
                                ))}
                            </div>
                          );
                        })}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>

        <PaginationControls currentPage={page} totalPages={pageCount} />
      </div>
      <SupportAccessRequestDialog
        key={`${requestOrg?.id}-${requestOpenCount}`}
        org={requestOrg}
        open={requestOrg !== null}
        onOpenChange={(open) => {
          if (!open) setRequestOrg(null);
        }}
      />
    </main>
  );
}
