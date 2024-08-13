import { Outlet } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson } from "remix-typedjson";
import { LinkButton } from "~/components/primitives/Buttons";
import { Tabs } from "~/components/primitives/Tabs";
import { requireUser } from "~/services/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  if (!user.admin) {
    return redirect("/");
  }

  return typedjson({ user });
}

export default function Page() {
  return (
    <div className="h-full w-full">
      <div className="flex items-center justify-between p-4">
        <Tabs
          tabs={[
            {
              label: "Users",
              to: "/admin",
            },
            {
              label: "Organizations",
              to: "/admin/orgs",
            },
            {
              label: "Concurrency",
              to: "/admin/concurrency",
            },
          ]}
          layoutId={"admin"}
        />
        <LinkButton to="/" variant="tertiary/small" className="mb-4">
          Back to me
        </LinkButton>
      </div>
      <Outlet />
    </div>
  );
}
