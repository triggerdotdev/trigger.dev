import { Outlet } from "@remix-run/react";

// No PageContainer — the child pages render their own; nesting two collapses the inner one's height.
export default function Page() {
  return <Outlet />;
}
