import { Outlet } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson } from "remix-typedjson";
import { Tabs } from "~/components/primitives/Tabs";
import { requireUser } from "~/services/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  if (!user.admin) {
    return redirect("/");
  }
  return typedjson({});
}

export default function BackOfficeLayout() {
  return (
    <main
      aria-labelledby="primary-heading"
      className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4 lg:order-last"
    >
      <div className="flex items-center pt-2">
        <Tabs
          tabs={[
            {
              label: "Coupon Deals",
              to: "/admin/back-office/coupons",
            },
          ]}
          layoutId="admin-back-office"
        />
      </div>
      <Outlet />
    </main>
  );
}
