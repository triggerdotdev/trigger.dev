import { Outlet } from "@remix-run/react";
import { Tabs } from "~/components/primitives/Tabs";

export default function Story() {
  return (
    <div className="w-96 p-8">
      <Tabs
        tabs={[
          { label: "My first tab", to: "1" },
          { label: "Second tab", to: "2" },
          { label: "Third tab", to: "3" },
        ]}
        layoutId="my-tabs"
      />
      <Outlet />
    </div>
  );
}
