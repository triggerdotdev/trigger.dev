import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { Button, LinkButton } from "~/components/primitives/Buttons";
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
import { adminGetOrganizations, setV3Enabled } from "~/models/admin.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { requireUserId } from "~/services/session.server";
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
  const result = await adminGetOrganizations(userId, searchParams.params.getAll());

  return typedjson(result);
};

const FormSchema = z.object({ id: z.string(), v3: z.enum(["enable", "disable"]) });

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toLowerCase() !== "post") {
    return new Response("Method not allowed", { status: 405 });
  }

  const userId = await requireUserId(request);

  const payload = Object.fromEntries(await request.formData());

  const { id, v3 } = FormSchema.parse(payload);

  const result = await setV3Enabled(userId, id, v3 === "enable");

  return redirectWithSuccessMessage("/admin/orgs", request, `v3 ${v3}d for org ${id}`);
}
export default function AdminDashboardRoute() {
  const { organizations, filters, page, pageCount } = useTypedLoaderData<typeof loader>();

  return (
    <main
      aria-labelledby="primary-heading"
      className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4 lg:order-last"
    >
      <div className=" space-y-4">
        <Form className="flex items-center gap-2">
          <Input
            placeholder="Search users or orgs"
            variant="small"
            icon={MagnifyingGlassIcon}
            fullWidth={true}
            name="search"
            defaultValue={filters.search}
          />
          <Button type="submit" variant="tertiary/small">
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
              <TableHeaderCell>v3?</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {organizations.length === 0 ? (
              <TableBlankRow colSpan={9}>
                <Paragraph>No orgs found for search</Paragraph>
              </TableBlankRow>
            ) : (
              organizations.map((org) => {
                return (
                  <TableRow key={org.id}>
                    <TableCell>{org.title}</TableCell>
                    <TableCell>{org.slug}</TableCell>
                    <TableCell>
                      {org.members.map((member) => (
                        <LinkButton
                          key={member.user.email}
                          variant="minimal/small"
                          to={`/admin?search=${encodeURIComponent(member.user.email)}`}
                        >
                          {member.user.email}
                        </LinkButton>
                      ))}
                    </TableCell>
                    <TableCell>{org.id}</TableCell>
                    <TableCell>{org.v3Enabled ? "✅" : ""}</TableCell>
                    <TableCell isSticky={true}>
                      <Form method="post" reloadDocument>
                        <input type="hidden" name="id" value={org.id} />

                        {org.v3Enabled ? (
                          <Button
                            type="submit"
                            name="v3"
                            value="disable"
                            className="mr-2"
                            variant="tertiary/small"
                          >
                            Disable v3
                          </Button>
                        ) : (
                          <Button
                            type="submit"
                            name="v3"
                            value="enable"
                            className="mr-2"
                            variant="tertiary/small"
                          >
                            Enable v3
                          </Button>
                        )}
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
