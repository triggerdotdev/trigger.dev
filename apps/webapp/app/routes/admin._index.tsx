import { Form } from "@remix-run/react";
import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { Button } from "~/components/primitives/Buttons";
import { adminGetUsers } from "~/models/admin.server";
import { commitImpersonationSession, setImpersonationId } from "~/services/impersonation.server";

export async function loader() {
  const users = await adminGetUsers();

  return typedjson({ users });
}

const FormSchema = z.object({ id: z.string() });

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toLowerCase() !== "post") {
    return new Response("Method not allowed", { status: 405 });
  }

  const payload = Object.fromEntries(await request.formData());
  const { id } = FormSchema.parse(payload);

  const session = await setImpersonationId(id, request);

  return redirect("/", {
    headers: { "Set-Cookie": await commitImpersonationSession(session) },
  });
}

const headerClassName = "py-3 px-2 pr-3 text-xs font-semibold leading-tight text-bright text-left";
const cellClassName = "whitespace-nowrap px-2 py-2 text-xs text-bright";

export default function AdminDashboardRoute() {
  const { users } = useTypedLoaderData<typeof loader>();

  return (
    <main
      aria-labelledby="primary-heading"
      className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto p-4 lg:order-last"
    >
      <h1 className="mb-2 text-2xl">Accounts ({users.length})</h1>

      <table className="w-full divide-y divide-border">
        <thead className="sticky -top-4 bg-midnight-800 text-left">
          <tr>
            <th scope="col" className={headerClassName}>
              Email
            </th>
            <th scope="col" className={headerClassName}>
              GitHub username
            </th>
            <th scope="col" className={headerClassName}>
              id
            </th>
            <th scope="col" className={headerClassName}>
              Created At
            </th>
            <th scope="col" className={headerClassName}>
              Admin?
            </th>
            <th scope="col" className={headerClassName}>
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {users.map((user) => {
            return (
              <tr key={user.id} className="w-full px-4 py-2 text-left hover:bg-slate-900">
                <td className={cellClassName}>{user.email}</td>
                <td className={cellClassName}>
                  <a
                    href={`https://github.com/${user.displayName}`}
                    target="_blank"
                    className="text-indigo-500 underline"
                    rel="noreferrer"
                  >
                    {user.displayName}
                  </a>
                </td>
                <td className={cellClassName}>{user.id}</td>
                <td className={cellClassName}>{user.createdAt.toISOString()}</td>
                <td className={cellClassName}>{user.admin ? "✅" : ""}</td>
                <td className={cellClassName}>
                  <Form method="post" reloadDocument>
                    <input type="hidden" name="id" value={user.id} />

                    <Button
                      type="submit"
                      name="action"
                      value="impersonate"
                      className="mr-2"
                      variant="primary/small"
                    >
                      Impersonate
                    </Button>
                  </Form>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
