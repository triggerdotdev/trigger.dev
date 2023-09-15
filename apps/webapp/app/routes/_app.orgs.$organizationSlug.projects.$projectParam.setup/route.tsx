import { Outlet } from "@remix-run/react";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Handle } from "~/utils/handle";
import { trimTrailingSlash } from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: (match) => (
    <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Onboarding" />
  ),
};

export default function Page() {
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
      <Outlet />
    </div>
  );
}
