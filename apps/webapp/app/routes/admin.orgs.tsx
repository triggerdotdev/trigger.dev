import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { useState } from "react";
import { z } from "zod";
import { FeatureFlagsDialog } from "~/components/admin/FeatureFlagsDialog";
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
import { adminGetOrganizations } from "~/models/admin.server";
import { requireUser, requireUserId } from "~/services/session.server";
import { createSearchParams } from "~/utils/searchParams";

export const SearchParams = z.object({
  page: z.coerce.number().optional(),
  search: z.string().optional(),
});

export type SearchParams = z.infer<typeof SearchParams>;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  if (!user.admin) {
    return redirect("/");
  }

  const searchParams = createSearchParams(request.url, SearchParams);
  if (!searchParams.success) {
    throw new Error(searchParams.error);
  }
  const result = await adminGetOrganizations(user.id, searchParams.params.getAll());

  return typedjson(result);
};

export default function AdminDashboardRoute() {
  const { organizations, filters, page, pageCount } = useTypedLoaderData<typeof loader>();

  const [flagsOrgId, setFlagsOrgId] = useState<string | null>(null);
  const [flagsOpen, setFlagsOpen] = useState(false);
  const flagsOrgTitle = organizations.find((o) => o.id === flagsOrgId)?.title ?? "";

  const openFlagsDialog = (orgId: string) => {
    setFlagsOrgId(orgId);
    setFlagsOpen(true);
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
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Slug</TableHeaderCell>
              <TableHeaderCell>Members</TableHeaderCell>
              <TableHeaderCell>id</TableHeaderCell>
              <TableHeaderCell>Deleted?</TableHeaderCell>
              <TableHeaderCell>Back office</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {organizations.length === 0 ? (
              <TableBlankRow colSpan={7}>
                <Paragraph>No orgs found for search</Paragraph>
              </TableBlankRow>
            ) : (
              organizations.map((org) => {
                return (
                  <TableRow key={org.id}>
                    <TableCell>
                      <CopyableText value={org.title} />
                    </TableCell>
                    <TableCell>
                      <CopyableText value={org.slug} />
                    </TableCell>
                    <TableCell>
                      {org.members.map((member) => (
                        <LinkButton
                          key={member.user.email}
                          variant="minimal/small"
                          to={`/admin?search=${encodeURIComponent(member.user.email)}`}
                        >
                          <CopyableText value={member.user.email} />
                        </LinkButton>
                      ))}
                    </TableCell>
                    <TableCell>
                      <CopyableText value={org.id} />
                    </TableCell>
                    <TableCell>{org.deletedAt ? "☠️" : ""}</TableCell>
                    <TableCell>
                      <LinkButton
                        to={`/admin/back-office/orgs/${org.id}`}
                        variant="tertiary/small"
                      >
                        Open
                      </LinkButton>
                    </TableCell>
                    <TableCell isSticky={true}>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="tertiary/small"
                          onClick={() => openFlagsDialog(org.id)}
                        >
                          Flags
                        </Button>
                        <LinkButton
                          to={`/@/orgs/${org.slug}`}
                          variant="tertiary/small"
                          shortcut={
                            organizations.length === 1
                              ? { modifiers: ["mod"], key: "enter", enabledOnInputElements: true }
                              : undefined
                          }
                        >
                          Impersonate
                        </LinkButton>
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
      <FeatureFlagsDialog
        orgId={flagsOrgId}
        orgTitle={flagsOrgTitle}
        open={flagsOpen}
        onOpenChange={setFlagsOpen}
      />
    </main>
  );
}
