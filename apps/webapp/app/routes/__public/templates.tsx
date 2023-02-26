import { Outlet } from "@remix-run/react";

export default function TemplatesLayout() {
  return (
    <div className="px-12 py-10">
      <Outlet />
    </div>
  );
}
