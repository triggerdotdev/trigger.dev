import { Outlet } from "@remix-run/react";

export default function TemplatesLayout() {
  return (
    <div className="px-4 py-6 md:px-8 md:py-6 lg:px-12 lg:py-10">
      <Outlet />
    </div>
  );
}
