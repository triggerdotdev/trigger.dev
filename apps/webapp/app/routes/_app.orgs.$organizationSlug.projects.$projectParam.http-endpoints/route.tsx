import { Outlet } from "@remix-run/react";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { Handle } from "~/utils/handle";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={match.pathname} title="HTTP endpoints" />,
};

export default function Page() {
  return <Outlet />;
}
