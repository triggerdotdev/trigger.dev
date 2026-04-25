import { Outlet } from "@remix-run/react";
import { typedjson } from "remix-typedjson";
import { LinkButton } from "~/components/primitives/Buttons";
import { Tabs } from "~/components/primitives/Tabs";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder.server";

export const loader = dashboardLoader(
  { authorization: { requireSuper: true } },
  async ({ user }) => typedjson({ user })
);

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
            {
              label: "LLM Models",
              to: "/admin/llm-models",
            },
            {
              label: "Global Feature Flags",
              to: "/admin/feature-flags",
            },
            {
              label: "Notifications",
              to: "/admin/notifications",
            },
            {
              label: "Back office",
              to: "/admin/back-office",
              end: false,
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
