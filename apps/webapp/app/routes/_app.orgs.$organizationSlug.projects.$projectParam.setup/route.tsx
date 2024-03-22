import { Outlet } from "@remix-run/react";

export default function Page() {
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
      <Outlet />
    </div>
  );
}
