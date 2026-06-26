import { Outlet, useSearchParams } from "@remix-run/react";
import { typedjson } from "remix-typedjson";
import { LinkButton } from "~/components/primitives/Buttons";
import { Tabs } from "~/components/primitives/Tabs";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";

export const loader = dashboardLoader({ authorization: { requireSuper: true } }, async ({ user }) =>
  typedjson({ user })
);

export default function Page() {
  const [searchParams] = useSearchParams();
  const search = searchParams.get("search");
  const searchSuffix = search ? `?search=${encodeURIComponent(search)}` : "";

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between p-4">
        <Tabs
          tabs={[
            {
              label: "Users",
              to: `/admin${searchSuffix}`,
            },
            {
              label: "Organizations",
              to: `/admin/orgs${searchSuffix}`,
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
            {
              label: "Data Stores",
              to: "/admin/data-stores",
            },
          ]}
          layoutId={"admin"}
        />
        <LinkButton to="/" variant="tertiary/small" className="mb-4">
          Back to me
        </LinkButton>
      </div>
      {/* min-h-0 lets the page's own scroll container bound itself to the
          space below the tabs instead of overflowing past the viewport. */}
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
