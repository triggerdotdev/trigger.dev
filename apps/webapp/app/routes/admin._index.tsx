import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Header1 } from "~/components/primitives/Headers";
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
import { useUser } from "~/hooks/useUser";
import { adminGetUsers, redirectWithImpersonation } from "~/models/admin.server";
import { requireUser, requireUserId } from "~/services/session.server";
import { createSearchParams } from "~/utils/searchParams";

export const SearchParams = z.object({
  page: z.coerce.number().optional(),
  search: z.string().optional(),
});

export type SearchParams = z.infer<typeof SearchParams>;

const FormSchema = z.object({ id: z.string() });

async function handleImpersonationRequest(
  request: Request,
  userId: string
): Promise<Response> {
  const user = await requireUser(request);
  if (!user.admin) {
    return redirect("/");
  }
  return redirectWithImpersonation(request, userId, "/");
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  // Check if this is an impersonation request via query parameter (e.g., from Plain customer cards)
  const url = new URL(request.url);
  const impersonateUserId = url.searchParams.get("impersonate");

  if (impersonateUserId) {
    return handleImpersonationRequest(request, impersonateUserId);
  }

  // Normal loader logic for admin dashboard
  const userId = await requireUserId(request);

  const searchParams = createSearchParams(request.url, SearchParams);
  if (!searchParams.success) {
    throw new Error(searchParams.error);
  }
  const result = await adminGetUsers(userId, searchParams.params.getAll());

  return typedjson(result);
};

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toLowerCase() !== "post") {
    return new Response("Method not allowed", { status: 405 });
  }

  const payload = Object.fromEntries(await request.formData());
  const { id } = FormSchema.parse(payload);

  return handleImpersonationRequest(request, id);
}

export default function AdminDashboardRoute() {
  const user = useUser();
  const { users, filters, page, pageCount } = useTypedLoaderData<typeof loader>();

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
              <TableHeaderCell>Orgs</TableHeaderCell>
              <TableHeaderCell>GitHub</TableHeaderCell>
              <TableHeaderCell>id</TableHeaderCell>
              <TableHeaderCell>Created</TableHeaderCell>
              <TableHeaderCell>Admin?</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 ? (
              <TableBlankRow colSpan={9}>
                <Paragraph>No users found for search</Paragraph>
              </TableBlankRow>
            ) : (
              users.map((user: (typeof users)[0]) => {
                return (
                  <TableRow key={user.id}>
                    <TableCell>
                      <CopyableText value={user.email} />
                    </TableCell>
                    <TableCell>
                      {user.orgMemberships.map((org: (typeof user.orgMemberships)[0]) => (
                        <LinkButton
                          key={org.organization.slug}
                          variant="minimal/small"
                          to={`/admin/orgs?search=${encodeURIComponent(org.organization.slug)}`}
                        >
                          {org.organization.title} ({org.organization.slug})
                          {org.organization.deletedAt ? " (☠️)" : ""}
                        </LinkButton>
                      ))}
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
                      <Form method="post" reloadDocument>
                        <input type="hidden" name="id" value={user.id} />
                        <Button
                          type="submit"
                          name="action"
                          value="impersonate"
                          className="mr-2"
                          variant="tertiary/small"
                          shortcut={
                            users.length === 1
                              ? { modifiers: ["mod"], key: "enter", enabledOnInputElements: true }
                              : undefined
                          }
                        >
                          Impersonate
                        </Button>
                      </Form>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>

        <PaginationControls currentPage={page} totalPages={pageCount} />
      </div>
    </main>
  );
}
