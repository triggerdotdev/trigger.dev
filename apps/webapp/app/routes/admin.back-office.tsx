import { Outlet } from "@remix-run/react";
import { typedjson } from "remix-typedjson";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";

export const loader = dashboardLoader(
  { authorization: { requireSuper: true } },
  async () => {
    return typedjson({});
  }
);

export default function BackOfficeLayout() {
  return (
    <main
      aria-labelledby="primary-heading"
      className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4 lg:order-last"
    >
      <Outlet />
    </main>
  );
}
