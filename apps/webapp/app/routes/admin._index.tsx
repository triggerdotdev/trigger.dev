import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { useState } from "react";
import { typedjson, useTypedActionData, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { DeleteUserDialog } from "~/components/admin/DeleteUserDialog";
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
import { useUser } from "~/hooks/useUser";
import { adminGetUsers, redirectWithImpersonation } from "~/models/admin.server";
import { deleteUser as deleteUserOnPlatform } from "~/services/platform.v3.server";
import { requireUser, requireUserId } from "~/services/session.server";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { createSearchParams } from "~/utils/searchParams";

export const SearchParams = z.object({
  page: z.coerce.number().optional(),
  search: z.string().optional(),
});

export type SearchParams = z.infer<typeof SearchParams>;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);

  const searchParams = createSearchParams(request.url, SearchParams);
  if (!searchParams.success) {
    throw new Error(searchParams.error);
  }
  const result = await adminGetUsers(userId, searchParams.params.getAll());

  const url = new URL(request.url);
  const justDeleted = url.searchParams.get("deleted") === "1";

  return typedjson({ ...result, justDeleted });
};

const ImpersonateSchema = z.object({ action: z.literal("impersonate"), id: z.string() });
const DeleteSchema = z.object({ intent: z.literal("delete"), id: z.string() });

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toLowerCase() !== "post") {
    return new Response("Method not allowed", { status: 405 });
  }

  const payload = Object.fromEntries(await request.formData());

  const deleteAttempt = DeleteSchema.safeParse(payload);
  if (deleteAttempt.success) {
    const admin = await requireUser(request);
    if (!admin.admin) {
      return redirect("/");
    }

    const targetId = deleteAttempt.data.id;

    if (targetId === admin.id) {
      return typedjson(
        { error: "You can't delete your own account from the admin UI." },
        { status: 400 }
      );
    }

    const xff = request.headers.get("x-forwarded-for");
    const ipAddress = extractClientIp(xff) ?? undefined;

    try {
      await deleteUserOnPlatform(targetId, {
        adminUserId: admin.id,
        adminEmail: admin.email,
        ipAddress,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete user.";
      return typedjson({ error: message }, { status: 500 });
    }

    return redirect("/admin?deleted=1");
  }

  const impersonateAttempt = ImpersonateSchema.safeParse(payload);
  if (impersonateAttempt.success) {
    return redirectWithImpersonation(request, impersonateAttempt.data.id, "/");
  }

  return typedjson({ error: "Unknown action." }, { status: 400 });
}

export default function AdminDashboardRoute() {
  const currentUser = useUser();
  const { users, filters, page, pageCount, justDeleted } = useTypedLoaderData<typeof loader>();
  const actionData = useTypedActionData<typeof action>();
  const actionError =
    actionData && "error" in actionData && typeof actionData.error === "string"
      ? actionData.error
      : null;

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; email: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const openDeleteDialog = (user: { id: string; email: string }) => {
    setDeleteTarget(user);
    setDeleteOpen(true);
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

        {justDeleted && (
          <div className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2">
            <Paragraph variant="small" className="text-green-500">
              User deleted.
            </Paragraph>
          </div>
        )}

        {actionError && (
          <div className="rounded-md border border-red-600/40 bg-red-600/10 px-3 py-2">
            <Paragraph variant="small" className="text-red-500">
              {actionError}
            </Paragraph>
          </div>
        )}

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
              users.map((user) => {
                const isSelf = user.id === currentUser.id;
                return (
                  <TableRow key={user.id}>
                    <TableCell>
                      <CopyableText value={user.email} />
                    </TableCell>
                    <TableCell>
                      {user.orgMemberships.map((org) => (
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
                      <div className="flex items-center gap-2">
                        <Form method="post" reloadDocument>
                          <input type="hidden" name="id" value={user.id} />
                          <Button
                            type="submit"
                            name="action"
                            value="impersonate"
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
                        {!isSelf && !user.admin && (
                          <Button
                            type="button"
                            variant="danger/small"
                            onClick={() => openDeleteDialog({ id: user.id, email: user.email })}
                          >
                            Delete
                          </Button>
                        )}
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

      <DeleteUserDialog
        user={deleteTarget}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </main>
  );
}
